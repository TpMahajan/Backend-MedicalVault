import { User } from "../models/User.js";

// @desc    Update user profile
// @route   PUT /api/user/profile
// @access  Private
export const updateProfile = async (req, res) => {
  try {
    const { name, profilePicture } = req.body;
    const updateData = {};

    if (name !== undefined) updateData.name = name;
    if (profilePicture !== undefined) updateData.profilePicture = profilePicture;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Update FCM token
// @route   PUT /api/user/fcm-token
// @access  Private
export const updateFCMToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;

    await User.findByIdAndUpdate(
      req.user._id,
      { fcmToken },
      { new: true }
    );

    res.json({
      success: true,
      message: 'FCM token updated successfully'
    });
  } catch (error) {
    console.error('Update FCM token error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Get user profile by ID (public info only, full info for doctors with active session)
// @route   GET /api/user/:id
// @access  Public (limited) / Private (full data with session)
export const getUserProfile = async (req, res) => {
  try {
    // Determine access mode
    const authRole = req.auth?.role;
    const authId = req.auth?.id?.toString();
    const isDoctor = authRole === "doctor";
    const isAnonymous = authRole === "anonymous";
    const isSelf = authRole === "patient" && authId === req.params.id;
    const hasActiveSession = isDoctor && !!req.session;
    const mode = isAnonymous ? "anonymous" : isSelf ? "patient" : isDoctor ? "doctor" : "anonymous";
    
    let selectFields = 'name profilePicture createdAt'; // Default limited fields
    
    if (hasActiveSession || isSelf) {
      // Doctor with active session or patient viewing own profile => full data
      selectFields = '-password'; // All fields except password
      console.log('🔐 Returning full patient data (mode:', mode, 'isSelf:', isSelf, 'hasActiveSession:', hasActiveSession, ')');
    } else {
      console.log('👤 Returning limited public profile data (mode:', mode, ')');
    }

    const user = await User.findById(req.params.id)
      .select(selectFields)
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: hasActiveSession || isSelf ? { user } : { user },
      sessionAccess: hasActiveSession,
      mode
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Delete user account
// @route   DELETE /api/user/account
// @access  Private
export const deleteAccount = async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user._id);

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
