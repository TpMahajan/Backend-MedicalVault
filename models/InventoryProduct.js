import mongoose from "mongoose";

const inventoryProductSchema = new mongoose.Schema(
  {
    productKey: {
      type: String,
      required: true,
      unique: true,
      enum: ["NFC_BAND", "MEDICAL_KIT"],
      index: true,
      trim: true,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    sku: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 120,
    },
    productId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 120,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    totalStock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    reservedStock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    availableStock: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    reorderLevel: {
      type: Number,
      required: true,
      default: 10,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastRestocked: {
      type: Date,
      default: null,
    },
    lastRestockedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["IN_STOCK", "OUT_OF_STOCK"],
      default: "OUT_OF_STOCK",
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "inventory_products",
  }
);

inventoryProductSchema.pre("validate", function syncInventoryFields(next) {
  if (!this.productName && this.name) this.productName = this.name;
  if (!this.name && this.productName) this.name = this.productName;

  if (!this.lastRestocked && this.lastRestockedAt) {
    this.lastRestocked = this.lastRestockedAt;
  }
  if (!this.lastRestockedAt && this.lastRestocked) {
    this.lastRestockedAt = this.lastRestocked;
  }

  const totalStock = Math.max(0, Math.floor(Number(this.totalStock || 0)));
  const reservedStock = Math.min(
    totalStock,
    Math.max(0, Math.floor(Number(this.reservedStock || 0)))
  );
  const availableStock = Math.max(0, totalStock - reservedStock);

  this.totalStock = totalStock;
  this.reservedStock = reservedStock;
  this.availableStock = availableStock;
  this.status = availableStock > 0 ? "IN_STOCK" : "OUT_OF_STOCK";

  next();
});

export const InventoryProduct = mongoose.model(
  "InventoryProduct",
  inventoryProductSchema
);
