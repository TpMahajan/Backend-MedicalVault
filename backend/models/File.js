import mongoose from "mongoose";

const fileSchema = new mongoose.Schema(
  {
    // Linkage
    userId: { type: String, required: true, trim: true },   // ✅ Always use userId
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: "DoctorUser" },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment" },

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

    // AWS S3 storage
    s3Key: { type: String, required: true },
    s3Bucket: { type: String, required: true, default: "medical-vault-storage" },
    s3Region: { type: String, required: true, default: "ap-south-1" },
    // ✅ Add url field for frontend compatibility (will be signed URL)
    url: { type: String }, // This will be set to signed URL in responses

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
