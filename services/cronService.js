import cron from 'node-cron';
import { runAllReminders } from './reminderService.js';
import { runFamilyCareMedicationScheduler } from "./familyCareNotificationService.js";

/**
 * Initialize cron jobs for reminders
 */
export const initializeCronJobs = () => {
  console.log('⏰ Initializing cron jobs...');

  // Run appointment and medication reminders every day at 9 AM
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Running daily reminders at 9 AM...');
    await runAllReminders();
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata" // Adjust timezone as needed
  });

  // Run appointment reminders every 6 hours to catch appointments
  cron.schedule('0 */6 * * *', async () => {
    console.log('⏰ Running appointment reminders every 6 hours...');
    const { sendAppointmentReminders } = await import('./reminderService.js');
    await sendAppointmentReminders();
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  // Run medication reminders every 12 hours
  cron.schedule('0 */12 * * *', async () => {
    console.log('⏰ Running medication reminders every 12 hours...');
    const { sendMedicationReminders } = await import('./reminderService.js');
    await sendMedicationReminders();
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  // Family Care medication schedules are evaluated against per-schedule IANA
  // timezones. This five-minute UTC tick is only a worker cadence; it never
  // determines a dose's local wall-clock time.
  cron.schedule('*/5 * * * *', async () => {
    try {
      await runFamilyCareMedicationScheduler();
    } catch (error) {
      console.error('Family Care medication scheduler failed:', error.message);
    }
  }, { scheduled: true, timezone: 'UTC' });

  console.log('✅ Cron jobs initialized successfully');
};

/**
 * Manual trigger for testing
 */
export const triggerReminders = async () => {
  console.log('🔔 Manually triggering reminders...');
  await runAllReminders();
};
