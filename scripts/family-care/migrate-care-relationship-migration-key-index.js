import mongoose from "mongoose";
import dotenv from "dotenv";
import { CareRelationship } from "../../models/CareRelationship.js";

dotenv.config();
dotenv.config({ path: "./db.env" });

const apply = process.argv.includes("--apply");
const correctName = "migrationKey_unique_when_present";
const expectedPartial = { migrationKey: { $type: "string" } };

const samePartialIndex = (index) => index?.key?.migrationKey === 1 && index?.unique === true && JSON.stringify(index.partialFilterExpression || {}) === JSON.stringify(expectedPartial);

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI, { dbName: "healthvault" });
  const collection = CareRelationship.collection;
  const indexes = await collection.indexes();
  console.info(`[family-care-index] existing indexes: ${indexes.map((index) => index.name).join(", ")}`);
  const duplicates = await collection.aggregate([
    { $match: { migrationKey: { $exists: true, $ne: null } } },
    { $group: { _id: "$migrationKey", count: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  if (duplicates.length) {
    console.error(`[family-care-index] refusing migration: ${duplicates.length} duplicate real migration key group(s) found`);
    process.exitCode = 2;
    return;
  }
  const nullCount = await collection.countDocuments({ migrationKey: null });
  console.info(`[family-care-index] null migrationKey fields: ${nullCount}; mode=${apply ? "apply" : "dry-run"}`);
  if (!apply) return;
  if (nullCount) {
    const cleanup = await collection.updateMany({ migrationKey: null }, { $unset: { migrationKey: "" } });
    console.info(`[family-care-index] unset null migrationKey fields: ${cleanup.modifiedCount}`);
  }
  const current = await collection.indexes();
  const old = current.find((index) => index.name === "migrationKey_1");
  if (old) {
    if (samePartialIndex(old)) console.info("[family-care-index] old-name index is already correct; retaining it");
    else { await collection.dropIndex(old.name); console.info(`[family-care-index] dropped incorrect index: ${old.name}`); }
  }
  const afterDrop = await collection.indexes();
  if (!afterDrop.some(samePartialIndex)) {
    await collection.createIndex({ migrationKey: 1 }, { unique: true, partialFilterExpression: expectedPartial, name: correctName });
    console.info(`[family-care-index] created: ${correctName}`);
  } else console.info("[family-care-index] corrected partial index already exists");
}

main().catch((error) => { console.error(`[family-care-index] failed code=${error?.code || "unknown"}: ${error.message}`); process.exitCode = 1; }).finally(() => mongoose.disconnect());
