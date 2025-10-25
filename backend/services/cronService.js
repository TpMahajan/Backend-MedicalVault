import cron from 'node-cron';
import { runAllReminders } from './reminderService.js';

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

  console.log('✅ Cron jobs initialized successfully');
};

/**
 * Manual trigger for testing
 */
export const triggerReminders = async () => {
  console.log('🔔 Manually triggering reminders...');
  await runAllReminders();
};
