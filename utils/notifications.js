import { sendPushNotification, initializeFirebase } from "../config/firebase.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";

// Initialize Firebase on module load
const firebaseInitialized = initializeFirebase();

if (!firebaseInitialized) {
  console.warn('⚠️ Firebase not initialized - push notifications will be disabled');
}

// FCM error codes that mean the token itself is permanently dead (app
// uninstalled, token rotated/invalidated, etc) rather than a transient
// failure. Any other error (network blip, quota) is left alone so a
// working token is never cleared on a temporary hiccup.
const STALE_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

const clearStaleFcmToken = async (Model, id, currentToken) => {
  try {
    await Model.updateOne(
      { _id: id, fcmToken: currentToken },
      { $set: { fcmToken: null } }
    );
  } catch (error) {
    console.error(`⚠️ Failed to clear stale FCM token for ${Model.modelName} ${id}:`, error.message);
  }
};

/**
 * Send notification to a user by their ID
 * @param {string} userId - The user ID to send notification to
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data payload (optional)
 * @param {object} options - Additional options (optional)
 * @param {string} [options.image] - Sender avatar/image URL for the push notification
 * @returns {Promise<boolean>} - Success status
 */
async function sendNotification(userId, title, body, data = {}, options = {}) {
  const notificationType = data?.type || "notification";
  try {
    // Check if Firebase is initialized
    if (!firebaseInitialized) {
      console.log(`⚠️ [${notificationType}] Firebase not initialized - skipping notification to user ${userId}`);
      return false;
    }

    // Find the user and get their FCM token
    const user = await User.findById(userId);
    if (!user || !user.fcmToken) {
      console.log(`⚠️ [${notificationType}] User ${userId} not found or no FCM token registered - push cannot be delivered`);
      return false;
    }

    console.log(`📱 [${notificationType}] Sending notification to user ${userId}`);

    // Send the push notification
    const result = await sendPushNotification(
      user.fcmToken,
      { title, body, image: options?.image },
      data
    );

    if (result.success) {
      console.log(`✅ [${notificationType}] Notification sent successfully to user ${userId}`);
      return true;
    }

    console.error(`❌ [${notificationType}] Notification failed for user ${userId} (${result.code || "unknown error"}):`, result.error);
    if (STALE_TOKEN_ERROR_CODES.has(result.code)) {
      console.warn(`🧹 [${notificationType}] Clearing stale FCM token for user ${userId} (${result.code})`);
      await clearStaleFcmToken(User, userId, user.fcmToken);
    }
    return false;
  } catch (error) {
    console.error(`❌ [${notificationType}] Error sending notification to user ${userId}:`, error.message);
    return false;
  }
}

/**
 * Send notification to a doctor by their ID
 * @param {string} doctorId - The doctor ID to send notification to
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {object} data - Additional data payload (optional)
 * @param {object} options - Additional options (optional)
 * @param {string} [options.image] - Sender avatar/image URL for the push notification
 * @returns {Promise<boolean>} - Success status
 */
async function sendNotificationToDoctor(doctorId, title, body, data = {}, options = {}) {
  const notificationType = data?.type || "notification";
  try {
    // Check if Firebase is initialized
    if (!firebaseInitialized) {
      console.log(`⚠️ [${notificationType}] Firebase not initialized - skipping notification to doctor ${doctorId}`);
      return false;
    }

    // Find the doctor and get their FCM token
    const doctor = await DoctorUser.findById(doctorId);
    if (!doctor || !doctor.fcmToken) {
      console.log(`⚠️ [${notificationType}] Doctor ${doctorId} not found or no FCM token registered - push cannot be delivered`);
      return false;
    }

    console.log(`📱 [${notificationType}] Sending notification to doctor ${doctorId}`);

    // Send the push notification
    const result = await sendPushNotification(
      doctor.fcmToken,
      { title, body, image: options?.image },
      data
    );

    if (result.success) {
      console.log(`✅ [${notificationType}] Notification sent successfully to doctor ${doctorId}`);
      return true;
    }

    console.error(`❌ [${notificationType}] Notification failed for doctor ${doctorId} (${result.code || "unknown error"}):`, result.error);
    if (STALE_TOKEN_ERROR_CODES.has(result.code)) {
      console.warn(`🧹 [${notificationType}] Clearing stale FCM token for doctor ${doctorId} (${result.code})`);
      await clearStaleFcmToken(DoctorUser, doctorId, doctor.fcmToken);
    }
    return false;
  } catch (error) {
    console.error(`❌ [${notificationType}] Error sending notification to doctor ${doctorId}:`, error.message);
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
