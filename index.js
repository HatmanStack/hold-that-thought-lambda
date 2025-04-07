import { updateS3Items, getS3PdfKeys, getPresignedUrlForPdf, getMarkdownContent, startec2 } from './utils/s3_update.js';
import { callGoogleGenAIOCRBatch } from './utils/gemini_api.js';
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
            console.log(`Processing 'update' task for name: ${task.title}`);
            // Validate task content if necessary
            if (!task.title || typeof task.content === 'undefined') {
                 throw new Error("Missing 'name' or 'content' for update task.");
            }

            const items = [
                // Use path.join or ensure consistent separators for S3 keys if needed
                { key: `urara${task.title}+page.svelte.md`, body: task.content }
            ];
            await updateS3Items(BUCKET_NAME, items);
            console.log("Update task completed successfully.");
            return { // Explicit success response
                statusCode: 200,
                body: JSON.stringify({ message: `Successfully updated ${task.title}` }),
            };
        }

        // --- Handle 'create' task ---
        else if (task.type === "create") {
            console.log("Processing 'create' task.");
            if (!Array.isArray(task.files) || task.files.length === 0) {
                 throw new Error("Missing or empty 'files' array for create task.");
            }
            
            const ocrResult = await callGoogleGenAIOCRBatch(task.files)
            const holder = ocrResult.split('|||||');// Assuming this returns { markdown: string, title: string, pdf: Buffer/string }     
            const markdown = holder[0];
            const title = holder[1];
            console.log(`OCR processing complete. Generated Title: ${title}`);
            // console.log('Generated Markdown:', markdown); // Avoid logging potentially large markdown

            // Update the S3 bucket with the markdown content and original PDF
            
            const itemsToUpload = [
                { key: `urara/${title}/+page.svelte.md`, body: markdown },
                { key: `urara/${title}/document.pdf`, body: fs.readFileSync('/tmp/final_merged_document.pdf')} // Assuming pdf is Buffer or string
            ];

            await updateS3Items(BUCKET_NAME, itemsToUpload);
            await startec2();
            console.log("Create task completed successfully.");
             return { // Explicit success response
                statusCode: 200,
                body: JSON.stringify({ message: `Successfully created entry for ${title}` }),
            };
        }
        else if (task.type === "deploy"){
            try{
            await startec2();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: `Successfully initiated start for instance`,
                    
                    // Include S3 operation results if applicable
                }),
            };
    
        } catch (error) {
            console.error(`Error during Lambda execution:`, error);
            // Differentiate between EC2 and S3 errors if necessary
            if (error.name && error.message.includes('instance')) { // Basic check
                 console.error(`Specifically failed starting instance: `, error);
            }
            // Return an error response
            return {
                statusCode: 500,
                body: JSON.stringify({
                    message: "Lambda execution failed",
                    error: error.message,
                    details: error,
                }),
            };
        }
    }

        else if (task.type === "downloadMD") {
            const titleForPrefix = task.title || '';
             if (!titleForPrefix) {
                 throw new Error("Missing 'title' for download task.");
            }
            const targetKey = `urara${titleForPrefix}+page.svelte.md`;
            console.log(`Generating presigned URL for key: ${targetKey}`);

            const downloadUrl = await getMarkdownContent(BUCKET_NAME, targetKey);
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'Download URL generated successfully.',
                    downloadUrl: downloadUrl
                }),
            };
        }
        else if (task.type === "download") {
            const titleForPrefix = task.title || '';
             if (!titleForPrefix) {
                 throw new Error("Missing 'title' for download task.");
            }
            // Construct prefix carefully - ensure trailing slash if listing like a directory
            const prefix = `urara${titleForPrefix}`;
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