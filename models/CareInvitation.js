import mongoose from "mongoose";
import { CARE_PERMISSION_KEYS } from "./CareRelationship.js";

const permissionsDefinition = Object.fromEntries(
  CARE_PERMISSION_KEYS.map((key) => [key, { type: Boolean, default: false }]),
);

const careInvitationSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["caregiver", "connection", "profile_link"],
      default: "caregiver",
      index: true,
    },
    patientProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "PatientProfile", required: true },
    invitedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Internal account-targeted requests use this reference. Legacy caregiver
    // invitations retain email/phone + a redeemable token.
    invitedUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
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
      enum: ["pending", "accepted", "declined", "expired", "revoked", "cancelled", "merge_review_required"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true },
);

careInvitationSchema.index({ patientProfileId: 1, status: 1, expiresAt: 1 });
careInvitationSchema.index({ invitedUserId: 1, status: 1, kind: 1 });

export const CareInvitation = mongoose.model("CareInvitation", careInvitationSchema);
