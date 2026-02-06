import { Appointment } from '../models/Appointment.js';
import { User } from '../models/User.js';
import { DoctorUser } from '../models/DoctorUser.js';
import { Notification } from '../models/Notification.js';
import { sendNotification } from '../utils/notifications.js';
import { broadcastNotification } from '../controllers/notificationController.js';

const getSmartReminderBody = (appointment, hoursAhead) => {
  const isEmergency = appointment.appointmentType === 'emergency';
  const doctorName = appointment.doctorName || 'your doctor';
  const time = appointment.appointmentTime || '';
  if (hoursAhead <= 1 && isEmergency) {
    return `Urgent: Your emergency appointment with Dr. ${doctorName} is in 1 hour at ${time}.`;
  }
  if (hoursAhead <= 1) {
    return `Reminder: Your appointment with Dr. ${doctorName} is in 1 hour at ${time}.`;
  }
  if (isEmergency) {
    return `Urgent: Your emergency appointment with Dr. ${doctorName} is tomorrow at ${time}.`;
  }
  return `Reminder: Your checkup with Dr. ${doctorName} is tomorrow at ${time}.`;
};

const buildAppointmentDateTime = (apt) => {
  const d = new Date(apt.appointmentDate);
  const [h, m] = (apt.appointmentTime || '00:00').split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};

/**
 * Send 24h appointment reminders
 */
export const send24hReminders = async () => {
  try {
    console.log('🔔 Starting 24h appointment reminder check...');
    const now = new Date();
    const in24h = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const appointments = await Appointment.find({
      status: { $in: ['scheduled', 'confirmed'] },
      reminder24hSent: false,
    }).populate('doctorId', 'name email');

    const toRemind = appointments.filter((apt) => {
      const aptDt = buildAppointmentDateTime(apt);
      return aptDt >= in24h && aptDt <= in25h;
    });

    console.log(`📅 Found ${toRemind.length} appointments for 24h reminder`);

    for (const appointment of toRemind) {
      try {
        const patient = await User.findById(appointment.patientId);
        if (!patient) continue;

        const body = getSmartReminderBody(appointment, 24);
        const data = {
          type: 'APPOINTMENT_24H_REMINDER',
          appointmentId: appointment._id.toString(),
          appointmentDate: appointment.appointmentDate,
          appointmentTime: appointment.appointmentTime,
          doctorName: appointment.doctorName,
          reason: appointment.reason,
          deepLink: `/appointments/${appointment._id}`,
        };

        const notification = new Notification({
          title: 'Appointment Reminder',
          body,
          type: 'reminder',
          data: { ...data },
          recipientId: appointment.patientId,
          recipientRole: 'patient',
          senderId: (appointment.doctorId?._id || appointment.doctorId)?.toString() || 'system',
          senderRole: 'doctor',
        });
        await notification.save();

        if (patient.fcmToken) {
          await sendNotification(appointment.patientId, 'Appointment Reminder', body, data);
        }
        await broadcastNotification(notification);
        await Appointment.findByIdAndUpdate(appointment._id, { reminder24hSent: true, reminderSent: true });
        console.log(`✅ 24h reminder sent for appointment ${appointment._id}`);
      } catch (error) {
        console.error(`❌ Error sending 24h reminder for ${appointment._id}:`, error);
      }
    }
    console.log('🔔 24h reminder check completed');
  } catch (error) {
    console.error('❌ Error in 24h reminder service:', error);
  }
};

/**
 * Send 1h appointment reminders
 */
export const send1hReminders = async () => {
  try {
    console.log('🔔 Starting 1h appointment reminder check...');
    const now = new Date();
    const in55min = new Date(now.getTime() + 55 * 60 * 1000);
    const in65min = new Date(now.getTime() + 65 * 60 * 1000);

    const appointments = await Appointment.find({
      status: { $in: ['scheduled', 'confirmed'] },
      reminder1hSent: false,
    }).populate('doctorId', 'name email');

    const toRemind = appointments.filter((apt) => {
      const aptDt = buildAppointmentDateTime(apt);
      return aptDt >= in55min && aptDt <= in65min;
    });

    console.log(`📅 Found ${toRemind.length} appointments for 1h reminder`);

    for (const appointment of toRemind) {
      try {
        const patient = await User.findById(appointment.patientId);
        if (!patient) continue;

        const body = getSmartReminderBody(appointment, 1);
        const data = {
          type: 'APPOINTMENT_1H_REMINDER',
          appointmentId: appointment._id.toString(),
          appointmentDate: appointment.appointmentDate,
          appointmentTime: appointment.appointmentTime,
          doctorName: appointment.doctorName,
          reason: appointment.reason,
          deepLink: `/appointments/${appointment._id}`,
        };

        const notification = new Notification({
          title: 'Appointment Starting Soon',
          body,
          type: 'reminder',
          data: { ...data },
          recipientId: appointment.patientId,
          recipientRole: 'patient',
          senderId: (appointment.doctorId?._id || appointment.doctorId)?.toString() || 'system',
          senderRole: 'doctor',
        });
        await notification.save();

        if (patient.fcmToken) {
          await sendNotification(appointment.patientId, 'Appointment Starting Soon', body, data);
        }
        await broadcastNotification(notification);
        await Appointment.findByIdAndUpdate(appointment._id, { reminder1hSent: true, reminderSent: true });
        console.log(`✅ 1h reminder sent for appointment ${appointment._id}`);
      } catch (error) {
        console.error(`❌ Error sending 1h reminder for ${appointment._id}:`, error);
      }
    }
    console.log('🔔 1h reminder check completed');
  } catch (error) {
    console.error('❌ Error in 1h reminder service:', error);
  }
};

/**
 * Send appointment reminders (legacy: tomorrow-based, uses reminderSent)
 */
export const sendAppointmentReminders = async () => {
  try {
    await send24hReminders();
    await send1hReminders();
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
