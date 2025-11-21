import { User } from "../models/User.js";
import { buildUserResponse } from "../utils/userResponse.js";

// @desc    Update user profile
// @route   PUT /api/user/profile
// @access  Private
export const updateProfile = async (req, res) => {
  try {
    const { name, profilePicture, allergies } = req.body;
    const updateData = {};

    if (name !== undefined) updateData.name = name;
    if (profilePicture !== undefined) updateData.profilePicture = profilePicture;
    if (allergies !== undefined) {
      updateData.allergies = typeof allergies === "string" ? allergies : "";
    }

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
    
    let selectFields;
    if (hasActiveSession || isSelf) {
      // Doctor with active session or the patient themself
      selectFields = '-password';
      console.log('🔐 Returning full patient data (mode:', mode, 'isSelf:', isSelf, 'hasActiveSession:', hasActiveSession, ')');
    } else if (isAnonymous) {
      // For anonymous access, include medications, medicalHistory, allergies, and emergencyContact
      selectFields = 'name profilePicture age gender dateOfBirth bloodType height weight email mobile createdAt medications medicalHistory allergies emergencyContact';
      console.log('👻 Returning anonymous access data (mode:', mode, ')');
    } else {
      // For all other viewers (including another logged-in patient), return essential demographics
      // This includes mobile to support SOS contact; tighten later with proper admin/doctor roles
      selectFields = 'name profilePicture age gender dateOfBirth bloodType height weight email mobile createdAt';
      console.log('👤 Returning essential demographics (mode:', mode, ')');
    }

    let user = await User.findById(req.params.id)
      .select(selectFields)
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Use buildUserResponse to properly generate profilePictureUrl for all access types
    // Convert lean object back to a document-like object for buildUserResponse
    const userDoc = user;
    let processedUser = await buildUserResponse(userDoc);

    // Ensure _id is preserved for frontend compatibility
    if (processedUser && !processedUser._id && processedUser.id) {
      processedUser._id = processedUser.id;
    }

    // For anonymous access, ensure all fields are preserved from raw user data
    // This is a safety measure in case buildUserResponse doesn't include everything
    if (isAnonymous && processedUser) {
      // Preserve medications, medicalHistory, allergies, and emergencyContact from raw data
      if (user.medications !== undefined) {
        processedUser.medications = Array.isArray(user.medications) ? user.medications : [];
      }
      if (user.medicalHistory !== undefined) {
        processedUser.medicalHistory = Array.isArray(user.medicalHistory) ? user.medicalHistory : [];
      }
      if (user.allergies !== undefined) {
        processedUser.allergies = user.allergies || '';
      }
      if (user.emergencyContact !== undefined) {
        processedUser.emergencyContact = user.emergencyContact || {
          name: null,
          relationship: null,
          phone: null
        };
      }
    }

    // Debug logging for anonymous access
    if (isAnonymous) {
      console.log('👻 Anonymous access - Raw user data:', JSON.stringify(user, null, 2));
      console.log('👻 Anonymous access - Processed user data:', JSON.stringify(processedUser, null, 2));
      console.log('👻 Anonymous access - Medications:', processedUser?.medications);
      console.log('👻 Anonymous access - Medical History:', processedUser?.medicalHistory);
      console.log('👻 Anonymous access - Allergies:', processedUser?.allergies);
      console.log('👻 Anonymous access - Emergency Contact:', processedUser?.emergencyContact);
    }

    res.json({
      success: true,
      data: { user: processedUser },
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
