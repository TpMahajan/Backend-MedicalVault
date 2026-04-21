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
    reportForType: {
      type: String,
      enum: ["medicalvault_profile", "family_friend", "unknown"],
      default: "unknown",
    },
    selectedProfileName: { type: String, trim: true },
    clothingDescription: { type: String, trim: true },
    identificationDetails: { type: String, trim: true },
    medicalNotes: { type: String, trim: true },
    reporterName: { type: String, trim: true },
    reporterPhone: { type: String, trim: true },
    alternateContact: { type: String, trim: true },
    reporterEmail: { type: String, trim: true, lowercase: true },
    relationshipToPerson: { type: String, trim: true },
    address: { type: String, trim: true },
    area: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    landmark: { type: String, trim: true },
    lastSeenLocationText: { type: String, trim: true },
    sourceType: {
      type: String,
      enum: ["app", "sos_linked", "unknown"],
      default: "app",
    },
    status: {
      type: String,
      enum: ["open", "under_review", "matched", "found", "resolved", "closed"],
      default: "open",
    },
    assignedAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
    internalNotes: { type: String, trim: true },
    adminRemarks: { type: String, trim: true },
    matchNotes: { type: String, trim: true },
    foundLocation: { type: String, trim: true },
    foundNotes: { type: String, trim: true },
    foundAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    notificationStatus: {
      sent: { type: Boolean, default: false },
      lastSentAt: { type: Date, default: null },
      lastMessage: { type: String, trim: true, default: "" },
      sentByAdminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AdminUser",
        default: null,
      },
    },
    actionHistory: [
      {
        action: { type: String, trim: true, default: "status_updated" },
        status: {
          type: String,
          enum: [
            "open",
            "under_review",
            "matched",
            "found",
            "resolved",
            "closed",
            "notification_sent",
            "match_confirmed",
            "match_rejected",
          ],
          default: "open",
        },
        note: { type: String, trim: true, default: "" },
        location: { type: String, trim: true, default: "" },
        message: { type: String, trim: true, default: "" },
        changedByAdminId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "AdminUser",
          default: null,
        },
        changedByName: { type: String, trim: true, default: "" },
        changedAt: { type: Date, default: Date.now },
      },
    ],
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

