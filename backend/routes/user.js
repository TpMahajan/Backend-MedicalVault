import express from 'express';
import { 
  updateProfile, 
  updateFCMToken, 
  getUserProfile, 
  deleteAccount 
} from '../controllers/userController.js';
import { 
  updateProfileValidation, 
  fcmTokenValidation 
} from '../middleware/validation.js';
import { auth, optionalAuth } from '../middleware/auth.js';
import { fcmLimiter } from '../middleware/rateLimit.js';
import { User } from '../models/User.js';
import { checkSession } from '../middleware/checkSession.js';

const router = express.Router();

// Note: Not all routes require authentication - getUserProfile is public

// @route   PUT /api/users/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, updateProfileValidation, updateProfile);

// @route   PUT /api/users/fcm-token
// @desc    Update FCM token
// @access  Private
router.put('/fcm-token', auth, fcmLimiter, fcmTokenValidation, updateFCMToken);

// @route   GET /api/users/:id
// @desc    Get user profile by ID (public info)
// @access  Public (no auth required) - but doctors need active session
router.get('/:id', optionalAuth, checkSession, getUserProfile);

// @route   DELETE /api/users/account
// @desc    Delete user account
// @access  Private
router.delete('/account', auth, deleteAccount);

// @route   GET /api/users/:id/records
// @desc    Get user's medical records grouped by category (for web app)
// @access  Private - doctors need active session
router.get('/:id/records', auth, checkSession, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('medicalRecords');
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    const records = user.medicalRecords || [];

    // Group records by category
    const grouped = {
      reports: records.filter((record) => record.category?.toLowerCase() === "report"),
      prescriptions: records.filter((record) => record.category?.toLowerCase() === "prescription"),
      bills: records.filter((record) => record.category?.toLowerCase() === "bill"),
      insurance: records.filter((record) => record.category?.toLowerCase() === "insurance"),
    };

    // Add URL field for frontend compatibility
    const groupedWithUrl = Object.fromEntries(
      Object.entries(grouped).map(([key, docs]) => [
        key,
        docs.map((doc) => ({
          ...doc.toObject(),
          url: doc.cloudinaryUrl,
        })),
      ])
    );

    const response = {
      success: true,
      counts: Object.fromEntries(
        Object.entries(groupedWithUrl).map(([k, v]) => [k, v.length])
      ),
      records: groupedWithUrl,
    };

    res.json(response);
  } catch (err) {
    console.error("Error fetching user records:", err);
    res.status(500).json({ success: false, msg: "Error fetching records", error: err.message });
  }
});

export default router;
