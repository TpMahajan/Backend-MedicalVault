import express from 'express';
import { 
  saveFCMToken,
  sendNotification, 
  sendBulkNotification, 
  sendNotificationToAll,
  getNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  getNotificationStream
} from '../controllers/notificationController.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// @route   POST /api/notifications/save-token
// @desc    Save FCM token for user or doctor
// @access  Private
router.post('/save-token', auth, saveFCMToken);

// @route   GET /api/notifications/stream
// @desc    Server-Sent Events stream for real-time notifications
// @access  Private (handles auth via query parameter)
router.get('/stream', getNotificationStream);

// All other routes require authentication
router.use(auth);

// @route   GET /api/notifications
// @desc    Get notifications for current user
// @access  Private
router.get('/', getNotifications);

// @route   PUT /api/notifications/:id/read
// @desc    Mark notification as read
// @access  Private
router.put('/:id/read', markNotificationAsRead);

// @route   PUT /api/notifications/read-all
// @desc    Mark all notifications as read
// @access  Private
router.put('/read-all', markAllNotificationsAsRead);

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

// @route   POST /api/notifications/test
// @desc    Send test notification to current user
// @access  Private
router.post('/test', async (req, res) => {
  try {
    const { title = 'Test Notification', body = 'This is a test notification', type = 'general' } = req.body;
    const userId = req.auth.id;
    const userRole = req.auth.role;

    // Create notification record
    const notification = new (await import('../models/Notification.js')).Notification({
      title,
      body,
      type,
      data: { test: true },
      recipientId: userId,
      recipientRole: userRole,
      senderId: userId,
      senderRole: userRole
    });

    await notification.save();

    // Broadcast to SSE connections
    const { broadcastNotification } = await import('../controllers/notificationController.js');
    await broadcastNotification(notification);

    res.json({
      success: true,
      message: 'Test notification sent',
      data: {
        notificationId: notification._id,
        title: notification.title,
        body: notification.body
      }
    });
  } catch (error) {
    console.error('Test notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

export default router;