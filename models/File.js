import mongoose from "mongoose";
import { decryptField, encryptField } from "../utils/fieldEncryption.js";

const fileSchema = new mongoose.Schema(
  {
    // Linkage
    userId: { type: String, required: true, trim: true },   // ✅ Always use userId
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: "DoctorUser" },

    // File info
    title: { type: String, required: true, trim: true },
    description: {
      type: String,
      trim: true,
      default: "",
      set: encryptField,
      get: decryptField,
    },
    notes: { type: String, set: encryptField, get: decryptField },

    // Categorization (only 4 types)
    type: {
      type: String,
      enum: ["Report", "Prescription", "Bill", "Insurance"],
      required: true,
    },
    category: {
      type: String,
      enum: ["Report", "Prescription", "Bill", "Insurance"],
      default: "Report",
    },

    // File details
    originalName: { type: String },
    mimeType: { type: String },
    fileType: { type: String },
    size: { type: Number },
    fileSize: { type: Number },

    // AWS S3 storage
    s3Key: { type: String, required: true },
    s3Bucket: { type: String, required: true, default: "medical-vault-storage" },
    s3Region: { type: String, required: true, default: "ap-south-1" },
    // ✅ Add url field for frontend compatibility (will be signed URL)
    url: { type: String }, // This will be set to signed URL in responses

    // Medical document verification
    medicalVerified: { type: Boolean, default: false },
    medicalVerification: {
      status: {
        type: String,
        enum: ["verified", "accepted", "pending", "rejected"],
        default: "pending",
      },
      label: {
        type: String,
        enum: ["MEDICAL", "NON_MEDICAL", "UNKNOWN"],
        default: "UNKNOWN",
      },
      method: {
        type: String,
        enum: ["keyword", "ai", "metadata", "inconclusive", "security"],
        default: "inconclusive",
      },
      reason: { type: String, default: "" },
      confidence: {
        type: String,
        enum: ["high", "medium", "low", "unknown"],
        default: "unknown",
      },
      checkedAt: { type: Date },
      keywordHits: { type: Number, default: 0 },
      matchedKeywords: [{ type: String }],
    },

    // Dates
    date: { type: String },
    uploadedAt: { type: Date, default: Date.now },

    // Review (optional)
    status: {
      type: String,
      enum: ["pending", "reviewed", "archived"],
      default: "pending",
    },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "DoctorUser" },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

// ✅ Store in "files" collection
export const Document = mongoose.model("Document", fileSchema, "files");
