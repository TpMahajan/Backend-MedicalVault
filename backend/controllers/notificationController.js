import { sendPushNotification } from '../config/firebase.js';
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { Notification } from "../models/Notification.js";
import jwt from 'jsonwebtoken';

// Store active SSE connections
const activeConnections = new Map();

// @desc    Save FCM token for user or doctor
// @route   POST /api/notifications/save-token
// @access  Private
export const saveFCMToken = async (req, res) => {
  try {
    const { fcmToken, userId, role } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required'
      });
    }

    // Determine which model to use based on role or userId
    let targetId = userId || req.auth.id;
    let isDoctor = role === 'doctor' || req.auth.role === 'doctor';

    let user;
    if (isDoctor) {
      user = await DoctorUser.findByIdAndUpdate(
        targetId,
        { fcmToken },
        { new: true, runValidators: true }
      ).select('-password');
    } else {
      user = await User.findByIdAndUpdate(
        targetId,
        { fcmToken },
        { new: true, runValidators: true }
      ).select('-password');
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'FCM token saved successfully',
      data: {
        userId: user._id,
        role: isDoctor ? 'doctor' : 'patient',
        name: user.name
      }
    });
  } catch (error) {
    console.error('Save FCM token error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Get notifications for current user
// @route   GET /api/notifications
// @access  Private
export const getNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 20, unreadOnly = false } = req.query;
    const userId = req.auth.id;
    const userRole = req.auth.role;

    // Build query
    const query = { 
      $or: [
        { recipientId: userId },
        { recipientRole: userRole }
      ]
    };

    if (unreadOnly === 'true') {
      query.read = false;
    }

    // Get notifications with pagination
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .select('-__v');

    // Get total count
    const total = await Notification.countDocuments(query);

    // Get unread count
    const unreadCount = await Notification.countDocuments({
      ...query,
      read: false
    });

    res.json({
      success: true,
      data: {
        notifications,
        pagination: {
          current: parseInt(page),
          pages: Math.ceil(total / limit),
          total
        },
        unreadCount
      }
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
export const markNotificationAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.auth.id;

    const notification = await Notification.findOneAndUpdate(
      { 
        _id: id,
        $or: [
          { recipientId: userId },
          { recipientRole: req.auth.role }
        ]
      },
      { read: true, readAt: new Date() },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification marked as read',
      data: notification
    });
  } catch (error) {
    console.error('Mark notification as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
// @access  Private
export const markAllNotificationsAsRead = async (req, res) => {
  try {
    const userId = req.auth.id;

    const result = await Notification.updateMany(
      { 
        $or: [
          { recipientId: userId },
          { recipientRole: req.auth.role }
        ],
        read: false
      },
      { read: true, readAt: new Date() }
    );

    res.json({
      success: true,
      message: 'All notifications marked as read',
      data: {
        modifiedCount: result.modifiedCount
      }
    });
  } catch (error) {
    console.error('Mark all notifications as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Send push notification to a specific user
// @route   POST /api/notifications/send
// @access  Private
export const sendNotification = async (req, res) => {
  try {
    const { userId, title, body, data = {}, type = 'general' } = req.body;

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

    // Create notification record
    const notification = new Notification({
      title,
      body,
      type,
      data,
      recipientId: userId,
      recipientRole: 'patient',
      senderId: req.auth.id,
      senderRole: req.auth.role
    });

    await notification.save();

    // Send push notification
    const result = await sendPushNotification(user.fcmToken, { title, body }, data);

    // Broadcast to SSE connections
    await broadcastNotification(notification);

    if (result.success) {
      res.json({
        success: true,
        message: 'Notification sent successfully',
        data: {
          messageId: result.messageId,
          recipient: user.name,
          notificationId: notification._id
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
    const { userIds, title, body, data = {}, type = 'general' } = req.body;

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

    // Create notification records
    const notifications = users.map(user => ({
      title,
      body,
      type,
      data,
      recipientId: user._id,
      recipientRole: 'patient',
      senderId: req.auth.id,
      senderRole: req.auth.role
    }));

    await Notification.insertMany(notifications);

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
    const { title, body, data = {}, type = 'general' } = req.body;

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

    // Create notification records
    const notifications = users.map(user => ({
      title,
      body,
      type,
      data,
      recipientId: user._id,
      recipientRole: 'patient',
      senderId: req.auth.id,
      senderRole: req.auth.role
    }));

    await Notification.insertMany(notifications);

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

// @desc    Server-Sent Events stream for real-time notifications
// @route   GET /api/notifications/stream
// @access  Private
export const getNotificationStream = async (req, res) => {
  try {
    // Handle token from query parameter for SSE
    let userId, userRole;
    
    if (req.query.token) {
      // Verify token from query parameter
      const decoded = jwt.verify(req.query.token, process.env.JWT_SECRET);
      userId = decoded.id;
      userRole = decoded.role;
    } else {
      // Fallback to auth middleware
      userId = req.auth.id;
      userRole = req.auth.role;
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ 
      type: 'connected', 
      message: 'Connected to notification stream',
      timestamp: new Date().toISOString()
    })}\n\n`);

    // Store connection
    const connectionId = `${userId}_${Date.now()}`;
    activeConnections.set(connectionId, {
      res,
      userId,
      userRole,
      connectedAt: new Date()
    });

    // Send initial unread count
    const unreadCount = await Notification.countDocuments({
      $or: [
        { recipientId: userId },
        { recipientRole: userRole }
      ],
      read: false
    });

    res.write(`data: ${JSON.stringify({ 
      type: 'unread_count', 
      count: unreadCount,
      timestamp: new Date().toISOString()
    })}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      console.log(`📡 SSE connection closed for user ${userId}`);
      activeConnections.delete(connectionId);
    });

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      if (res.destroyed) {
        clearInterval(heartbeat);
        activeConnections.delete(connectionId);
        return;
      }
      
      res.write(`data: ${JSON.stringify({ 
        type: 'heartbeat', 
        timestamp: new Date().toISOString()
      })}\n\n`);
    }, 30000); // Send heartbeat every 30 seconds

  } catch (error) {
    console.error('SSE stream error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to establish notification stream'
      });
    }
  }
};

// Helper function to broadcast notification to connected clients
export const broadcastNotification = async (notification) => {
  try {
    const { recipientId, recipientRole } = notification;
    
    // Find all active connections for this user
    const userConnections = Array.from(activeConnections.entries())
      .filter(([id, conn]) => 
        conn.userId === recipientId || 
        (recipientRole && conn.userRole === recipientRole)
      );

    if (userConnections.length === 0) {
      console.log(`📡 No active connections for user ${recipientId}`);
      return;
    }

    // Send notification to all user's connections
    const notificationData = {
      type: 'new_notification',
      notification: {
        id: notification._id,
        title: notification.title,
        body: notification.body,
        type: notification.type,
        data: notification.data,
        timeAgo: notification.timeAgo,
        createdAt: notification.createdAt
      },
      timestamp: new Date().toISOString()
    };

    userConnections.forEach(([connectionId, conn]) => {
      try {
        if (!conn.res.destroyed) {
          conn.res.write(`data: ${JSON.stringify(notificationData)}\n\n`);
          console.log(`📡 Notification sent to connection ${connectionId}`);
        } else {
          activeConnections.delete(connectionId);
        }
      } catch (error) {
        console.error(`❌ Error sending to connection ${connectionId}:`, error);
        activeConnections.delete(connectionId);
      }
    });

    // Update unread count for all user's connections
    const unreadCount = await Notification.countDocuments({
      $or: [
        { recipientId },
        { recipientRole }
      ],
      read: false
    });

    const unreadCountData = {
      type: 'unread_count',
      count: unreadCount,
      timestamp: new Date().toISOString()
    };

    userConnections.forEach(([connectionId, conn]) => {
      try {
        if (!conn.res.destroyed) {
          conn.res.write(`data: ${JSON.stringify(unreadCountData)}\n\n`);
        }
      } catch (error) {
        console.error(`❌ Error sending unread count to connection ${connectionId}:`, error);
        activeConnections.delete(connectionId);
      }
    });

  } catch (error) {
    console.error('❌ Error broadcasting notification:', error);
  }
};