import { sendPushNotification } from '../config/firebase.js';
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { Notification } from "../models/Notification.js";
import mongoose from "mongoose";
import { DeviceToken } from "../models/DeviceToken.js";
import { deliverNotifications } from "../services/notificationDeliveryService.js";

// Store active SSE connections
const activeConnections = new Map();

const normalizeRole = (value) => String(value || "").trim().toLowerCase();

const buildNotificationScopeFilter = ({ userId, userRole }) => {
  const role = normalizeRole(userRole);
  const roleAllowed = ["patient", "doctor", "admin"].includes(role);
  const objectIdAllowed = mongoose.Types.ObjectId.isValid(userId);

  const conditions = [];
  if (objectIdAllowed) conditions.push({ recipientId: userId });
  if (roleAllowed) conditions.push({ recipientRole: role });

  if (conditions.length === 0) return null;
  return { $or: conditions };
};

// @desc    Save FCM token for user or doctor
// @route   POST /api/notifications/save-token
// @access  Private
export const saveFCMToken = async (req, res) => {
  try {
    const { fcmToken, platform = "unknown", deviceId } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required'
      });
    }

    // A token can only be registered for the authenticated account. This also
    // detaches it from a previous account after account switching.
    const targetId = req.auth.id;
    const isDoctor = normalizeRole(req.auth.role) === 'doctor';

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

    await DeviceToken.findOneAndUpdate(
      { token: fcmToken },
      { $set: { userId: targetId, role: normalizeRole(req.auth.role), platform: ["android", "ios", "web"].includes(String(platform).toLowerCase()) ? String(platform).toLowerCase() : "unknown", deviceId: String(deviceId || "").slice(0, 160) || null, enabled: true, lastSeenAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
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

    const scopeFilter = buildNotificationScopeFilter({ userId, userRole });
    if (!scopeFilter) {
      return res.json({
        success: true,
        data: {
          notifications: [],
          pagination: {
            current: parseInt(page),
            pages: 0,
            total: 0
          },
          unreadCount: 0
        }
      });
    }

    // Build query
    const query = { ...scopeFilter };

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
    const scopeFilter = buildNotificationScopeFilter({
      userId,
      userRole: req.auth.role
    });
    if (!scopeFilter) {
      return res.status(403).json({
        success: false,
        message: 'Notification access is not allowed for this role'
      });
    }

    const notification = await Notification.findOneAndUpdate(
      {
        _id: id,
        ...scopeFilter
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
    const scopeFilter = buildNotificationScopeFilter({
      userId,
      userRole: req.auth.role
    });
    if (!scopeFilter) {
      return res.status(403).json({
        success: false,
        message: 'Notification access is not allowed for this role'
      });
    }

    const result = await Notification.updateMany(
      {
        ...scopeFilter,
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

// @desc    Delete a notification
// @route   DELETE /api/notifications/:id
// @access  Private
export const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.auth.id;
    const scopeFilter = buildNotificationScopeFilter({
      userId,
      userRole: req.auth.role
    });
    if (!scopeFilter) {
      return res.status(403).json({
        success: false,
        message: 'Notification access is not allowed for this role'
      });
    }

    const notification = await Notification.findOneAndDelete({
      _id: id,
      ...scopeFilter
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Delete all notifications for current user
// @route   DELETE /api/notifications
// @access  Private
export const deleteAllNotifications = async (req, res) => {
  try {
    const userId = req.auth.id;
    const scopeFilter = buildNotificationScopeFilter({
      userId,
      userRole: req.auth.role
    });
    if (!scopeFilter) {
      return res.status(403).json({
        success: false,
        message: 'Notification access is not allowed for this role'
      });
    }

    await Notification.deleteMany({
      ...scopeFilter
    });

    res.json({
      success: true,
      message: 'All notifications cleared successfully'
    });
  } catch (error) {
    console.error('Delete all notifications error:', error);
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

    // Find user; in-app persistence does not depend on a registered device.
    const user = await User.findById(userId).select('name');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const { result, notifications } = await deliverNotifications({ recipients: [{ userId, role: 'patient' }], title, body, type, data, senderId: req.auth.id, senderRole: req.auth.role });
    const partial = result.pushFailed > 0;
    res.status(partial ? 207 : 200).json({ success: result.notificationsCreated === 1, partial, message: partial ? 'In-app notification created; push delivery failed.' : 'Notification delivered', data: { recipient: user.name, notificationId: notifications[0]?._id, delivery: result } });
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
    const userId = req.auth?.id;
    const userRole = req.auth?.role;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const connectionId = `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeConnections.set(connectionId, { res, userId, userRole });
    console.info(`[notification-realtime] connected user=${String(userId)} role=${normalizeRole(userRole)}`);

    res.write(
      `data: ${JSON.stringify({
        type: "connected",
        connectionId,
        timestamp: new Date().toISOString(),
      })}\n\n`
    );

    req.on("close", () => {
      activeConnections.delete(connectionId);
      clearInterval(heartbeat);
      console.info(`[notification-realtime] disconnected user=${String(userId)}`);
    });

    const heartbeat = setInterval(() => {
      if (res.destroyed) {
        clearInterval(heartbeat);
        activeConnections.delete(connectionId);
        return;
      }

      try {
        res.write(
          `data: ${JSON.stringify({
            type: "heartbeat",
            timestamp: new Date().toISOString(),
          })}\n\n`
        );
      } catch {
        clearInterval(heartbeat);
        activeConnections.delete(connectionId);
      }
    }, 15000);
  } catch (error) {
    console.error("SSE stream error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Failed to establish notification stream",
      });
    }
  }
};

// Helper function to broadcast notification to connected clients
export const broadcastNotification = async (notification) => {
  try {
    const recipientId = String(notification.recipientId);

    // Find all active connections for this user
    const userConnections = Array.from(activeConnections.entries())
      .filter(([id, conn]) =>
        String(conn.userId) === recipientId
      );

    if (userConnections.length === 0) {
      return { delivered: 0, unavailable: true };
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

    let delivered = 0;
    userConnections.forEach(([connectionId, conn]) => {
      try {
        if (!conn.res.destroyed) {
          conn.res.write(`data: ${JSON.stringify(notificationData)}\n\n`);
          delivered += 1;
          console.info(`[notification-realtime] delivered connection=${connectionId}`);
        } else {
          activeConnections.delete(connectionId);
        }
      } catch (error) {
        console.error(`[notification-realtime] write failed connection=${connectionId}:`, error.message);
        activeConnections.delete(connectionId);
      }
    });

    // Update unread count for all user's connections
    const unreadCount = await Notification.countDocuments({
      $or: [
        { recipientId },
        { recipientId }
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
        console.error(`[notification-realtime] unread write failed connection=${connectionId}:`, error.message);
        activeConnections.delete(connectionId);
      }
    });
    return { delivered, unavailable: false };

  } catch (error) {
    console.error('[notification-realtime] broadcast failed:', error.message);
    return { delivered: 0, unavailable: true };
  }
};
