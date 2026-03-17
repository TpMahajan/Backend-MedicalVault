import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant", "system"], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    metadata: { type: Object },
  },
  { _id: false }
);

const aiChatSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true }, // doctorId or patient userId
    userRole: { type: String, enum: ["doctor", "patient"], required: true },
    patientId: { type: String }, // optional context for doctor chats
    messages: { type: [messageSchema], default: [] },
    lastActivityAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true }, // TTL cutoff
  },
  { timestamps: true }
);

// TTL index to auto-delete after expiresAt passes
aiChatSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
aiChatSchema.index({ userId: 1, userRole: 1, patientId: 1 });

export const AIChat = mongoose.model("AIChat", aiChatSchema, "ai_chats");


