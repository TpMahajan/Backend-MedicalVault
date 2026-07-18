import mongoose from "mongoose";
import dotenv from "dotenv";
import { Notification } from "../../models/Notification.js";

dotenv.config();
dotenv.config({ path: "./db.env" });

const apply = process.argv.includes("--apply");
const indexName = "recipientId_1_createdAt_-1__id_-1";

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI, { dbName: "healthvault" });
  const collection = Notification.collection;
  const indexes = await collection.indexes();
  console.info(`[notification-cursor-index] existing indexes: ${indexes.map((index) => index.name).join(", ")}`);

  const alreadyPresent = indexes.some(
    (index) => index.key?.recipientId === 1 && index.key?.createdAt === -1 && index.key?._id === -1
  );
  console.info(`[notification-cursor-index] cursor index present: ${alreadyPresent}; mode=${apply ? "apply" : "dry-run"}`);
  if (!apply || alreadyPresent) return;

  await collection.createIndex(
    { recipientId: 1, createdAt: -1, _id: -1 },
    { background: true, name: indexName }
  );
  console.info(`[notification-cursor-index] created: ${indexName}`);
}

main()
  .catch((error) => {
    console.error(`[notification-cursor-index] failed code=${error?.code || "unknown"}: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
