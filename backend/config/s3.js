import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

// Load environment variables
dotenv.config({ path: "./db.env" });

// AWS S3 Configuration
const REGION = process.env.AWS_REGION || "ap-south-1";
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || "medical-vault-storage";

// Create S3 client
const s3Client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export default s3Client;
export { BUCKET_NAME, REGION };
