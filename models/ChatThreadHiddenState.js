import mongoose from "mongoose";

// "Delete for me" watermark for a doctor<->patient direct-chat thread. The
// same DirectMessage rows are shared by both participants, so deleting a
// thread cannot mutate those rows without affecting the other side; instead,
// each principal's own hide is recorded here as the _id of the most recent
// message that existed at delete time, and thread/message queries exclude
// any message at or before that _id. ObjectIds are monotonically increasing
// and unique, so a message created "at the same instant" as the delete can
// never be misclassified the way a wall-clock timestamp comparison could.
// A message created after the watermark is unaffected, so the thread
// naturally reappears once new activity occurs (matching WhatsApp's
// "delete chat" behavior).
const chatThreadHiddenStateSchema = new mongoose.Schema(
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
    hiddenForRole: {
      type: String,
      enum: ["doctor", "patient"],
      required: true,
    },
    // Null means "hide everything up to and including thread creation" -
    // i.e. the thread had no messages yet when it was deleted.
    hiddenBeforeMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: true },
);

chatThreadHiddenStateSchema.index(
  { doctorId: 1, patientId: 1, hiddenForRole: 1 },
  { unique: true },
);

export const ChatThreadHiddenState = mongoose.model(
  "ChatThreadHiddenState",
  chatThreadHiddenStateSchema,
  "chat_thread_hidden_state",
);
