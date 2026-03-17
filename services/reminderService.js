import { Appointment } from '../models/Appointment.js';
import { User } from '../models/User.js';
import { DoctorUser } from '../models/DoctorUser.js';
import { Notification } from '../models/Notification.js';
import { sendNotification } from '../utils/notifications.js';
import { broadcastNotification } from '../controllers/notificationController.js';

/**
 * Send appointment reminders
 */
export const sendAppointmentReminders = async () => {
  try {
    console.log('🔔 Starting appointment reminder check...');
    
    // Get appointments that are scheduled for tomorrow (24 hours from now)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);
    
    const upcomingAppointments = await Appointment.find({
      appointmentDate: {
        $gte: tomorrow,
        $lt: dayAfter
      },
      status: { $in: ['scheduled', 'confirmed'] },
      reminderSent: false
    }).populate('doctorId', 'name email');

    console.log(`📅 Found ${upcomingAppointments.length} appointments for tomorrow`);

    for (const appointment of upcomingAppointments) {
      try {
        // Get patient info
        const patient = await User.findById(appointment.patientId);
        if (!patient) {
          console.log(`⚠️ Patient not found for appointment ${appointment._id}`);
          continue;
        }

        // Create reminder notification
        const notification = new Notification({
          title: "Appointment Reminder",
          body: `You have an appointment tomorrow at ${appointment.appointmentTime} with Dr. ${appointment.doctorName}`,
          type: "reminder",
          data: {
            appointmentId: appointment._id.toString(),
            appointmentDate: appointment.appointmentDate,
            appointmentTime: appointment.appointmentTime,
            doctorName: appointment.doctorName,
            reason: appointment.reason
          },
          recipientId: appointment.patientId,
          recipientRole: "patient",
          senderId: appointment.doctorId._id.toString(),
          senderRole: "doctor"
        });
        await notification.save();

        // Send push notification
        if (patient.fcmToken) {
          await sendNotification(
            appointment.patientId,
            "Appointment Reminder",
            `You have an appointment tomorrow at ${appointment.appointmentTime} with Dr. ${appointment.doctorName}`,
            {
              type: "APPOINTMENT_REMINDER",
              appointmentId: appointment._id.toString(),
              appointmentDate: appointment.appointmentDate,
              appointmentTime: appointment.appointmentTime,
              doctorName: appointment.doctorName
            }
          );
        }

        // Broadcast to SSE connections
        await broadcastNotification(notification);

        // Mark reminder as sent
        await Appointment.findByIdAndUpdate(appointment._id, { reminderSent: true });

        console.log(`✅ Reminder sent for appointment ${appointment._id}`);
      } catch (error) {
        console.error(`❌ Error sending reminder for appointment ${appointment._id}:`, error);
      }
    }

    console.log('🔔 Appointment reminder check completed');
  } catch (error) {
    console.error('❌ Error in appointment reminder service:', error);
  }
};

/**
 * Send medication reminders
 */
export const sendMedicationReminders = async () => {
  try {
    console.log('💊 Starting medication reminder check...');
    
    // Get all active users with medications
    const usersWithMedications = await User.find({
      medications: { $exists: true, $not: { $size: 0 } },
      isActive: true,
      fcmToken: { $exists: true, $ne: null }
    });

    console.log(`💊 Found ${usersWithMedications.length} users with medications`);

    for (const user of usersWithMedications) {
      try {
        // Check if user has medications that need reminders
        const hasActiveMedications = user.medications.some(med => 
          med.name && med.frequency && med.frequency.toLowerCase().includes('daily')
        );

        if (hasActiveMedications) {
          // Create medication reminder notification
          const notification = new Notification({
            title: "Medication Reminder",
            body: "Don't forget to take your medications as prescribed",
            type: "reminder",
            data: {
              reminderType: "medication",
              userId: user._id.toString()
            },
            recipientId: user._id.toString(),
            recipientRole: "patient",
            senderId: "system",
            senderRole: "system"
          });
          await notification.save();

          // Send push notification
          await sendNotification(
            user._id.toString(),
            "Medication Reminder",
            "Don't forget to take your medications as prescribed",
            {
              type: "MEDICATION_REMINDER",
              userId: user._id.toString()
            }
          );

          // Broadcast to SSE connections
          await broadcastNotification(notification);

          console.log(`✅ Medication reminder sent to user ${user._id}`);
        }
      } catch (error) {
        console.error(`❌ Error sending medication reminder to user ${user._id}:`, error);
      }
    }

    console.log('💊 Medication reminder check completed');
  } catch (error) {
    console.error('❌ Error in medication reminder service:', error);
  }
};

/**
 * Send system notifications
 */
export const sendSystemNotifications = async () => {
  try {
    console.log('🔧 Starting system notification check...');
    
    // Get all active users
    const activeUsers = await User.find({
      isActive: true,
      fcmToken: { $exists: true, $ne: null }
    });

    console.log(`🔧 Found ${activeUsers.length} active users`);

    // Example: Send maintenance notification (you can customize this)
    const maintenanceNotification = {
      title: "System Maintenance",
      body: "Scheduled maintenance will occur tonight from 2 AM to 4 AM. Some features may be temporarily unavailable.",
      type: "system",
      data: {
        maintenanceType: "scheduled",
        startTime: "2024-01-01T02:00:00Z",
        endTime: "2024-01-01T04:00:00Z"
      }
    };

    for (const user of activeUsers) {
      try {
        // Create system notification
        const notification = new Notification({
          title: maintenanceNotification.title,
          body: maintenanceNotification.body,
          type: maintenanceNotification.type,
          data: maintenanceNotification.data,
          recipientId: user._id.toString(),
          recipientRole: "patient",
          senderId: "system",
          senderRole: "system"
        });
        await notification.save();

        // Send push notification
        await sendNotification(
          user._id.toString(),
          maintenanceNotification.title,
          maintenanceNotification.body,
          {
            type: "SYSTEM_NOTIFICATION",
            ...maintenanceNotification.data
          }
        );

        // Broadcast to SSE connections
        await broadcastNotification(notification);

        console.log(`✅ System notification sent to user ${user._id}`);
      } catch (error) {
        console.error(`❌ Error sending system notification to user ${user._id}:`, error);
      }
    }

    console.log('🔧 System notification check completed');
  } catch (error) {
    console.error('❌ Error in system notification service:', error);
  }
};

/**
 * Run all reminder services
 */
export const runAllReminders = async () => {
  console.log('🚀 Running all reminder services...');
  
  await sendAppointmentReminders();
  await sendMedicationReminders();
  // Uncomment the line below if you want to send system notifications
  // await sendSystemNotifications();
  
  console.log('✅ All reminder services completed');
};
