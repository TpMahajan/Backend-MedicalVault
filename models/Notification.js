import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  body: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['general', 'appointment', 'session', 'document', 'qr_scan', 'system', 'reminder'],
    default: 'general'
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  recipientRole: {
    type: String,
    enum: ['patient', 'doctor', 'admin'],
    required: true
  },
  senderId: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  senderRole: {
    type: String,
    enum: ['patient', 'doctor', 'admin', 'system'],
    required: true
  },
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: {
    type: Date
  },
  // For push notifications
  fcmSent: {
    type: Boolean,
    default: false
  },
  fcmMessageId: {
    type: String
  }
}, {
  timestamps: true
});

// Indexes for better performance
notificationSchema.index({ recipientId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ recipientRole: 1, read: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });

// Virtual for time ago
notificationSchema.virtual('timeAgo').get(function() {
  const now = new Date();
  const diff = now - this.createdAt;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  return `${days} day${days > 1 ? 's' : ''} ago`;
});

// Ensure virtual fields are serialized
notificationSchema.set('toJSON', { virtuals: true });

export const Notification = mongoose.model('Notification', notificationSchema);
