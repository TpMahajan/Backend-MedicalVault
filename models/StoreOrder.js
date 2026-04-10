import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, default: "", trim: true, maxlength: 80 },
    imageUrl: { type: String, default: "", trim: true, maxlength: 1000 },
    quantity: { type: Number, required: true, min: 1, max: 20 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const storeOrderSchema = new mongoose.Schema(
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
      type: [orderItemSchema],
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: "At least one order item is required",
      },
    },
    delivery: {
      fullName: { type: String, required: true, trim: true, maxlength: 120 },
      phone: { type: String, required: true, trim: true, maxlength: 30 },
      addressLine1: { type: String, required: true, trim: true, maxlength: 180 },
      addressLine2: { type: String, default: "", trim: true, maxlength: 180 },
      city: { type: String, required: true, trim: true, maxlength: 80 },
      state: { type: String, required: true, trim: true, maxlength: 80 },
      pincode: { type: String, required: true, trim: true, maxlength: 20 },
      notes: { type: String, default: "", trim: true, maxlength: 600 },
    },
    totals: {
      itemCount: { type: Number, min: 1, required: true },
      subtotal: { type: Number, min: 0, required: true },
    },
    status: {
      type: String,
      enum: ["PLACED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"],
      default: "PLACED",
      uppercase: true,
      trim: true,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "store_orders",
  }
);

storeOrderSchema.index({ principalId: 1, role: 1, createdAt: -1 });

export const StoreOrder = mongoose.model("StoreOrder", storeOrderSchema);
