import mongoose from "mongoose";

const appointmentNotificationSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
      index: true,
    },
    recipientId: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true,
    },
    recipientRole: {
      type: String,
      enum: ["patient", "doctor", "admin"],
      required: true,
    },
    triggerType: {
      type: String,
      enum: [
        "APPOINTMENT_BOOKED",
        "APPOINTMENT_APPROVED",
        "APPOINTMENT_24H_REMINDER",
        "APPOINTMENT_1H_REMINDER",
        "APPOINTMENT_RESCHEDULED",
        "APPOINTMENT_CANCELLED",
        "DOCTOR_RUNNING_LATE",
        "APPOINTMENT_COMPLETED",
        "APPOINTMENT_PENDING",
      ],
      required: true,
    },
    sentAt: { type: Date, default: Date.now },
    fcmSent: { type: Boolean, default: false },
    inAppCreated: { type: Boolean, default: false },
    deepLinkData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

appointmentNotificationSchema.index({ appointmentId: 1, triggerType: 1 });
appointmentNotificationSchema.index({ recipientId: 1, sentAt: -1 });

export const AppointmentNotification = mongoose.model(
  "AppointmentNotification",
  appointmentNotificationSchema,
  "appointment_notifications"
);
