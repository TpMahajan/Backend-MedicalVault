import s3Client from "../config/s3.js";

// Storage selection policy for user-uploaded files (documents, lost & found
// photos). S3 is always preferred. The public local `/uploads` fallback is a
// development convenience and must never silently receive sensitive images in
// production.
//
// Behavior:
// - S3 credentials resolvable          -> "s3"
// - No S3 + fallback allowed           -> "local"
// - No S3 + fallback disallowed        -> UploadStorageUnavailableError (503)
//
// ALLOW_LOCAL_UPLOAD_FALLBACK:
// - "true"  -> local fallback allowed (any environment)
// - "false" -> local fallback disallowed (any environment)
// - unset   -> allowed only when NODE_ENV !== "production"

export class UploadStorageUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadStorageUnavailableError";
    this.statusCode = 503;
  }
}

const isProductionEnv = () =>
  String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";

export const isLocalUploadFallbackAllowed = () => {
  const flag = String(process.env.ALLOW_LOCAL_UPLOAD_FALLBACK || "")
    .trim()
    .toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return !isProductionEnv();
};

export const hasUsableS3Credentials = async (label = "upload") => {
  try {
    const credentialProvider = s3Client?.config?.credentials;
    if (!credentialProvider) return false;
    const credentials =
      typeof credentialProvider === "function"
        ? await credentialProvider()
        : await credentialProvider;
    return Boolean(credentials?.accessKeyId && credentials?.secretAccessKey);
  } catch (error) {
    const message = String(error?.message || "");
    if (message) {
      console.warn(`[${label}] S3 credentials unavailable: ${message}`);
    }
    return false;
  }
};

export const resolveUploadStorage = async (label = "upload") => {
  if (await hasUsableS3Credentials(label)) {
    return "s3";
  }

  if (isLocalUploadFallbackAllowed()) {
    console.warn(
      `[${label}] S3 unavailable; using local /uploads storage fallback (development mode).`,
    );
    return "local";
  }

  console.error(
    `[${label}] Upload rejected: S3 credentials are missing and the local ` +
      "storage fallback is disabled (production default). Configure AWS S3 " +
      "credentials or explicitly set ALLOW_LOCAL_UPLOAD_FALLBACK=true.",
  );
  throw new UploadStorageUnavailableError(
    "File storage is not configured. Please contact support.",
  );
};
