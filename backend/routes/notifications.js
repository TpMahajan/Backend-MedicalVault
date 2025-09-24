import express from 'express';
import { 
  saveFCMToken,
  sendNotification, 
  sendBulkNotification, 
  sendNotificationToAll 
} from '../controllers/notificationController.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// @route   POST /api/notifications/save-token
// @desc    Save FCM token for user or doctor
// @access  Private
router.post('/save-token', auth, saveFCMToken);

// All other routes require authentication
router.use(auth);

// @route   POST /api/notifications/send
// @desc    Send push notification to a specific user
// @access  Private
router.post('/send', sendNotification);

// @route   POST /api/notifications/send-bulk
// @desc    Send push notification to multiple users
// @access  Private
router.post('/send-bulk', sendBulkNotification);

// @route   POST /api/notifications/send-all
// @desc    Send push notification to all users
// @access  Private
router.post('/send-all', sendNotificationToAll);

export default router;
