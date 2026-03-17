import { User } from "../models/User.js";
import { Session } from "../models/Session.js";
import { Appointment } from "../models/Appointment.js";
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

    // For anonymous access, preserve critical fields BEFORE buildUserResponse
    // because buildUserResponse might not preserve them correctly
    const preservedData = {};
    if (isAnonymous) {
      preservedData.medications = user.medications || [];
      preservedData.medicalHistory = user.medicalHistory || [];
      preservedData.allergies = user.allergies || '';
      preservedData.emergencyContact = user.emergencyContact || {
        name: null,
        relationship: null,
        phone: null
      };
      console.log('👻 Preserving data BEFORE buildUserResponse:', {
        allergies: preservedData.allergies,
        medicationsCount: preservedData.medications.length,
        historyCount: preservedData.medicalHistory.length
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

    // For anonymous access, restore preserved fields AFTER buildUserResponse
    // This ensures they're not lost during processing
    if (isAnonymous && processedUser) {
      // Restore preserved data
      processedUser.medications = preservedData.medications;
      processedUser.medicalHistory = preservedData.medicalHistory;
      processedUser.allergies = preservedData.allergies;
      processedUser.emergencyContact = preservedData.emergencyContact;

      console.log('👻 Restored data AFTER buildUserResponse:', {
        allergies: processedUser.allergies,
        medicationsCount: processedUser.medications.length,
        historyCount: processedUser.medicalHistory.length
      });
    }

    // Debug logging for anonymous access
    if (isAnonymous) {
      console.log('👻 Anonymous access - Raw user data:', JSON.stringify(user, null, 2));
      console.log('👻 Anonymous access - Raw allergies value:', user.allergies, 'type:', typeof user.allergies);
      console.log('👻 Anonymous access - Processed user data:', JSON.stringify(processedUser, null, 2));
      console.log('👻 Anonymous access - Processed allergies value:', processedUser?.allergies, 'type:', typeof processedUser?.allergies);
      console.log('👻 Anonymous access - Medications:', processedUser?.medications);
      console.log('👻 Anonymous access - Medical History:', processedUser?.medicalHistory);
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

// @desc    Get medical card data (public, no auth required)
// @route   GET /api/users/:id/medical-card
// @access  Public
export const getMedicalCard = async (req, res) => {
  try {
    const userId = req.params.id;

    // Select only fields needed for medical card
    const selectFields = 'name profilePicture age gender dateOfBirth bloodType height weight email mobile medications allergies emergencyContact';

    const user = await User.findById(userId)
      .select(selectFields)
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Process user response to get profilePictureUrl
    const processedUser = await buildUserResponse(user);

    // Ensure _id is preserved
    if (processedUser && !processedUser._id && processedUser.id) {
      processedUser._id = processedUser.id;
    }

    res.json({
      success: true,
      data: { user: processedUser }
    });
  } catch (error) {
    console.error('Get medical card error:', error);
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

// @desc    Get all patients
// @route   GET /api/users/all-patients
// @access  Private (for doctors/admins)
export const getAllPatients = async (req, res) => {
  try {
    const { search, status, gender, date, sortBy = 'createdAt', sortOrder = 'desc', page = 1, limit = 8 } = req.query;

    // Build query
    const query = {};
    let activePatientIds = new Set();

    // Filter by patients who have sessions or appointments with the current doctor
    if (req.auth && req.auth.role === 'doctor') {
      const doctorId = req.auth.id;

      // Get unique patient IDs and active sessions
      const [sessionPatientIds, appointmentPatientIds, activeSessions] = await Promise.all([
        Session.distinct('patientId', { doctorId }),
        Appointment.distinct('patientId', { doctorId }),
        Session.find({
          doctorId,
          status: 'accepted',
          expiresAt: { $gt: new Date() }
        }).select('patientId')
      ]);

      const allDoctorPatientIds = [...new Set([
        ...sessionPatientIds.map(id => id.toString()),
        ...appointmentPatientIds.map(id => id?.toString())
      ].filter(Boolean))];

      activePatientIds = new Set(activeSessions.map(s => s.patientId.toString()));

      // Apply status filter based on session activity for doctors
      if (status && status !== 'All') {
        if (status === 'Active') {
          const filteredIds = Array.from(activePatientIds).filter(id => allDoctorPatientIds.includes(id));
          query._id = { $in: filteredIds };
        } else {
          const filteredIds = allDoctorPatientIds.filter(id => !activePatientIds.has(id));
          query._id = { $in: filteredIds };
        }
      } else {
        query._id = { $in: allDoctorPatientIds };
      }
    } else {
      // For non-doctor roles, use the default isActive field for status filtering
      if (status && status !== 'All') {
        query.isActive = status === 'Active';
      }
    }

    // Search by name
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    // Filter by gender
    if (gender && gender !== 'All') {
      query.gender = gender;
    }

    // Filter by date (createdAt)
    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    // Determine sort options
    const sort = {};
    if (sortBy === 'name') {
      sort.name = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'age') {
      sort.age = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'lastVisit') {
      sort.lastVisit = sortOrder === 'asc' ? 1 : -1;
    } else {
      sort.createdAt = sortOrder === 'asc' ? 1 : -1;
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Fetch patients with pagination
    const patients = await User.find(query)
      .select('name email mobile age gender dateOfBirth bloodType lastVisit isActive medicalRecords')
      .populate('medicalRecords', '_id')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get total count for pagination
    const totalPatients = await User.countDocuments(query);

    // Transform data to match frontend format
    const transformedPatients = patients.map(patient => ({
      _id: patient._id,
      id: patient._id.toString(),
      name: patient.name,
      age: patient.age || 0,
      gender: patient.gender || 'Not specified',
      phone: patient.mobile || 'N/A',
      email: patient.email,
      lastVisit: patient.lastVisit || 'N/A',
      documents: patient.medicalRecords ? patient.medicalRecords.length : 0,
      status: activePatientIds.has(patient._id.toString()) ? 'Active' : 'Inactive',
      bloodType: patient.bloodType || 'N/A'
    }));

    res.json({
      success: true,
      data: {
        patients: transformedPatients,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalPatients / parseInt(limit)),
          totalPatients,
          limit: parseInt(limit)
        }
      }
    });
  } catch (error) {
    console.error('Get all patients error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};
