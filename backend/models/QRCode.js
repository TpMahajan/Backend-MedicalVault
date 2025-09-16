import mongoose from "mongoose";

const QRCodeSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["active", "expired", "used"],
      default: "active",
    },
  },
  { timestamps: true }
);

QRCodeSchema.index({ patientId: 1, status: 1 });
QRCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // auto-expire in Mongo

export default mongoose.model("QRCode", QRCodeSchema);
