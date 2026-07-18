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
    clientMessageId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
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
    // "Delete for me" on a single message (as opposed to the whole thread,
    // which uses ChatThreadHiddenState's watermark). Kept as a short array of
    // the two possible participant ids rather than a growing per-message
    // field — a direct-chat message only ever has two possible viewers, so
    // this can never become unbounded the way it would on a group thread.
    hiddenForUsers: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },
    // "Delete for everyone": the message is kept as a tombstone (audit trail,
    // correct positioning for future pagination) but its content must never
    // be returned by a normal read path once this is set.
    isDeletedForEveryone: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedForEveryoneAt: {
      type: Date,
      default: null,
    },
    deletedForEveryoneBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
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
// Reverse-cursor pagination (newest page first, then older on scroll-up)
// sorts by _id since ObjectIds are monotonically increasing and unique,
// avoiding any tie-breaking issues createdAt alone could have for messages
// created in the same millisecond.
directMessageSchema.index({ doctorId: 1, patientId: 1, _id: -1 });
directMessageSchema.index({
  recipientRole: 1,
  recipientId: 1,
  readByRecipient: 1,
  createdAt: -1,
});
// Idempotency: a retried send from the same sender with the same
// client-generated ID must resolve to the original message, never a
// duplicate row. Scoped by conversation (doctorId+patientId) rather than a
// separate conversationId since none exists on this flat model.
//
// Partial, not a plain unique index: `clientMessageId` is `required` in this
// schema for new documents, but legacy rows created before the field existed
// have no clientMessageId at all. An unconditional unique index treats every
// one of those "missing" values as colliding with each other (MongoDB does
// not distinguish "absent" from "null" for uniqueness purposes without a
// partialFilterExpression), which made index creation itself fail against
// production data. Scoping the constraint to "clientMessageId exists" is the
// same fix pattern used for CareRelationship.migrationKey.
directMessageSchema.index(
  { doctorId: 1, patientId: 1, senderId: 1, clientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientMessageId: { $exists: true } },
    name: "uniq_conversation_sender_clientMessageId",
  }
);

export const DirectMessage = mongoose.model(
  "DirectMessage",
  directMessageSchema,
  "direct_messages"
);
