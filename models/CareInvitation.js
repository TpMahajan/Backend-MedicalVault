import mongoose from "mongoose";
import { CARE_PERMISSION_KEYS } from "./CareRelationship.js";

const permissionsDefinition = Object.fromEntries(
  CARE_PERMISSION_KEYS.map((key) => [key, { type: Boolean, default: false }]),
);

const careInvitationSchema = new mongoose.Schema(
  {
    patientProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "PatientProfile", required: true },
    invitedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    invitedEmail: { type: String, default: "", lowercase: true, trim: true, index: true },
    invitedPhoneHash: { type: String, default: "", index: true },
    intendedRelationship: { type: String, required: true, trim: true, maxlength: 60 },
    intendedRole: {
      type: String,
      enum: ["primaryCaregiver", "secondaryCaregiver", "viewer", "emergencyContact"],
      required: true,
    },
    intendedPermissions: permissionsDefinition,
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true, index: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired", "revoked"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true },
);

careInvitationSchema.index({ patientProfileId: 1, status: 1, expiresAt: 1 });

export const CareInvitation = mongoose.model("CareInvitation", careInvitationSchema);
