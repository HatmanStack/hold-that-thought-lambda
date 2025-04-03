import { updateS3Items, getS3PdfKeys, getPresignedUrlForPdf } from './utils/s3_update.js';
//import { processFilesWithOCR } from './utils/gemini_api.js';
import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer'; // Explicitly import Buffer if needed

// Ensure BUCKET_NAME is loaded from environment variables
const BUCKET_NAME = process.env.BUCKET_NAME;
if (!BUCKET_NAME) {
    console.error("Error: BUCKET_NAME environment variable is not set.");
    // Optionally throw an error during initialization if required
    // throw new Error("BUCKET_NAME environment variable is not set.");
}

// Use ES Module export syntax
export const handler = async (event, context) => {
    console.log("Lambda handler started.");
    
    console.log("Received event:", JSON.stringify(event, null, 2));
    // Ensure BUCKET_NAME is available at runtime as well
     if (!BUCKET_NAME) {
         console.error("Runtime Error: BUCKET_NAME environment variable is not set.");
        return {
            statusCode: 500,
            // Add CORS headers if needed
            body: JSON.stringify({ message: 'Server configuration error: Bucket name missing.' }),
        };
    }

    try {
        // Parse the task from the event body
        // Add check if event.body exists and is valid JSON
        const task = event;

        // Validate the received task object
        if (!task || typeof task !== 'object') {
            throw new Error(`Invalid payload received. Expected an object, got: ${typeof task}`);
        }
        if (!task.type) {
             throw new Error("Task object missing 'type' property.");
        }
        console.log("Parsed task:", task);

        // --- Handle 'update' task ---
        if (task.type === "update") {
            console.log(`Processing 'update' task for name: ${task.name}`);
            // Validate task content if necessary
            if (!task.name || typeof task.content === 'undefined') {
                 throw new Error("Missing 'name' or 'content' for update task.");
            }

            const items = [
                // Use path.join or ensure consistent separators for S3 keys if needed
                { key: `source${task.name}+page.svelte.md`, body: task.content }
            ];
            await updateS3Items(BUCKET_NAME, items);
            console.log("Update task completed successfully.");
            return { // Explicit success response
                statusCode: 200,
                body: JSON.stringify({ message: `Successfully updated ${task.name}` }),
            };
        }

        // --- Handle 'create' task ---
        else if (task.type === "create") {
            console.log("Processing 'create' task.");
            if (!Array.isArray(task.files) || task.files.length === 0) {
                 throw new Error("Missing or empty 'files' array for create task.");
            }

            const filePaths = [];
            // Decode base64 content and save files to /tmp
            for (const file of task.files) {
                 if (!file.name || !file.content) {
                     console.warn("Skipping file due to missing name or content:", file);
                     continue; // Skip invalid file entries
                 }
                const filePath = path.join('/tmp', file.name);
                console.log(`Writing file to /tmp: ${filePath}`);
                const fileBuffer = Buffer.from(file.content, 'base64');
                fs.writeFileSync(filePath, fileBuffer);
                filePaths.push(filePath);
            }

            if (filePaths.length === 0) {
                 throw new Error("No valid files found to process for create task.");
            }

            // Process files with OCR and get the markdown and title
            console.log("Processing files with OCR:", filePaths);
            const ocrResult = await processFilesWithOCR(filePaths); // Assuming this returns { markdown: string, title: string, pdf: Buffer/string }

            // Validate OCR result structure
             if (!ocrResult || typeof ocrResult.markdown === 'undefined' || !ocrResult.title || typeof ocrResult.pdf === 'undefined') {
                console.error("Invalid structure returned from processFilesWithOCR:", ocrResult);
                throw new Error("Failed to process files with OCR or invalid result structure.");
            }
            const { markdown, title, pdf } = ocrResult;
            console.log(`OCR processing complete. Generated Title: ${title}`);
            // console.log('Generated Markdown:', markdown); // Avoid logging potentially large markdown

            // Update the S3 bucket with the markdown content and original PDF
            const itemsToUpload = [
                { key: `source/${title}/+page.svelte.md`, body: markdown },
                { key: `source/${title}/document.pdf`, body: pdf } // Assuming pdf is Buffer or string
            ];

            await updateS3Items(BUCKET_NAME, itemsToUpload);
            console.log("Create task completed successfully.");
             return { // Explicit success response
                statusCode: 200,
                body: JSON.stringify({ message: `Successfully created entry for ${title}` }),
            };
        }

        // --- Handle 'download' task ---
        else if (task.type === "download") {
            const titleForPrefix = task.title || '';
             if (!titleForPrefix) {
                 throw new Error("Missing 'title' for download task.");
            }
            // Construct prefix carefully - ensure trailing slash if listing like a directory
            const prefix = `source${titleForPrefix}`;
            console.log(`Processing 'download' task for prefix: ${prefix}`);

            // Step 1: Find the PDF file key(s)
            const pdfKeys = await getS3PdfKeys(BUCKET_NAME, prefix); // This should return ['source/title/document.pdf']
            console.log(`Found PDF keys: ${pdfKeys.join(', ')}`);

            if (!pdfKeys || pdfKeys.length === 0) {
                console.log("No PDF files found for the given prefix.");
                return {
                    statusCode: 404, // Not Found
                    body: JSON.stringify({ message: 'No PDF document found for that title.' }),
                };
            }

            // Step 2: Get a presigned URL for the first found PDF key
            // Assuming you only want the first one for download
            const targetKey = pdfKeys[0];
            console.log(`Generating presigned URL for key: ${targetKey}`);

            // This function needs to be created in s3_update.js (see below)
            const downloadUrl = await getPresignedUrlForPdf(BUCKET_NAME, targetKey);

            // Step 3: Return the presigned URL to the client
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Download URL generated successfully.',
                    downloadUrl: downloadUrl,
                    fileNameSuggestion: path.basename(targetKey) // Suggest original filename
                }),
            };
        }
        // --- Handle unknown task type ---
        else {
             console.warn(`Unknown task type received: ${task.type}`);
             return {
                statusCode: 400, // Bad Request
                body: JSON.stringify({ message: `Unknown task type: ${task.type}` }),
            };
        }

    } catch (error) {
        console.error("Error processing Lambda event:", error);
        // Return a generic error response
        return {
            statusCode: 500, // Internal Server Error
            body: JSON.stringify({
                message: 'An error occurred while processing the request.',
                // Only include error.message in specific cases or dev environments
                // error: error.message // Avoid exposing detailed errors generally
            }),
        };
    }
};