import crypto from "crypto";

const ENC_PREFIX = "enc:v1";

const getEncryptionKey = () => {
  const raw = String(process.env.DATA_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return Buffer.from(raw, "base64");
};

const keyBuffer = () => {
  const key = getEncryptionKey();
  if (!key || key.length !== 32) return null;
  return key;
};

export const encryptField = (value) => {
  const plain = value == null ? "" : String(value);
  if (!plain) return plain;
  if (plain.startsWith(`${ENC_PREFIX}:`)) return plain;
  const key = keyBuffer();
  if (!key) return plain;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
};

export const decryptField = (value) => {
  const encoded = value == null ? "" : String(value);
  if (!encoded || !encoded.startsWith(`${ENC_PREFIX}:`)) return encoded;
  const key = keyBuffer();
  if (!key) return encoded;
  try {
    const [, ivB64, tagB64, dataB64] = encoded.split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return encoded;
  }
};

