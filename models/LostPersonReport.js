import mongoose from "mongoose";

const LostPersonReportSchema = new mongoose.Schema(
  {
    reportType: {
      type: String,
      default: "lost",
      immutable: true,
    },
    reportedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lostPersonUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    personName: { type: String, trim: true },
    approxAge: { type: Number },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", "Unknown"],
      default: "Unknown",
    },
    description: { type: String, trim: true },
    lastSeenLocation: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: undefined },
    },
    lastSeenTime: { type: Date },
    photoUrl: { type: String, trim: true },
    photoSource: {
      type: String,
      enum: ["vault_profile", "uploaded_family", "unknown"],
      default: "unknown",
    },
    medicalNotes: { type: String, trim: true },
    status: {
      type: String,
      enum: ["open", "matched", "closed"],
      default: "open",
    },
    matchedFoundReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FoundPersonReport",
      default: null,
    },
  },
  { timestamps: true }
);

LostPersonReportSchema.index({ lastSeenLocation: "2dsphere" });
LostPersonReportSchema.index({ status: 1, createdAt: -1 });

export const LostPersonReport = mongoose.model(
  "LostPersonReport",
  LostPersonReportSchema
);

