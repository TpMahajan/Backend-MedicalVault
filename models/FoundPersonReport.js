import mongoose from "mongoose";

const FoundPersonReportSchema = new mongoose.Schema(
  {
    reportId: { type: String, trim: true, index: true },
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
    foundDateTime: { type: Date },
    currentHospitalId: {
      type: String,
      default: null,
    },
    // Optional name of the found person (finder may know it or match it from
    // an existing missing report).
    personName: { type: String, trim: true },
    foundPersonName: { type: String, trim: true },
    estimatedAge: { type: Number },
    approxAge: { type: Number },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", "Unknown"],
      default: "Unknown",
    },
    description: { type: String, trim: true },
    clothesDescription: { type: String, trim: true },
    clothingDescription: { type: String, trim: true },
    identifyingMarks: { type: String, trim: true },
    photoUrl: { type: String, trim: true },
    photoUrls: [{ type: String, trim: true }],
    condition: { type: String, trim: true },
    currentSafeLocation: { type: String, trim: true },
    foundByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    foundByName: { type: String, trim: true },
    foundByPhone: { type: String, trim: true },
    reportedAt: { type: Date, default: Date.now },
    createdBy: { type: String, trim: true },
    updatedBy: { type: String, trim: true },
    status: {
      type: String,
      enum: [
        "unmatched",
        "under_evaluation",
        "matched",
        "active",
        "reunited",
        "closed",
        "false_report",
      ],
      default: "unmatched",
    },
    matchedLostReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LostPersonReport",
      default: null,
    },
    linkedLostReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LostPersonReport",
      default: null,
    },
    auditTrail: [
      {
        action: { type: String, trim: true, default: "updated" },
        changedBy: { type: String, trim: true, default: "" },
        changedByRole: { type: String, trim: true, default: "" },
        changes: { type: mongoose.Schema.Types.Mixed, default: {} },
        changedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

FoundPersonReportSchema.index({ currentLocation: "2dsphere" });
FoundPersonReportSchema.index({ status: 1, createdAt: -1 });
FoundPersonReportSchema.index({ reportedByUserId: 1, createdAt: -1 });
FoundPersonReportSchema.index({ foundByUserId: 1, createdAt: -1 });
FoundPersonReportSchema.index({ foundTime: -1 });
FoundPersonReportSchema.index({ foundDateTime: -1 });
FoundPersonReportSchema.index({ personName: "text", foundPersonName: "text", description: "text" });

export const FoundPersonReport = mongoose.model(
  "FoundPersonReport",
  FoundPersonReportSchema
);
