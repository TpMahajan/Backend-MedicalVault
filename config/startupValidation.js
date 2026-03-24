const ensure = (condition, message) => {
  if (!condition) {
    throw new Error(`Configuration error: ${message}`);
  }
};

const strongSecret = (value) => String(value || "").trim().length >= 32;
const isValidEncryptionKey = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return true;
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch {
    return false;
  }
};

export const validateStartupConfig = () => {
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";

  ensure(process.env.JWT_SECRET, "JWT_SECRET is required");
  ensure(process.env.MONGO_URI || process.env.MONGODB_URI, "Mongo connection URI is required");
  ensure(
    isValidEncryptionKey(process.env.DATA_ENCRYPTION_KEY),
    "DATA_ENCRYPTION_KEY must be a 32-byte key (64 hex chars or base64)"
  );

  if (isProduction) {
    ensure(strongSecret(process.env.JWT_SECRET), "JWT_SECRET must be at least 32 characters in production");
    if (process.env.JWT_REFRESH_SECRET) {
      ensure(
        strongSecret(process.env.JWT_REFRESH_SECRET),
        "JWT_REFRESH_SECRET must be at least 32 characters in production"
      );
    }
    ensure(process.env.SUPERADMIN_EMAIL, "SUPERADMIN_EMAIL is required in production");
    ensure(
      Number(process.env.BACKUP_RETENTION_DAYS || 14) >= 1,
      "BACKUP_RETENTION_DAYS must be >= 1"
    );
  }
};

