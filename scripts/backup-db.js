import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
const backupRoot = process.env.BACKUP_DIR || path.resolve(process.cwd(), "backups");
const dumpDir = path.join(backupRoot, `dump-${stamp}`);
const encryptedFile = path.join(backupRoot, `dump-${stamp}.enc`);
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 14);

if (!mongoUri) throw new Error("MONGO_URI is required for backup");
if (!process.env.BACKUP_ENCRYPTION_KEY) throw new Error("BACKUP_ENCRYPTION_KEY is required");

fs.mkdirSync(backupRoot, { recursive: true });
execSync(`mongodump --uri="${mongoUri}" --out="${dumpDir}"`, { stdio: "inherit" });

const tarPath = path.join(backupRoot, `dump-${stamp}.tar`);
execSync(`tar -cf "${tarPath}" -C "${dumpDir}" .`, { stdio: "inherit" });

const keyRaw = String(process.env.BACKUP_ENCRYPTION_KEY).trim();
const key = /^[a-fA-F0-9]{64}$/.test(keyRaw)
  ? Buffer.from(keyRaw, "hex")
  : crypto.createHash("sha256").update(keyRaw).digest();
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const plain = fs.readFileSync(tarPath);
const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
const tag = cipher.getAuthTag();
fs.writeFileSync(encryptedFile, Buffer.concat([Buffer.from("HVBK1"), iv, tag, encrypted]));

fs.rmSync(dumpDir, { recursive: true, force: true });
fs.rmSync(tarPath, { force: true });

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
for (const file of fs.readdirSync(backupRoot)) {
  const full = path.join(backupRoot, file);
  const stat = fs.statSync(full);
  if (stat.isFile() && file.endsWith(".enc") && stat.mtimeMs < cutoff) {
    fs.rmSync(full, { force: true });
  }
}

console.log(`Encrypted backup created: ${encryptedFile}`);

