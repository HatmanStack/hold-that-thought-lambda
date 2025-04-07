import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { getS3Folders } from './s3_update.js';
import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Function to call Google GenAI OCR API with batched images
 * @param {string[]} imageUrls - Array of image URLs or paths to process
 * @returns {Promise<Object[]>} - The OCR results from Google GenAI
 */
export const callGoogleGenAIOCRBatch = async (files) => {
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-preview-03-25" });
    const folderList = await getS3Folders("hold-that-thought-bucket", "urara");
    const promptTemplate = `
        **Objective:** Process the input (PDF or Image) using OCR and generate a Markdown file string with specific YAML frontmatter, along with the generated title as a separate string.

        **Input:** PDF or Image file containing text.

        **Output Requirements:**

        1.  **Markdown String:** A single string containing the full Markdown content.
            * **YAML Frontmatter:**
                * Must start and end with \`---\`.
                * Must include the following fields:
                    * \`created\`: (String) Date in \`YYYY-MM-DD\` format. Attempt to determine the date from the document's content. If no specific date can be reliably parsed from the content, use the current date: **2025-04-03**.
                    * \`description\`: (String) Generate a concise, 1-2 sentence description summarizing the main topics or purpose of the document content.
                    * \`published\`: (String) Use the literal value \`Unknown\`.
                    * \`summary\`: (String) Generate a concise, 1-2 sentence summary. This can be similar or identical to the \`description\`.
                    * \`tags\`: (YAML List) Extract relevant keywords, names, places, or topics from the document body. Format as a YAML list of strings (each item preceded by \`- \`).
                    * \`title\`: (String) Generate a concise and descriptive title based on the document's content. This title **MUST NOT** be any of the strings included in the exclusion list provided below.
            * **Markdown Body:** The full text content extracted by OCR, appearing immediately after the closing \`---\` of the frontmatter. Preserve paragraph breaks where possible.

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
        7. Seperate the Markdown string and the title string with ||||| as a separator.
        `;
    try {
        const contentParts = []; 
        for (const file of files) {
            // Validate the structure of the file object
            if (!file || typeof file.fileName !== 'string' || typeof file.fileData !== 'string') {
                console.warn("Skipping invalid file object:", file);
                continue;
            }
    
            const fileName = file.fileName;
            const base64Data = file.fileData;
            const extension = path.extname(fileName).toLowerCase();
            let mimeType;

            switch (extension) {
                case '.png':
                    mimeType = 'image/png';
                    break;
                case '.jpg':
                case '.jpeg':
                    mimeType = 'image/jpeg';
                    break;
                case '.pdf':
                    mimeType = 'application/pdf';
                    break;
                    // Add more cases for other file types if needed
                default:
                    console.warn(`Unsupported file type: ${extension}`);
            }

            contentParts.push({
                inlineData: {
                    data: base64Data, // Use the base64 string directly from fileData
                    mimeType: mimeType,
                },
            });
            console.log(`Prepared ${fileName} (${mimeType}) for API call.`);
        }
            contentParts.push(promptTemplate);

        const response = await model.generateContent(contentParts);
        console.log(response.response.text());

        await createSinglePdfFromFiles(files, '/tmp/final_merged_document.pdf')
            .then(savedPath => {
                console.log(`Successfully created PDF at: ${savedPath}`);
                // You can now use the file at savedPath, e.g., upload it to S3
            })
            .catch(error => {
                console.error("Failed to create merged PDF:", error);
            });
        return response.response.text();
    } catch (error) {
        console.error('Error calling Google GenAI OCR:', error.response?.data || error.message);
        throw error;
    }
};


/**
 * Creates a single PDF by merging pages from input files (images or PDFs).
 * Input files are provided as objects with base64 encoded data.
 *
 * @param {Array<object>} files - Array of file objects. Each object should have:
 * - fileName: string (e.g., "image.png", "report.pdf")
 * - fileData: string (Base64 encoded file content)
 * @param {string} outputPdfPath - The full path where the resulting PDF should be saved (e.g., "/tmp/merged_document.pdf").
 * @returns {Promise<string>} - A promise that resolves with the path to the saved PDF file upon success.
 * @throws {Error} - Throws an error if merging or saving fails.
 */
async function createSinglePdfFromFiles(files, outputPdfPath) {
    if (!Array.isArray(files) || files.length === 0) {
        throw new Error("Input 'files' must be a non-empty array.");
    }
    if (typeof outputPdfPath !== 'string' || !outputPdfPath) {
        throw new Error("Invalid 'outputPdfPath' provided.");
    }

    // Create a new PDF document to merge everything into
    const mainPdfDoc = await PDFDocument.create();
    console.log(`Starting merge process for ${files.length} file(s) into ${outputPdfPath}`);

    for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Basic validation of file object structure
        if (!file || typeof file.fileName !== 'string' || typeof file.fileData !== 'string') {
            console.warn(`Skipping invalid file object at index ${i}:`, file);
            continue;
        }

        const fileName = file.fileName;
        const base64Data = file.fileData;
        const extension = path.extname(fileName).toLowerCase();
        console.log(`Processing file ${i + 1}: <span class="math-inline">\{fileName\} \(</span>{extension})`);

        try {
            // Decode base64 data into a buffer
            const fileBuffer = Buffer.from(base64Data, 'base64');

            // Handle based on file type extension
            if (extension === '.png') {
                const embeddedImage = await mainPdfDoc.embedPng(fileBuffer);
                const page = mainPdfDoc.addPage([embeddedImage.width, embeddedImage.height]);
                page.drawImage(embeddedImage, {
                    x: 0, y: 0,
                    width: embeddedImage.width, height: embeddedImage.height,
                });
                console.log(`Embedded ${fileName} onto a new page.`);

            } else if (extension === '.jpg' || extension === '.jpeg') {
                const embeddedImage = await mainPdfDoc.embedJpg(fileBuffer);
                const page = mainPdfDoc.addPage([embeddedImage.width, embeddedImage.height]);
                page.drawImage(embeddedImage, {
                    x: 0, y: 0,
                    width: embeddedImage.width, height: embeddedImage.height,
                });
                console.log(`Embedded ${fileName} onto a new page.`);

            } else if (extension === '.pdf') {
                // Load the source PDF
                const sourcePdfDoc = await PDFDocument.load(fileBuffer);
                const pageIndices = sourcePdfDoc.getPageIndices();
                // Copy pages from source PDF to the main PDF
                const copiedPages = await mainPdfDoc.copyPages(sourcePdfDoc, pageIndices);
                // Add copied pages to the main PDF
                copiedPages.forEach(page => mainPdfDoc.addPage(page));
                console.log(`Copied ${pageIndices.length} page(s) from ${fileName}.`);

            } else {
                console.warn(`Unsupported file type "<span class="math-inline">\{extension\}" for file "</span>{fileName}". Skipping.`);
                continue;
            }
        } catch (error) {
            console.error(`Error processing file "${fileName}":`, error);
            // Decide if you want to stop or continue on error
            // throw new Error(`Failed to process file "${fileName}": ${error.message}`); // Option: Stop on error
            console.warn(`Skipping file "${fileName}" due to processing error.`); // Option: Continue
        }
    } // End of loop

    // Check if any pages were added
    if (mainPdfDoc.getPageCount() === 0) {
        throw new Error("No valid pages could be added to the output PDF.");
    }

    // Serialize the final PDF document to bytes
    console.log("Serializing the final PDF document...");
    const finalPdfBytes = await mainPdfDoc.save();

    // Ensure output directory exists
    const outputDir = path.dirname(outputPdfPath);
    if (!fs.existsSync(outputDir)) {
        console.log(`Creating output directory: ${outputDir}`);
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write the final PDF to the specified file path
    console.log(`Saving final PDF to ${outputPdfPath}`);
    fs.writeFileSync(outputPdfPath, finalPdfBytes);

    console.log("PDF merge and save process completed successfully.");
    return outputPdfPath; // Return the path to the created file
}