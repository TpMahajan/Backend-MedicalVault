import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const encryptedPath = process.argv[2];
if (!encryptedPath) throw new Error("Usage: node scripts/restore-db.js <encrypted-backup-file>");
if (!process.env.BACKUP_ENCRYPTION_KEY) throw new Error("BACKUP_ENCRYPTION_KEY is required");
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) throw new Error("MONGO_URI is required for restore");

const buffer = fs.readFileSync(encryptedPath);
const header = buffer.subarray(0, 5).toString("utf8");
if (header !== "HVBK1") throw new Error("Invalid backup file format");
const iv = buffer.subarray(5, 17);
const tag = buffer.subarray(17, 33);
const data = buffer.subarray(33);

const keyRaw = String(process.env.BACKUP_ENCRYPTION_KEY).trim();
const key = /^[a-fA-F0-9]{64}$/.test(keyRaw)
  ? Buffer.from(keyRaw, "hex")
  : crypto.createHash("sha256").update(keyRaw).digest();
const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);
const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hvb-restore-"));
const tarPath = path.join(tmpRoot, "dump.tar");
const dumpPath = path.join(tmpRoot, "dump");
fs.writeFileSync(tarPath, decrypted);
fs.mkdirSync(dumpPath, { recursive: true });
execSync(`tar -xf "${tarPath}" -C "${dumpPath}"`, { stdio: "inherit" });
execSync(`mongorestore --uri="${mongoUri}" --drop "${dumpPath}"`, { stdio: "inherit" });
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("Restore completed successfully.");

