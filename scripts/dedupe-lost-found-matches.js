/**
 * One-off migration: remove duplicate LostFoundMatch records for the same
 * (lostReportId, foundReportId) pair, then build the unique compound index.
 *
 * Why: a unique index was added on (lostReportId, foundReportId). If the
 * collection already contains duplicate pairs (created before the index /
 * race-safe upsert existed), the index build fails and the collection is left
 * unprotected. Run this once before/at deploy.
 *
 * Keep-priority per pair: confirmed > rejected > highest score > newest.
 *
 * Usage:
 *   node scripts/dedupe-lost-found-matches.js           # apply
 *   node scripts/dedupe-lost-found-matches.js --dry-run # report only
 */
import { pathToFileURL } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { LostFoundMatch } from "../models/LostFoundMatch.js";

dotenv.config();
dotenv.config({ path: "./db.env" });

const DRY_RUN =
  process.argv.includes("--dry-run") || process.argv.includes("-n");

const statusRank = (status) => {
  switch (String(status || "").toLowerCase()) {
    case "confirmed":
      return 3;
    case "rejected":
      return 2;
    default:
      return 1; // suggested / unknown
  }
};

// Higher = keep. Compare status, then score, then recency.
const isBetter = (candidate, current) => {
  const rankDiff = statusRank(candidate.status) - statusRank(current.status);
  if (rankDiff !== 0) return rankDiff > 0;

  const scoreDiff = Number(candidate.score || 0) - Number(current.score || 0);
  if (scoreDiff !== 0) return scoreDiff > 0;

  const candidateTime = new Date(candidate.updatedAt || candidate.createdAt || 0);
  const currentTime = new Date(current.updatedAt || current.createdAt || 0);
  return candidateTime.getTime() > currentTime.getTime();
};

export const pairKey = (doc) =>
  `${String(doc.lostReportId)}::${String(doc.foundReportId)}`;

/**
 * Pure planner: given all match docs, return which _id to keep per pair and
 * which _ids are duplicates to remove. Exported for unit testing.
 */
export const planDedupe = (docs = []) => {
  const keepByPair = new Map();
  for (const doc of docs) {
    const key = pairKey(doc);
    const current = keepByPair.get(key);
    if (!current || isBetter(doc, current)) {
      keepByPair.set(key, doc);
    }
  }
  const keepIds = new Set([...keepByPair.values()].map((d) => String(d._id)));
  const duplicateIds = docs
    .filter((d) => !keepIds.has(String(d._id)))
    .map((d) => d._id);
  return { keepByPair, keepIds, duplicateIds };
};

export { isBetter, statusRank };

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI is required");

  await mongoose.connect(uri, { dbName: "healthvault", family: 4 });
  console.log(`Connected. Mode: ${DRY_RUN ? "DRY-RUN" : "APPLY"}`);

  const all = await LostFoundMatch.find({})
    .select("_id lostReportId foundReportId status score createdAt updatedAt")
    .lean();

  const { keepByPair, duplicateIds } = planDedupe(all);

  console.log(
    `Scanned ${all.length} match records across ${keepByPair.size} unique pairs.`,
  );
  console.log(`Duplicates to remove: ${duplicateIds.length}`);

  if (duplicateIds.length > 0 && !DRY_RUN) {
    const result = await LostFoundMatch.deleteMany({
      _id: { $in: duplicateIds },
    });
    console.log(`Deleted ${result.deletedCount} duplicate records.`);
  }

  if (!DRY_RUN) {
    console.log("Building indexes (syncIndexes)...");
    await LostFoundMatch.syncIndexes();
    console.log("Indexes synced. Unique (lostReportId, foundReportId) enforced.");
  } else {
    console.log("Dry-run: no deletes, no index build performed.");
  }

  await mongoose.disconnect();
  console.log("Done.");
};

// Only auto-run when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  run().catch((error) => {
    console.error("dedupe-lost-found-matches failed:", error);
    process.exitCode = 1;
    mongoose.disconnect().finally(() => process.exit(1));
  });
}
