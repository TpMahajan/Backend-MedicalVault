import mongoose from "mongoose";

const inventoryOrderItemSchema = new mongoose.Schema(
  {
    productRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryProduct",
      default: null,
    },
    productKey: {
      type: String,
      required: true,
      enum: ["NFC_BAND", "MEDICAL_KIT"],
    },
    productId: {
      type: String,
      default: "",
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const inventoryOrderSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryProduct",
      default: null,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    orderStatus: {
      type: String,
      enum: ["PENDING", "COMPLETED"],
      default: "PENDING",
      index: true,
    },
    status: {
      type: String,
      default: "Confirmed",
      trim: true,
      index: true,
    },
    paymentMethod: {
      type: String,
      default: "",
      trim: true,
    },
    paymentStatus: {
      type: String,
      default: "",
      trim: true,
    },
    total: {
      type: Number,
      default: 0,
      min: 0,
    },
    source: {
      type: String,
      default: "web_checkout",
      trim: true,
    },
    orderDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
    items: {
      type: [inventoryOrderItemSchema],
      default: [],
    },
    returnProcessedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "inventory_orders",
  }
);

inventoryOrderSchema.index({ status: 1, orderDate: -1 });

inventoryOrderSchema.pre("validate", function syncOrderFields(next) {
  if (Array.isArray(this.items) && this.items.length) {
    const totalQuantity = this.items.reduce(
      (sum, item) => sum + Math.max(0, Number(item.quantity || 0)),
      0
    );

    if (totalQuantity > 0) {
      this.quantity = totalQuantity;
    }

    if (!this.productId && this.items[0]?.productRef) {
      this.productId = this.items[0].productRef;
    }
  }

  const normalizedStatus = String(this.status || "").trim().toLowerCase();
  if (["completed", "delivered"].includes(normalizedStatus)) {
    this.orderStatus = "COMPLETED";
    if (!this.completedAt) this.completedAt = new Date();
  } else if (!this.orderStatus) {
    this.orderStatus = "PENDING";
  }

  next();
});

export const InventoryOrder = mongoose.model("InventoryOrder", inventoryOrderSchema);
