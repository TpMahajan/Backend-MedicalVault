import mongoose from "mongoose";

const advertisementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    imageUrl: { type: String, required: true, trim: true },
    redirectUrl: { type: String, required: true, trim: true },
    placement: {
      type: String,
      required: true,
      enum: ["APP_DASHBOARD", "WEB_LANDING", "QR_PAGE"],
      uppercase: true,
      trim: true,
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

advertisementSchema.index({ placement: 1, isActive: 1, startDate: 1, endDate: 1 });

export const Advertisement = mongoose.model("Advertisement", advertisementSchema);
