import s3Client, { BUCKET_NAME, REGION } from "../config/s3.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";

// Generate signed URL for S3 object
export const generateSignedUrl = async (s3Key, s3Bucket, expiresIn = 3600) => {
  try {
    const command = new GetObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
    });
    
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    console.error("Error generating signed URL:", error);
    throw error;
  }
};

// Generate signed URL for preview (inline)
export const generatePreviewUrl = async (s3Key, s3Bucket, mimeType = null, expiresIn = 3600) => {
  try {
    const commandParams = {
      Bucket: s3Bucket,
      Key: s3Key,
      ResponseContentDisposition: 'inline'
    };
    
    // Set ResponseContentType for PDFs to ensure proper rendering
    if (mimeType && mimeType.includes('pdf')) {
      commandParams.ResponseContentType = 'application/pdf';
    }
    
    const command = new GetObjectCommand(commandParams);
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    console.error("Error generating preview URL:", error);
    throw error;
  }
};

// Generate signed URL for download (attachment)
export const generateDownloadUrl = async (s3Key, s3Bucket, expiresIn = 3600) => {
  try {
    const command = new GetObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      ResponseContentDisposition: 'attachment'
    });
    
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    console.error("Error generating download URL:", error);
    throw error;
  }
};
