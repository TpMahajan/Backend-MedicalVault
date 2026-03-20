import mongoose from "mongoose";

const AD_SURFACES = ["APP_DASHBOARD", "WEB_LANDING", "QR_PAGE"];

const advertisementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    imageUrl: { type: String, required: true, trim: true },
    redirectUrl: { type: String, required: true, trim: true },
    placement: {
      type: String,
      required: true,
      enum: AD_SURFACES,
      uppercase: true,
      trim: true,
    },
    placements: {
      type: [
        {
          type: String,
          enum: AD_SURFACES,
          uppercase: true,
          trim: true,
        },
      ],
      default: undefined,
    },
    isActive: { type: Boolean, default: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    createdBy: { type: String, default: "superadmin@medicalvault.in" },
    updatedBy: { type: String, default: "superadmin@medicalvault.in" },
  },
  {
    timestamps: true,
    collection: "advertisements",
  }
);

advertisementSchema.pre("validate", function handlePlacements(next) {
  const normalized = Array.isArray(this.placements)
    ? [...new Set(
        this.placements
          .map((entry) => String(entry || "").trim().toUpperCase())
          .filter((entry) => AD_SURFACES.includes(entry))
      )]
    : [];

  if (normalized.length > 0) {
    this.placements = normalized;
    if (!this.placement || !AD_SURFACES.includes(String(this.placement).toUpperCase())) {
      this.placement = normalized[0];
    }
  } else if (this.placement) {
    const fallback = String(this.placement).trim().toUpperCase();
    if (AD_SURFACES.includes(fallback)) {
      this.placement = fallback;
      this.placements = [fallback];
    }
  }

  next();
});

advertisementSchema.index({ placement: 1, isActive: 1, startDate: 1, endDate: 1 });
advertisementSchema.index({ placements: 1, isActive: 1, startDate: 1, endDate: 1 });

export const Advertisement = mongoose.model("Advertisement", advertisementSchema);
