import mongoose from "mongoose";

const LostFoundMatchSchema = new mongoose.Schema(
  {
    matchId: { type: String, trim: true, index: true },
    lostReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LostPersonReport",
      required: true,
    },
    foundReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FoundPersonReport",
      required: true,
    },
    score: { type: Number, required: true },
    reasons: [{ type: String, trim: true }],
    comparedFields: [{ type: String, trim: true }],
    aiSummary: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["suggested", "reviewed", "confirmed", "rejected"],
      default: "suggested",
    },
    reviewedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

LostFoundMatchSchema.index({ status: 1, score: -1 });
// One match record per lost/found pair; concurrent matchers must not duplicate.
LostFoundMatchSchema.index(
  { lostReportId: 1, foundReportId: 1 },
  { unique: true },
);

export const LostFoundMatch = mongoose.model(
  "LostFoundMatch",
  LostFoundMatchSchema,
);
