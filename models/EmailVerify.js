import mongoose from "mongoose";

const EmailVerifySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tokenId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
    },
    codeHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    lastSentAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index for automatic expiry cleanup
EmailVerifySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerify = mongoose.model("EmailVerify", EmailVerifySchema);

