import { sendPushNotification } from '../config/firebase.js';
import User from '../models/User.js';

// @desc    Send push notification to a specific user
// @route   POST /api/notifications/send
// @access  Private
export const sendNotification = async (req, res) => {
  try {
    const { userId, title, body, data = {} } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({
        success: false,
        message: 'User ID, title, and body are required'
      });
    }

    // Find user and get FCM token
    const user = await User.findById(userId).select('fcmToken name');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'User has no FCM token registered'
      });
    }

    // Send notification
    const result = await sendPushNotification(user.fcmToken, { title, body }, data);

    if (result.success) {
      res.json({
        success: true,
        message: 'Notification sent successfully',
        data: {
          messageId: result.messageId,
          recipient: user.name
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send notification',
        error: result.error
      });
    }
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Send push notification to multiple users
// @route   POST /api/notifications/send-bulk
// @access  Private
export const sendBulkNotification = async (req, res) => {
  try {
    const { userIds, title, body, data = {} } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0 || !title || !body) {
      return res.status(400).json({
        success: false,
        message: 'User IDs array, title, and body are required'
      });
    }

    // Find users and get FCM tokens
    const users = await User.find({ 
      _id: { $in: userIds },
      fcmToken: { $exists: true, $ne: null }
    }).select('fcmToken name');

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No users with FCM tokens found'
      });
    }

    // Send notifications to all users
    const results = await Promise.allSettled(
      users.map(user => 
        sendPushNotification(user.fcmToken, { title, body }, data)
      )
    );

    const successful = results.filter(result => 
      result.status === 'fulfilled' && result.value.success
    ).length;

    const failed = results.length - successful;

    res.json({
      success: true,
      message: 'Bulk notification completed',
      data: {
        total: users.length,
        successful,
        failed,
        recipients: users.map(user => user.name)
      }
    });
  } catch (error) {
    console.error('Send bulk notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Send push notification to all users
// @route   POST /api/notifications/send-all
// @access  Private
export const sendNotificationToAll = async (req, res) => {
  try {
    const { title, body, data = {} } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: 'Title and body are required'
      });
    }

    // Find all users with FCM tokens
    const users = await User.find({ 
      fcmToken: { $exists: true, $ne: null },
      isActive: true
    }).select('fcmToken name');

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No users with FCM tokens found'
      });
    }

    // Send notifications to all users
    const results = await Promise.allSettled(
      users.map(user => 
        sendPushNotification(user.fcmToken, { title, body }, data)
      )
    );

    const successful = results.filter(result => 
      result.status === 'fulfilled' && result.value.success
    ).length;

    const failed = results.length - successful;

    res.json({
      success: true,
      message: 'Notification sent to all users',
      data: {
        total: users.length,
        successful,
        failed
      }
    });
  } catch (error) {
    console.error('Send notification to all error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
