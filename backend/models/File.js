import mongoose from "mongoose";

const fileSchema = new mongoose.Schema(
  {
    // Linkage
    userId: { type: String, required: true, trim: true },   // ✅ Always use userId
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: "DoctorUser" },

    // File info
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    notes: { type: String },

    // Categorization (only 4 types)
    type: {
      type: String,
      enum: ["Report", "Prescription", "Bill", "Insurance"],
      required: true,
    },
    category: {
      type: String,
      enum: ["Report", "Prescription", "Bill", "Insurance"],
      default: "Report",
    },

    // File details
    originalName: { type: String },
    mimeType: { type: String },
    fileType: { type: String },
    size: { type: Number },
    fileSize: { type: Number },

    // Cloudinary storage
    cloudinaryUrl: { type: String, required: true },
    cloudinaryPublicId: { type: String, required: true },

    // Dates
    date: { type: String },
    uploadedAt: { type: Date, default: Date.now },

    // Review (optional)
    status: {
      type: String,
      enum: ["pending", "reviewed", "archived"],
      default: "pending",
    },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "DoctorUser" },
  },
  { timestamps: true }
);

// ✅ Store in "files" collection
export const Document = mongoose.model("Document", fileSchema, "files");
