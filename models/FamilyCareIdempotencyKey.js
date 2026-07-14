import mongoose from "mongoose";

const familyCareIdempotencyKeySchema = new mongoose.Schema(
  {
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    endpoint: { type: String, required: true, trim: true, maxlength: 160 },
    key: { type: String, required: true, trim: true, maxlength: 128 },
    requestFingerprint: { type: String, required: true, trim: true, maxlength: 128 },
    status: {
      type: String,
      enum: ["in_progress", "completed", "failed"],
      default: "in_progress",
      index: true,
    },
    patientProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientProfile",
      default: null,
    },
    careRelationshipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CareRelationship",
      default: null,
    },
    failureCode: { type: String, default: "", trim: true, maxlength: 80 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "family_care_idempotency_keys" },
);

familyCareIdempotencyKeySchema.index(
  { actorUserId: 1, endpoint: 1, key: 1 },
  { unique: true },
);
familyCareIdempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const FamilyCareIdempotencyKey = mongoose.model(
  "FamilyCareIdempotencyKey",
  familyCareIdempotencyKeySchema,
);
