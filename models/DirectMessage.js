import mongoose from "mongoose";

const directMessageSchema = new mongoose.Schema(
  {
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DoctorUser",
      required: true,
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      required: false,
    },
    senderRole: {
      type: String,
      enum: ["doctor", "patient"],
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    recipientRole: {
      type: String,
      enum: ["doctor", "patient"],
      required: true,
      index: true,
    },
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
    readByRecipient: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

directMessageSchema.index({ doctorId: 1, patientId: 1, createdAt: -1 });
directMessageSchema.index({
  recipientRole: 1,
  recipientId: 1,
  readByRecipient: 1,
  createdAt: -1,
});

export const DirectMessage = mongoose.model(
  "DirectMessage",
  directMessageSchema,
  "direct_messages"
);
