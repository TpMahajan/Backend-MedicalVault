import mongoose from "mongoose";

const SOSSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    profileId: { type: String },
    name: { type: String },
    age: { type: String },
    mobile: { type: String },
    location: { type: String },
    submittedByRole: { type: String, enum: ["patient", "doctor", "anonymous"], default: "patient" },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

SOSSchema.index({ createdAt: 1 });

export default mongoose.model("SOS", SOSSchema);


