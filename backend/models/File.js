import mongoose from "mongoose";

const documentSchema = new mongoose.Schema(
  {
    // Patient/User linkage
    patientId: { type: String, trim: true }, // can be email or patientId
    userId: { type: String, trim: true },    // backward compatibility (old File.js)

    // Doctor linkage
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: "DoctorUser" },

    // File info
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" }, // replaces notes
    notes: { type: String }, // backward compatibility

    // Categorization
    type: {
      type: String,
      enum: ["Lab Report", "Imaging", "Prescription", "Bill", "Insurance", "Other"],
      default: "Other",
    },
    category: { type: String, default: "Other" },

    // Original file details
    originalName: { type: String },
    storedName: { type: String }, // from old File.js
    mimeType: { type: String },
    fileType: { type: String }, // alias for mimeType
    size: { type: Number },
    fileSize: { type: Number }, // alias for size

    // Storage & access
    path: { type: String }, // old local path
    url: { type: String }, // old URL
    cloudinaryUrl: { type: String }, // new uploads
    cloudinaryPublicId: { type: String },
    resourceType: { type: String, default: "auto" },

    // Dates
    date: { type: String }, // custom date (string)
    uploadedAt: { type: Date, default: Date.now },

    // Review workflow (for doctors)
    status: { type: String, enum: ["pending", "reviewed", "archived"], default: "pending" },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "DoctorUser" },
  },
  { timestamps: true }
);

// Keep reviewedAt updated when status changes
documentSchema.pre("save", function (next) {
  if (this.isModified("status") && this.status === "reviewed" && !this.reviewedAt) {
    this.reviewedAt = new Date();
  }
  next();
});

export const Document = mongoose.model("Document", documentSchema, "documents");
