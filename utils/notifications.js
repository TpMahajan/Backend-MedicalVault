import { sendPushNotification, initializeFirebase } from "../config/firebase.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";

// Initialize Firebase on module load
const firebaseInitialized = initializeFirebase();

if (!firebaseInitialized) {
  console.warn('⚠️ Firebase not initialized - push notifications will be disabled');
}

/**
 * Send notification to a user by their ID
 * @param {string} userId - The user ID to send notification to
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data payload (optional)
 * @returns {Promise<boolean>} - Success status
 */
async function sendNotification(userId, title, body, data = {}) {
  try {
    // Check if Firebase is initialized
    if (!firebaseInitialized) {
      console.log(`⚠️ Firebase not initialized - skipping notification to user ${userId}`);
      return false;
    }

    // Find the user and get their FCM token
    const user = await User.findById(userId);
    if (!user || !user.fcmToken) {
      console.log(`⚠️ User ${userId} not found or no FCM token available`);
      return false;
    }

    console.log(`📱 Sending notification to user: ${user.name || user.email}`);

    // Send the push notification
    const result = await sendPushNotification(
      user.fcmToken,
      { title, body },
      data
    );

    if (result.success) {
      console.log(`✅ Notification sent successfully to: ${user.email || user._id}`);
      return true;
    } else {
      console.error(`❌ Notification failed for user ${userId}:`, result.error);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error sending notification to user ${userId}:`, error.message);
    return false;
  }
}

/**
 * Send notification to a doctor by their ID
 * @param {string} doctorId - The doctor ID to send notification to
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data payload (optional)
 * @returns {Promise<boolean>} - Success status
 */
async function sendNotificationToDoctor(doctorId, title, body, data = {}) {
  try {
    // Check if Firebase is initialized
    if (!firebaseInitialized) {
      console.log(`⚠️ Firebase not initialized - skipping notification to doctor ${doctorId}`);
      return false;
    }

    // Find the doctor and get their FCM token
    const doctor = await DoctorUser.findById(doctorId);
    if (!doctor || !doctor.fcmToken) {
      console.log(`⚠️ Doctor ${doctorId} not found or no FCM token available`);
      return false;
    }

    console.log(`📱 Sending notification to doctor: ${doctor.name || doctor.email}`);

    // Send the push notification
    const result = await sendPushNotification(
      doctor.fcmToken,
      { title, body },
      data
    );

    if (result.success) {
      console.log(`✅ Notification sent successfully to doctor: ${doctor.email || doctor._id}`);
      return true;
    } else {
      console.error(`❌ Notification failed for doctor ${doctorId}:`, result.error);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error sending notification to doctor ${doctorId}:`, error.message);
    return false;
  }
}

/**
 * Send notification to multiple users
 * @param {string[]} userIds - Array of user IDs
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data payload (optional)
 * @returns {Promise<object>} - Results summary
 */
async function sendBulkNotifications(userIds, title, body, data = {}) {
  const results = {
    successful: [],
    failed: [],
    total: userIds.length
  };

  // Check if Firebase is initialized
  if (!firebaseInitialized) {
    console.log(`⚠️ Firebase not initialized - skipping bulk notifications to ${userIds.length} users`);
    results.failed = [...userIds];
    return results;
  }

  console.log(`📱 Sending bulk notifications to ${userIds.length} users`);

  // Send notifications in parallel
  const promises = userIds.map(async (userId) => {
    const success = await sendNotification(userId, title, body, data);
    if (success) {
      results.successful.push(userId);
    } else {
      results.failed.push(userId);
    }
  });

  await Promise.all(promises);

  console.log(`📊 Bulk notification results: ${results.successful.length} successful, ${results.failed.length} failed`);
  return results;
}

export { 
  sendNotification, 
  sendNotificationToDoctor, 
  sendBulkNotifications 
};
