import mongoose from "mongoose";

const fileSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true }, // user email
    title: { type: String },
    notes: { type: String },
    date: { type: String },
    originalName: String,
    storedName: String,
    mimeType: String,
    size: Number,
    path: String,
    url: String,
    category: { type: String, default: "Other" },
  },
  { timestamps: true }
);

export default mongoose.model("File", fileSchema);
