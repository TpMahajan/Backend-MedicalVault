import mongoose from "mongoose";

const LostPersonReportSchema = new mongoose.Schema(
  {
    reportId: { type: String, trim: true, index: true },
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
    photoUrls: [{ type: String, trim: true }],
    estimatedAge: { type: Number },
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
    lastSeenDateTime: { type: Date },
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
    clothesDescription: { type: String, trim: true },
    identificationDetails: { type: String, trim: true },
    identifyingMarks: { type: String, trim: true },
    medicalNotes: { type: String, trim: true },
    medicalCondition: { type: String, trim: true },
    languageSpoken: { type: String, trim: true },
    guardian: { type: String, trim: true },
    contactPerson: { type: String, trim: true },
    emergencyContactPhone: { type: String, trim: true },
    policeComplaintNumber: { type: String, trim: true },
    reporterName: { type: String, trim: true },
    reporterPhone: { type: String, trim: true },
    reportedByName: { type: String, trim: true },
    reportedByPhone: { type: String, trim: true },
    reportedAt: { type: Date, default: Date.now },
    createdBy: { type: String, trim: true },
    updatedBy: { type: String, trim: true },
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
      enum: [
        "open",
        "active",
        "under_review",
        "matched",
        "found",
        "resolved",
        "closed",
        "false_report",
      ],
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
    auditTrail: [
      {
        action: { type: String, trim: true, default: "updated" },
        changedBy: { type: String, trim: true, default: "" },
        changedByRole: { type: String, trim: true, default: "" },
        changes: { type: mongoose.Schema.Types.Mixed, default: {} },
        changedAt: { type: Date, default: Date.now },
      },
    ],
    matchedFoundReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FoundPersonReport",
      default: null,
    },

    // 🔔 Nearby-alert broadcast tracking (see services/lostFoundBroadcast.js)
    broadcastStatus: {
      type: String,
      enum: ["pending", "processing", "sent", "failed", "skipped"],
      default: "pending",
    },
    broadcastSentAt: { type: Date, default: null },
    broadcastRadiusKm: { type: Number, default: null },
    broadcastRecipientCount: { type: Number, default: 0 },
    broadcastError: { type: String, trim: true, default: "" },
    // Longer-lived, notification-safe image URL (falls back to photoUrl).
    notificationImageUrl: { type: String, trim: true },

    // 🔒 Public contact controls (what a searcher/nearby user may see).
    allowReporterContact: { type: Boolean, default: false },
    publicContactName: { type: String, trim: true },
    publicContactPhone: { type: String, trim: true },
  },
  { timestamps: true }
);

LostPersonReportSchema.index({ lastSeenLocation: "2dsphere" });
LostPersonReportSchema.index({ status: 1, createdAt: -1 });
LostPersonReportSchema.index({ reportedByUserId: 1, createdAt: -1 });
LostPersonReportSchema.index({ lastSeenTime: -1 });
LostPersonReportSchema.index({ lastSeenDateTime: -1 });
LostPersonReportSchema.index({ personName: "text", description: "text" });

export const LostPersonReport = mongoose.model(
  "LostPersonReport",
  LostPersonReportSchema
);
