import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();
dotenv.config({ path: "./db.env" });

// AWS S3 Configuration
const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  process.env.S3_REGION ||
  "ap-south-1";
const BUCKET_NAME =
  process.env.AWS_S3_BUCKET_NAME ||
  process.env.AWS_BUCKET_NAME ||
  process.env.S3_BUCKET_NAME ||
  "medical-vault-storage";

const ACCESS_KEY_ID =
  process.env.AWS_ACCESS_KEY_ID ||
  process.env.AWS_ACCESS_KEY ||
  process.env.S3_ACCESS_KEY_ID ||
  process.env.S3_ACCESS_KEY ||
  "";
const SECRET_ACCESS_KEY =
  process.env.AWS_SECRET_ACCESS_KEY ||
  process.env.AWS_SECRET_KEY ||
  process.env.S3_SECRET_ACCESS_KEY ||
  process.env.S3_SECRET_KEY ||
  "";
const SESSION_TOKEN =
  process.env.AWS_SESSION_TOKEN ||
  process.env.S3_SESSION_TOKEN ||
  "";
const hasExplicitCredentials = !!ACCESS_KEY_ID && !!SECRET_ACCESS_KEY;

// Create S3 client
const s3Config = { region: REGION };

if (hasExplicitCredentials) {
  s3Config.credentials = {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    ...(SESSION_TOKEN ? { sessionToken: SESSION_TOKEN } : {}),
  };
} else {
  console.warn(
    "[s3] AWS credentials not found in env vars (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or aliases); using default AWS credential provider chain."
  );
}

const s3Client = new S3Client(s3Config);

export default s3Client;
export { BUCKET_NAME, REGION };
