import mongoose from "mongoose";

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

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 2000 },
    price: { type: Number, required: true, min: 0 },
    imageUrl: { type: String, default: "", trim: true },
    imageKey: { type: String, default: "", trim: true },
    category: { type: String, required: true, trim: true, maxlength: 80 },
    geoScope: {
      type: String,
      enum: ["GLOBAL", "TARGETED"],
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
    collection: "products",
  }
);

productSchema.pre("validate", function normalizeAvailability(next) {
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

productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ geoScope: 1, targetCountries: 1 });
productSchema.index({ geoScope: 1, targetStates: 1 });
productSchema.index({ geoScope: 1, targetRegions: 1 });

export const Product = mongoose.model("Product", productSchema);
