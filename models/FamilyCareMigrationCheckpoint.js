import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    migration: { type: String, required: true, unique: true },
    lastUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    processed: { type: Number, default: 0 },
    updatedRecords: { type: Number, default: 0 },
    status: { type: String, enum: ["running", "complete", "failed"], default: "running" },
    lastError: { type: String, default: "", maxlength: 500 },
  },
  { timestamps: true, collection: "family_care_migration_checkpoints" },
);

export const FamilyCareMigrationCheckpoint = mongoose.model("FamilyCareMigrationCheckpoint", schema);
