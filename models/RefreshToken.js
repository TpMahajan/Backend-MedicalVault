import mongoose from "mongoose";

const refreshTokenSchema = new mongoose.Schema(
  {
    principalId: {
      type: String,
      required: true,
      index: true,
    },
    role: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      enum: ["patient", "doctor", "admin", "superadmin"],
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    familyId: {
      type: String,
      required: true,
      index: true,
    },
    jti: {
      type: String,
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
      index: true,
    },
    deviceId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    revokedAt: {
      type: Date,
      default: null,
      index: true,
    },
    replacedByTokenHash: {
      type: String,
      default: "",
    },
    revokedReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
    },
    createdByIp: {
      type: String,
      default: "",
    },
    userAgent: {
      type: String,
      default: "",
    },
    deviceInfo: {
      type: String,
      default: "",
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    isCurrentSession: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "refresh_tokens",
  }
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ sessionId: 1 }, { unique: true });

export const RefreshToken = mongoose.model("RefreshToken", refreshTokenSchema);
