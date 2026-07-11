import mongoose from "mongoose";

export const CARE_PERMISSION_KEYS = Object.freeze([
  "profileRead", "profileEdit",
  "documentsView", "documentsUpload", "documentsEdit", "documentsDelete", "documentsShare",
  "medicationsView", "medicationsManage", "dosesConfirm",
  "appointmentsView", "appointmentsManage", "timelineView",
  "emergencyView", "emergencyManage",
  "vaccinationView", "vaccinationManage",
  "insuranceView", "insuranceManage", "insightsView", "caregiverManagement",
]);

const permissionsDefinition = Object.fromEntries(
  CARE_PERMISSION_KEYS.map((key) => [key, { type: Boolean, default: false }]),
);

const careRelationshipSchema = new mongoose.Schema(
  {
    patientProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientProfile",
      required: true,
    },
    caregiverUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    relationship: { type: String, required: true, trim: true, maxlength: 60 },
    role: {
      type: String,
      enum: ["owner", "primaryCaregiver", "secondaryCaregiver", "viewer", "emergencyContact"],
      required: true,
    },
    permissions: permissionsDefinition,
    status: {
      type: String,
      enum: ["invited", "active", "suspended", "revoked"],
      default: "invited",
      index: true,
    },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    invitationId: { type: mongoose.Schema.Types.ObjectId, ref: "CareInvitation", default: null },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    migrationKey: { type: String, default: null, unique: true, sparse: true },
  },
  { timestamps: true },
);

careRelationshipSchema.index({ patientProfileId: 1, caregiverUserId: 1 }, { unique: true });
careRelationshipSchema.index({ caregiverUserId: 1, status: 1 });
careRelationshipSchema.index({ patientProfileId: 1, status: 1 });

export const CareRelationship = mongoose.model("CareRelationship", careRelationshipSchema);
