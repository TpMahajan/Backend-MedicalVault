import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 2000 },
    price: { type: Number, required: true, min: 0 },
    imageUrl: { type: String, default: "", trim: true },
    category: { type: String, required: true, trim: true, maxlength: 80 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: "superadmin@medicalvault.in" },
    updatedBy: { type: String, default: "superadmin@medicalvault.in" },
  },
  {
    timestamps: true,
    collection: "products",
  }
);

productSchema.index({ category: 1, isActive: 1 });

export const Product = mongoose.model("Product", productSchema);
