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
    userRole: {
      type: String,
      enum: ["doctor", "patient", "admin", "superadmin"],
      required: true,
    },
    assistantScope: {
      type: String,
      enum: ["medical", "khoj"],
      default: "medical",
      index: true,
    },
    // `assistantScope` is retained for older clients. New API consumers use
    // this explicit type when resolving an active medical conversation.
    assistantType: {
      type: String,
      enum: ["medical"],
      default: "medical",
      index: true,
    },
    patientId: { type: String }, // optional context for doctor chats
    // A chat must be tied to the selected Family Care profile, not just the
    // authenticated account. `patientId` remains for legacy doctor clients.
    patientProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientProfile",
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "archived", "expired", "cleared"],
      default: "active",
      index: true,
    },
    title: { type: String, default: "", trim: true, maxlength: 160 },
    startedAt: { type: Date, default: Date.now },
    messages: { type: [messageSchema], default: [] },
    context: { type: Object, default: {} }, // resolved persona/language/scope metadata
    lastActivityAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, index: { expires: 0 } }, // 48h TTL, refreshed on every message
  },
  { timestamps: true }
);

aiChatSchema.index({ userId: 1, userRole: 1, patientId: 1, assistantScope: 1 });
aiChatSchema.index({
  userId: 1,
  patientProfileId: 1,
  assistantType: 1,
  status: 1,
  lastActivityAt: -1,
});

export const AIChat = mongoose.model("AIChat", aiChatSchema, "ai_chats");
