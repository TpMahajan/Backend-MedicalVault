import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 20,
      default: 1,
    },
    priceSnapshot: {
      name: { type: String, default: "", trim: true, maxlength: 120 },
      category: { type: String, default: "", trim: true, maxlength: 80 },
      imageUrl: { type: String, default: "", trim: true, maxlength: 1000 },
      unitPrice: { type: Number, min: 0, default: 0 },
    },
  },
  { _id: true }
);

const storeCartSchema = new mongoose.Schema(
  {
    principalId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    role: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      enum: ["patient", "doctor", "admin"],
    },
    items: {
      type: [cartItemSchema],
      default: [],
    },
    totals: {
      itemCount: { type: Number, min: 0, default: 0 },
      subtotal: { type: Number, min: 0, default: 0 },
    },
  },
  {
    timestamps: true,
    collection: "store_carts",
  }
);

storeCartSchema.index({ principalId: 1, role: 1 }, { unique: true });

export const StoreCart = mongoose.model("StoreCart", storeCartSchema);
