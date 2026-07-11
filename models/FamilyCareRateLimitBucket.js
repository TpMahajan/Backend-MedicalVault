import mongoose from "mongoose";

const familyCareRateLimitBucketSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 300 },
    count: { type: Number, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "family_care_rate_limit_buckets" },
);

familyCareRateLimitBucketSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

export const FamilyCareRateLimitBucket = mongoose.model(
  "FamilyCareRateLimitBucket",
  familyCareRateLimitBucketSchema,
);
