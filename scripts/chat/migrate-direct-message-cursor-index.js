import mongoose from "mongoose";
import dotenv from "dotenv";
import { DirectMessage } from "../../models/DirectMessage.js";

dotenv.config();
dotenv.config({ path: "./db.env" });

const apply = process.argv.includes("--apply");
const indexName = "doctorId_1_patientId_1__id_-1";

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI, { dbName: "healthvault" });
  const collection = DirectMessage.collection;
  const indexes = await collection.indexes();
  console.info(`[direct-message-cursor-index] existing indexes: ${indexes.map((index) => index.name).join(", ")}`);

  const expectedPartial = { clientMessageId: { $exists: true } };
  const samePartialIndex = (index) =>
    index?.key?.doctorId === 1 &&
    index?.key?.patientId === 1 &&
    index?.key?.senderId === 1 &&
    index?.key?.clientMessageId === 1 &&
    index?.unique === true &&
    JSON.stringify(index.partialFilterExpression || {}) === JSON.stringify(expectedPartial);

  const cursorIndexPresent = indexes.some(
    (index) => index.key?.doctorId === 1 && index.key?.patientId === 1 && index.key?._id === -1
  );
  const existingClientMessageIdIndex = indexes.find(
    (index) => index.name === "uniq_conversation_sender_clientMessageId"
  );
  const clientMessageIdIndexCorrect = existingClientMessageIdIndex
    ? samePartialIndex(existingClientMessageIdIndex)
    : false;

  console.info(
    `[direct-message-cursor-index] cursor index present: ${cursorIndexPresent}; ` +
      `clientMessageId partial-unique index correct: ${clientMessageIdIndexCorrect}; mode=${apply ? "apply" : "dry-run"}`
  );
  if (!apply) return;

  if (!cursorIndexPresent) {
    await collection.createIndex(
      { doctorId: 1, patientId: 1, _id: -1 },
      { background: true, name: indexName }
    );
    console.info(`[direct-message-cursor-index] created: ${indexName}`);
  }

  if (!clientMessageIdIndexCorrect) {
    if (existingClientMessageIdIndex) {
      await collection.dropIndex(existingClientMessageIdIndex.name);
      console.info("[direct-message-cursor-index] dropped incorrect index: uniq_conversation_sender_clientMessageId");
    }
    await collection.createIndex(
      { doctorId: 1, patientId: 1, senderId: 1, clientMessageId: 1 },
      {
        unique: true,
        partialFilterExpression: expectedPartial,
        background: true,
        name: "uniq_conversation_sender_clientMessageId",
      }
    );
    console.info("[direct-message-cursor-index] created: uniq_conversation_sender_clientMessageId (partial)");
  }
}

main()
  .catch((error) => {
    console.error(`[direct-message-cursor-index] failed code=${error?.code || "unknown"}: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
