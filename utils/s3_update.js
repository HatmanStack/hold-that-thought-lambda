// ----- Correct AWS SDK v3 Imports -----
import {
    S3Client,
    PutObjectCommand,
    ListObjectsV2Command,
    GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// --- Correct AWS SDK v3 Client Initialization ---
const awsRegion = process.env.AWS_REGION || "us-west-2"; // Use env var or default
const s3Client = new S3Client({
    region: awsRegion
    // Credentials are automatically handled by the Lambda execution role environment
});

// --- Utility Functions Refactored for AWS SDK v3 ---

/**
 * Function to update items in an S3 bucket using SDK v3
 * @param {string} bucketName - The name of the S3 bucket
 * @param {Array<{ key: string, body: string | Buffer | Uint8Array | Blob | ReadableStream, contentType?: string }>} items - Array of items to update
 * @returns {Promise<void>}
 */
export const updateS3Items = async (bucketName, items) => {
    try {
        // Create an array of promises for parallel uploads
        const uploadPromises = items.map(item => {
            const params = {
                Bucket: bucketName,
                Key: item.key,
                Body: item.body,
                ContentType: item.contentType // Optional: Add ContentType for better handling (e.g., 'application/pdf', 'text/markdown')
            };
            console.log(`Creating PutObjectCommand for: ${item.key}`);
            const command = new PutObjectCommand(params);
            // Send the command using the v3 client
            return s3Client.send(command);
        });

        // Wait for all uploads to complete
        await Promise.all(uploadPromises);
        console.log(`All ${items.length} items updated successfully.`);

    } catch (error) {
        console.error('Error updating items in S3:', error); // Log the full error for more detail
        throw error; // Re-throw to allow caller to handle
    }
};

/**
 * Function to list common prefixes (simulating folders) using SDK v3
 * @param {string} bucketName
 * @param {string} prefix
 * @returns {Promise<string[]>} - Array of folder prefixes ending with '/'
 */
export const getS3Folders = async (bucketName, prefix = '') => {
    try {
        const params = {
            Bucket: bucketName,
            Prefix: prefix,
            Delimiter: '/', // Key parameter for listing folders
        };
        console.log(`Creating ListObjectsV2Command for folders with prefix: ${prefix}`);
        const command = new ListObjectsV2Command(params);
        const data = await s3Client.send(command); // Use v3 client and send

        // CommonPrefixes contains the "folder" paths
        const folders = data.CommonPrefixes?.map((prefixObj) => prefixObj.Prefix) ?? [];
        console.log('Found Folders:', folders);
        return folders;

    } catch (error) {
        console.error('Error retrieving folders from S3:', error);
        throw error;
    }
};

/**
 * Function to list PDF object keys using SDK v3
 * @param {string} bucketName
 * @param {string} prefix
 * @returns {Promise<string[]>} - Array of PDF object keys
 */
export const getS3PdfKeys = async (bucketName, prefix = '') => {
    try {
        const params = {
            Bucket: bucketName,
            Prefix: prefix
            // No Delimiter here, we want all objects under the prefix
        };
        console.log(`Creating ListObjectsV2Command for PDF keys with prefix: ${prefix}`);
        const command = new ListObjectsV2Command(params);
        const data = await s3Client.send(command); // Use v3 client and send

        // Contents contains the object details
        const pdfKeys = data.Contents?.filter(fileObj => fileObj.Key?.endsWith('.pdf')).map(fileObj => fileObj.Key) ?? [];
        console.log(`Found PDF keys under ${prefix}:`, pdfKeys);
        return pdfKeys;

    } catch (error) {
        console.error('Error listing PDF keys from S3:', error);
        throw error;
    }
};

/**
 * Function to generate a presigned GET URL using SDK v3
 * @param {string} bucketName
 * @param {string} key
 * @param {number} expiresIn - URL validity duration in seconds
 * @returns {Promise<string>} - The presigned URL
 */
export const getPresignedUrlForPdf = async (bucketName, key, expiresIn = 300) => {
    if (!key) {
        throw new Error("S3 key must be provided to generate a presigned URL.");
    }
    try {
        const params = {
            Bucket: bucketName,
            Key: key,
        };
        console.log(`Creating GetObjectCommand for presigned URL: ${key}`);
        const command = new GetObjectCommand(params);

        // Use the imported getSignedUrl function with the v3 client and command
        const url = await getSignedUrl(s3Client, command, { expiresIn });
        console.log(`Generated presigned URL for ${key} (valid for ${expiresIn}s)`);
        return url;

    } catch (error) {
        console.error(`Error generating presigned URL for ${key}:`, error);
        throw error;
    }
};