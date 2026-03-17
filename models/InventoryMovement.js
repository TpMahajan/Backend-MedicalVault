import mongoose from "mongoose";

const inventoryMovementSchema = new mongoose.Schema(
  {
    productKey: {
      type: String,
      required: true,
      enum: ["NFC_BAND", "MEDICAL_KIT"],
      index: true,
      trim: true,
    },
    movementType: {
      type: String,
      required: true,
      enum: ["IN", "OUT", "RETURN", "DAMAGED", "ADJUSTMENT"],
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    adjustmentSign: {
      type: Number,
      default: null,
      // null is valid for non-ADJUSTMENT movements; only -1 or 1 when set
      validate: {
        validator: function (v) {
          return v === null || v === undefined || v === -1 || v === 1;
        },
        message: "adjustmentSign must be -1, 1, or null",
      },
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    referenceId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    unitPrice: {
      type: Number,
      default: null,
      min: 0,
    },
    amount: {
      type: Number,
      default: null,
      min: 0,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },
    happenedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    createdBy: {
      adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "AdminUser",
        default: null,
      },
      name: {
        type: String,
        default: "System",
        trim: true,
      },
      source: {
        type: String,
        enum: ["admin", "checkout", "system"],
        default: "system",
      },
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "inventory_movements",
  }
);

inventoryMovementSchema.index({ productKey: 1, happenedAt: -1 });
inventoryMovementSchema.index({ movementType: 1, happenedAt: -1 });

export const InventoryMovement = mongoose.model(
  "InventoryMovement",
  inventoryMovementSchema
);

