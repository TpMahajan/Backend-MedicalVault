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
import { auth } from '../middleware/auth.js';
import { fcmLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// @route   PUT /api/user/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', updateProfileValidation, updateProfile);

// @route   PUT /api/user/fcm-token
// @desc    Update FCM token
// @access  Private
router.put('/fcm-token', fcmLimiter, fcmTokenValidation, updateFCMToken);

// @route   GET /api/user/:id
// @desc    Get user profile by ID (public info)
// @access  Public (no auth required)
router.get('/:id', getUserProfile);

// @route   DELETE /api/user/account
// @desc    Delete user account
// @access  Private
router.delete('/account', deleteAccount);

export default router;
