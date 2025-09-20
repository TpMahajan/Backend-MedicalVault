import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    // Doctor requesting access
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DoctorUser",
      required: true,
    },
    
    // Patient being requested access to
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    
    // Status of the request/session
    status: {
      type: String,
      enum: ["pending", "accepted", "declined"],
      default: "pending",
      required: true,
    },
    
    // When the session expires (20 minutes from creation for pending, or from acceptance for accepted)
    expiresAt: {
      type: Date,
      default: function() {
        return new Date(Date.now() + 20 * 60 * 1000); // 20 minutes from now
      },
    },
    
    // Additional metadata
    requestMessage: {
      type: String,
      default: "",
      maxlength: 500,
    },
    
    // Response timestamp when patient accepts/declines
    respondedAt: {
      type: Date,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// Index for efficient queries
sessionSchema.index({ patientId: 1, status: 1 });
sessionSchema.index({ doctorId: 1, status: 1 });
sessionSchema.index({ expiresAt: 1 }); // For TTL cleanup

// Static method to clean up expired sessions
sessionSchema.statics.cleanExpiredSessions = async function() {
  const now = new Date();
  const result = await this.deleteMany({
    expiresAt: { $lt: now }
  });
  console.log(`🧹 Cleaned up ${result.deletedCount} expired sessions`);
  return result;
};

// Instance method to check if session is active
sessionSchema.methods.isActive = function() {
  return this.status === "accepted" && this.expiresAt > new Date();
};

// Instance method to extend session (when accepted)
sessionSchema.methods.extendSession = function(minutes = 20) {
  this.expiresAt = new Date(Date.now() + minutes * 60 * 1000);
  return this.save();
};

// Pre-save middleware to ensure expiresAt is always set
sessionSchema.pre("save", function(next) {
  // Always ensure expiresAt is set for new documents
  if (this.isNew && (!this.expiresAt || this.expiresAt === null)) {
    console.log('🕒 Setting expiresAt for new session');
    this.expiresAt = new Date(Date.now() + 20 * 60 * 1000);
  }
  console.log('💾 Session pre-save:', {
    isNew: this.isNew,
    expiresAt: this.expiresAt,
    status: this.status
  });
  next();
});

// Explicitly specify collection name as "sessions"
export const Session = mongoose.model("Session", sessionSchema, "sessions");
