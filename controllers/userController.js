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

    const user = await User.findByIdAndUpdate(req.user._id, updateData, {
      new: true,
      runValidators: true,
    }).select("-password");

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: { user },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// @desc    Update FCM token
// @route   PUT /api/user/fcm-token
// @access  Private
export const updateFCMToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;

    await User.findByIdAndUpdate(req.user._id, { fcmToken }, { new: true });

    res.json({
      success: true,
      message: "FCM token updated successfully",
    });
  } catch (error) {
    console.error("Update FCM token error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

const getUserProjection = (authRole) => {
  const role = String(authRole || "").toLowerCase();
  if (role === "admin") {
    // Admin receives minimum necessary demographic profile.
    return "name profilePicture age gender dateOfBirth bloodType email mobile createdAt status";
  }
  return "-password";
};

// @desc    Get user profile by ID
// @route   GET /api/user/:id
// @access  Private (guarded by checkSession middleware)
export const getUserProfile = async (req, res) => {
  try {
    const authRole = String(req.auth?.role || "").toLowerCase();
    const authId = req.auth?.id?.toString();
    const userId = String(req.params.id || "");
    const isSelf = authRole === "patient" && authId === userId;

    const selectFields = getUserProjection(authRole);
    const user = await User.findById(userId).select(selectFields).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const processedUser = await buildUserResponse(user);
    if (processedUser && !processedUser._id && processedUser.id) {
      processedUser._id = processedUser.id;
    }

    res.json({
      success: true,
      data: { user: processedUser },
      mode: isSelf ? "patient" : authRole || "patient",
    });
  } catch (error) {
    console.error("Get user profile error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// @desc    Get medical card data
// @route   GET /api/users/:id/medical-card
// @access  Private (guarded by checkSession middleware)
export const getMedicalCard = async (req, res) => {
  try {
    const userId = String(req.params.id || "");
    const authRole = String(req.auth?.role || "").toLowerCase();

    const selectFields =
      authRole === "admin"
        ? "name profilePicture age gender dateOfBirth bloodType email mobile emergencyContact"
        : "name profilePicture age gender dateOfBirth bloodType height weight email mobile medications allergies emergencyContact";

    const user = await User.findById(userId).select(selectFields).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const processedUser = await buildUserResponse(user);

    if (processedUser && !processedUser._id && processedUser.id) {
      processedUser._id = processedUser.id;
    }

    res.json({
      success: true,
      data: { user: processedUser },
    });
  } catch (error) {
    console.error("Get medical card error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
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
      message: "Account deleted successfully",
    });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// @desc    Get all patients
// @route   GET /api/users/all-patients
// @access  Private (doctor/admin/superadmin)
export const getAllPatients = async (req, res) => {
  try {
    const {
      search,
      status,
      gender,
      date,
      sortBy = "createdAt",
      sortOrder = "desc",
      page = 1,
      limit = 8,
    } = req.query;

    const query = {};
    let activePatientIds = new Set();

    if (req.auth && req.auth.role === "doctor") {
      const doctorId = req.auth.id;

      const [sessionPatientIds, appointmentPatientIds, activeSessions] = await Promise.all([
        Session.distinct("patientId", { doctorId }),
        Appointment.distinct("patientId", { doctorId }),
        Session.find({
          doctorId,
          status: "accepted",
          expiresAt: { $gt: new Date() },
        }).select("patientId"),
      ]);

      const allDoctorPatientIds = [
        ...new Set(
          [
            ...sessionPatientIds.map((id) => id.toString()),
            ...appointmentPatientIds.map((id) => id?.toString()),
          ].filter(Boolean)
        ),
      ];

      activePatientIds = new Set(activeSessions.map((s) => s.patientId.toString()));

      if (status && status !== "All") {
        if (status === "Active") {
          const filteredIds = Array.from(activePatientIds).filter((id) =>
            allDoctorPatientIds.includes(id)
          );
          query._id = { $in: filteredIds };
        } else {
          const filteredIds = allDoctorPatientIds.filter(
            (id) => !activePatientIds.has(id)
          );
          query._id = { $in: filteredIds };
        }
      } else {
        query._id = { $in: allDoctorPatientIds };
      }
    } else {
      if (status && status !== "All") {
        query.isActive = status === "Active";
      }
    }

    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    if (gender && gender !== "All") {
      query.gender = gender;
    }

    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    const sort = {};
    if (sortBy === "name") {
      sort.name = sortOrder === "asc" ? 1 : -1;
    } else if (sortBy === "age") {
      sort.age = sortOrder === "asc" ? 1 : -1;
    } else if (sortBy === "lastVisit") {
      sort.lastVisit = sortOrder === "asc" ? 1 : -1;
    } else {
      sort.createdAt = sortOrder === "asc" ? 1 : -1;
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const patients = await User.find(query)
      .select("name email mobile age gender dateOfBirth bloodType lastVisit isActive medicalRecords")
      .populate("medicalRecords", "_id")
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit, 10))
      .lean();

    const totalPatients = await User.countDocuments(query);

    const transformedPatients = patients.map((patient) => ({
      _id: patient._id,
      id: patient._id.toString(),
      name: patient.name,
      age: patient.age || 0,
      gender: patient.gender || "Not specified",
      phone: patient.mobile || "N/A",
      email: patient.email,
      lastVisit: patient.lastVisit || "N/A",
      documents: patient.medicalRecords ? patient.medicalRecords.length : 0,
      status: activePatientIds.has(patient._id.toString()) ? "Active" : "Inactive",
      bloodType: patient.bloodType || "N/A",
    }));

    res.json({
      success: true,
      data: {
        patients: transformedPatients,
        pagination: {
          currentPage: parseInt(page, 10),
          totalPages: Math.ceil(totalPatients / parseInt(limit, 10)),
          totalPatients,
          limit: parseInt(limit, 10),
        },
      },
    });
  } catch (error) {
    console.error("Get all patients error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
