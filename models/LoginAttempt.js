import mongoose from "mongoose";

const loginAttemptSchema = new mongoose.Schema(
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
      enum: ["patient", "doctor"],
      index: true,
    },
    status: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      enum: ["pending", "approved", "denied", "consumed", "expired"],
      default: "pending",
      index: true,
    },
    requestedDeviceId: {
      type: String,
      default: "",
      trim: true,
    },
    requestedDeviceInfo: {
      type: String,
      default: "",
      trim: true,
    },
    requestedUserAgent: {
      type: String,
      default: "",
      trim: true,
    },
    requestedIp: {
      type: String,
      default: "",
      trim: true,
    },
    activeSessionId: {
      type: String,
      default: "",
      trim: true,
    },
    activeDeviceId: {
      type: String,
      default: "",
      trim: true,
    },
    respondedAt: {
      type: Date,
      default: null,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "login_attempts",
  }
);

loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
loginAttemptSchema.index(
  { principalId: 1, role: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  }
);

export const LoginAttempt = mongoose.model("LoginAttempt", loginAttemptSchema);
