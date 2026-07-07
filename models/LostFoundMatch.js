import mongoose from "mongoose";

const LostFoundMatchSchema = new mongoose.Schema(
  {
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
    status: {
      type: String,
      enum: ["suggested", "confirmed", "rejected"],
      default: "suggested",
    },
    reviewedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
    reviewedAt: { type: Date, default: null },
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
