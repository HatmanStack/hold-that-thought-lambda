import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { getS3Folders } from './s3_update';      
import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Function to call Google GenAI OCR API with batched images
 * @param {string[]} imageUrls - Array of image URLs or paths to process
 * @returns {Promise<Object[]>} - The OCR results from Google GenAI
 */
export const callGoogleGenAIOCRBatch = async (imageUrls) => {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const folderList = await getS3Folders("hold-that-thought", "sources");
    const promptTemplate = `
                **Objective:** Process the input (PDF or Image) using OCR and generate a Markdown file string with specific YAML frontmatter, along with the generated title as a separate string.

                **Input:** PDF or Image file containing text.

                **Output Requirements:**

                1.  **Markdown String:** A single string containing the full Markdown content.
                    * **YAML Frontmatter:**
                        * Must start and end with `---`.
                        * Must include the following fields:
                            * \`created\`: (String) Date in \`YYYY-MM-DD\` format. Attempt to determine the date from the document's content. If no specific date can be reliably parsed from the content, use the current date: **2025-04-03**.
                            * \`description\`: (String) Generate a concise, 1-2 sentence description summarizing the main topics or purpose of the document content.
                            * \`published\`: (String) Use the literal value \`Unknown\`.
                            * \`summary\`: (String) Generate a concise, 1-2 sentence summary. This can be similar or identical to the \`description\`.
                            * \`tags\`: (YAML List) Extract relevant keywords, names, places, or topics from the document body. Format as a YAML list of strings (each item preceded by \`- \`).
                            * \`title\`: (String) Generate a concise and descriptive title based on the document's content. This title **MUST NOT** be any of the strings included in the exclusion list provided below.
                    * **Markdown Body:** The full text content extracted by OCR, appearing immediately after the closing `---` of the frontmatter. Preserve paragraph breaks where possible.

                2.  **Title String:** The generated \`title\` string, provided as a separate item from the Markdown string.

                **Exclusion List for Title:**

                * ${folderList}

                **Example Frontmatter Structure (for reference only):**

                \`\`\`yaml
                ---
                created: 'YYYY-MM-DD'
                description: Generated description text.
                published: Unknown
                summary: Generated summary text.
                tags:
                - Extracted Tag 1
                - Extracted Tag 2
                - Name Mentioned
                title: Generated Title Text
                ---

                **Instructions:**

                1. Perform OCR on the provided input file.
                2. Analyze the extracted text content.
                3. Generate the YAML frontmatter fields according to the rules specified above, paying close attention to the created date logic and the title generation/exclusion rule.
                4. Construct the full Markdown string including the frontmatter and the OCR'd body text.
                5. Extract the generated title value.
                6. Return only the complete Markdown string and the generated title string as two separate outputs. Do not include any other explanatory text or labels in the final output.
                `;
    try {
        const imageParts = imageUrls.map((filePath) => {
            const mimeType = path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
            return fileToGenerativePart(filePath, mimeType);
        });

        // Make the OCR API call
        const response = await model.generateContent([promptTemplate, ...imageParts]);

        const pdfDoc = await PDFDocument.create();
        for (const imagePath of imageUrls) {
            const imageBytes = fs.readFileSync(imagePath);
            const image = await pdfDoc.embedPng(imageBytes); // Assumes images are PNG; use `embedJpg` for JPGs
            const page = pdfDoc.addPage([image.width, image.height]);
            page.drawImage(image, {
                x: 0,
                y: 0,
                width: image.width,
                height: image.height,
            });
        }
        const pdfBuffer = await pdfDoc.save();

        return { data: response.data, pdfBuffer };
    } catch (error) {
        console.error('Error calling Google GenAI OCR:', error.response?.data || error.message);
        throw error;
    }
};

const fileToGenerativePart = (filePath, mimeType) => {
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    return {
        mimeType,
        name: fileName,
        data: fileContent.toString('base64'),
    };
};

/**
 * Function to process a PDF file and convert its pages into images
 * @param {string} pdfPath - The path to the PDF file
 * @returns {Promise<string[]>} - Array of image paths
 */
const convertPdfToImages = async (pdfPath) => {
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const numPages = pdfDoc.getPageCount();
    const imagePaths = [];

    for (let i = 0; i < numPages; i++) {
        const page = pdfDoc.getPage(i);
        const imagePath = path.join(__dirname, `page-${i + 1}.png`);
        // Placeholder: Add logic to render the page as an image and save it to `imagePath`
        // For example, you can use a library like Puppeteer or an external tool like ImageMagick
        imagePaths.push(imagePath);
    }

    return imagePaths;
};

/**
 * Main function to process input (PDF or images) and batch them for OCR
 * @param {string[]} filePaths - Array of file paths (PDF or images)
 */
export const processFilesWithOCR = async (filePaths) => {
    const imagePaths = [];

    for (const filePath of filePaths) {
        const fileExtension = path.extname(filePath).toLowerCase();

        if (fileExtension === '.pdf') {
            console.log(`Processing PDF file: ${filePath}`);
            const pdfImagePaths = await convertPdfToImages(filePath);
            imagePaths.push(...pdfImagePaths);
        } else if (['.jpg', '.jpeg', '.png'].includes(fileExtension)) {
            console.log(`Processing image file: ${filePath}`);
            imagePaths.push(filePath);
        } else {
            console.error(`Unsupported file type: ${filePath}`);
        }
    }

    if (imagePaths.length === 0) {
        console.error('No valid images to process.');
        return;
    }

    try {
        console.log('Sending batched images to Google GenAI OCR...');
        const ocrResults = await callGoogleGenAIOCRBatch(imagePaths);
        console.log('OCR Results:', ocrResults);
        return ocrResults;
    } catch (error) {
        console.error('Failed to process files with OCR:', error.message);
    }
};

// Example usage
