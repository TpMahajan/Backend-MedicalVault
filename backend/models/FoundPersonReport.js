import mongoose from "mongoose";

const FoundPersonReportSchema = new mongoose.Schema(
  {
    reportType: {
      type: String,
      default: "found",
      immutable: true,
    },
    reportedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    currentLocation: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },
    foundTime: { type: Date, required: true },
    currentHospitalId: {
      type: String,
      default: null,
    },
    approxAge: { type: Number },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", "Unknown"],
      default: "Unknown",
    },
    description: { type: String, trim: true },
    photoUrl: { type: String, trim: true },
    condition: { type: String, trim: true },
    status: {
      type: String,
      enum: ["unmatched", "under_evaluation", "matched"],
      default: "unmatched",
    },
    matchedLostReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LostPersonReport",
      default: null,
    },
  },
  { timestamps: true }
);

FoundPersonReportSchema.index({ currentLocation: "2dsphere" });
FoundPersonReportSchema.index({ status: 1, createdAt: -1 });

export const FoundPersonReport = mongoose.model(
  "FoundPersonReport",
  FoundPersonReportSchema
);

