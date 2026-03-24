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
    shortDescription: {
      type: String,
      default: "",
      trim: true,
      maxlength: 400,
    },
    fullDescription: { type: String, default: "", trim: true, maxlength: 12000 },
    description: { type: String, default: "", trim: true, maxlength: 2000 },
    mrp: { type: Number, required: true, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    price: { type: Number, min: 0 },
    imageUrl: { type: String, default: "", trim: true },
    imageKey: { type: String, default: "", trim: true },
    media: {
      thumbnail: { type: String, default: "", trim: true },
      images: { type: [{ type: String, trim: true }], default: [] },
      video: { type: String, default: "", trim: true },
    },
    category: { type: String, required: true, trim: true, maxlength: 80 },
    subCategory: { type: String, default: "", trim: true, maxlength: 80 },
    tags: { type: [{ type: String, trim: true, maxlength: 60 }], default: [] },
    inventory: {
      stock: { type: Number, default: 0, min: 0 },
      availability: {
        type: String,
        enum: ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "PREORDER"],
        default: "IN_STOCK",
      },
    },
    brand: { type: String, default: "", trim: true, maxlength: 120 },
    sku: { type: String, default: "", trim: true, uppercase: true, maxlength: 80 },
    expiryDate: { type: Date, default: null },
    prescriptionRequired: { type: Boolean, default: false },
    customFields: {
      type: [
        {
          key: { type: String, trim: true, maxlength: 100 },
          value: { type: mongoose.Schema.Types.Mixed, default: "" },
        },
      ],
      default: [],
    },
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
  this.tags = [...new Set((this.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))];

  const mrp = Number(this.mrp || 0);
  const sellingPrice = Number(this.sellingPrice || 0);
  this.price = sellingPrice;
  if (mrp > 0 && sellingPrice >= 0) {
    const discountAmount = Math.max(0, mrp - sellingPrice);
    this.discountAmount = Number(discountAmount.toFixed(2));
    this.discountPercent = Number(((discountAmount / mrp) * 100).toFixed(2));
  } else {
    this.discountAmount = 0;
    this.discountPercent = 0;
  }

  if (!this.media?.thumbnail && this.imageUrl) {
    this.media = this.media || {};
    this.media.thumbnail = this.imageUrl;
  }
  if ((!this.media?.images || this.media.images.length === 0) && this.imageUrl) {
    this.media = this.media || {};
    this.media.images = [this.imageUrl];
  }

  const stock = Number(this.inventory?.stock ?? 0);
  if (!this.inventory) this.inventory = {};
  if (stock <= 0) this.inventory.availability = "OUT_OF_STOCK";
  else if (!this.inventory.availability || this.inventory.availability === "OUT_OF_STOCK") {
    this.inventory.availability = "IN_STOCK";
  }

  const hasGeoTargets =
    this.targetCountries.length > 0 ||
    this.targetStates.length > 0 ||
    this.targetRegions.length > 0;
  this.geoScope = hasGeoTargets ? "TARGETED" : "GLOBAL";

  next();
});

productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ category: 1, subCategory: 1, isActive: 1 });
productSchema.index({ tags: 1 });
productSchema.index({ sku: 1 }, { unique: false });
productSchema.index({ "inventory.availability": 1, isActive: 1 });
productSchema.index({ geoScope: 1, targetCountries: 1 });
productSchema.index({ geoScope: 1, targetStates: 1 });
productSchema.index({ geoScope: 1, targetRegions: 1 });

export const Product = mongoose.model("Product", productSchema);
