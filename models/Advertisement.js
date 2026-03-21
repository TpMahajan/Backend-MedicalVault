import mongoose from "mongoose";

const AD_SURFACES = ["APP_DASHBOARD", "WEB_LANDING", "QR_PAGE"];
const GEO_SCOPES = ["GLOBAL", "TARGETED"];

const normalizeGeoList = (value) => {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(
    raw
      .flatMap((entry) =>
        String(entry || "")
          .split(",")
          .map((part) => part.trim().toUpperCase())
          .filter(Boolean)
      )
  )];
};

const advertisementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    imageUrl: { type: String, default: "", trim: true },
    imageKey: { type: String, default: "", trim: true },
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
    geoScope: {
      type: String,
      enum: GEO_SCOPES,
      default: "GLOBAL",
      uppercase: true,
      trim: true,
    },
    targetCountries: {
      type: [{ type: String, uppercase: true, trim: true }],
      default: [],
    },
    targetStates: {
      type: [{ type: String, uppercase: true, trim: true }],
      default: [],
    },
    targetRegions: {
      type: [{ type: String, uppercase: true, trim: true }],
      default: [],
    },
    isActive: { type: Boolean, default: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    createdBy: {
      type: String,
      default: () =>
        String(process.env.SUPERADMIN_EMAIL || "system")
          .trim()
          .toLowerCase(),
    },
    updatedBy: {
      type: String,
      default: () =>
        String(process.env.SUPERADMIN_EMAIL || "system")
          .trim()
          .toLowerCase(),
    },
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

  this.targetCountries = normalizeGeoList(this.targetCountries);
  this.targetStates = normalizeGeoList(this.targetStates);
  this.targetRegions = normalizeGeoList(this.targetRegions);

  const hasGeoTargets =
    this.targetCountries.length > 0 ||
    this.targetStates.length > 0 ||
    this.targetRegions.length > 0;
  this.geoScope = hasGeoTargets ? "TARGETED" : "GLOBAL";

  next();
});

advertisementSchema.index({ placement: 1, isActive: 1, startDate: 1, endDate: 1 });
advertisementSchema.index({ placements: 1, isActive: 1, startDate: 1, endDate: 1 });
advertisementSchema.index({ geoScope: 1, targetCountries: 1 });
advertisementSchema.index({ geoScope: 1, targetStates: 1 });
advertisementSchema.index({ geoScope: 1, targetRegions: 1 });

export const Advertisement = mongoose.model("Advertisement", advertisementSchema);
