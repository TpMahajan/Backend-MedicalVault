import { User } from "../models/User.js";
import { Session } from "../models/Session.js";
import { Appointment } from "../models/Appointment.js";
import { buildUserResponse } from "../utils/userResponse.js";

// Baseline fields every doctor may see once any session grant exists, plus
// the exact field(s) each structured-data scope unlocks. A scope absent from
// the active grant means its field(s) must not even be selected from
// MongoDB, not merely omitted from the response — selecting-then-stripping
// risks a future response-shaping change accidentally reintroducing it.
const DOCTOR_BASE_FIELDS = "name profilePicture age gender dateOfBirth bloodType createdAt";
const STRUCTURED_SCOPE_FIELDS = {
  profile: "height weight mobile email",
  allergies: "allergies",
  conditions: "medicalHistory",
  medications: "medications",
  emergencyInformation: "emergencyContact",
  // Appointments live in a separate collection, not a User field — handled
  // separately by any endpoint that reads Appointment directly.
};

const doctorProjectionForGrant = (grant) => {
  const scopes = grant?.structuredDataScopes || [];
  const fields = [DOCTOR_BASE_FIELDS];
  for (const scope of scopes) {
    if (STRUCTURED_SCOPE_FIELDS[scope]) fields.push(STRUCTURED_SCOPE_FIELDS[scope]);
  }
  return fields.join(" ");
};

// @desc    Update user profile
// @route   PUT /api/user/profile
// @access  Private
export const updateProfile = async (req, res) => {
  try {
    const {
      name,
      profilePicture,
      allergies,
      mobile,
      dateOfBirth,
      age,
      gender,
      bloodType,
      height,
      weight,
      lastVisit,
      nextAppointment,
      emergencyContact,
      medicalHistory,
      medications,
      aadhaar,
    } = req.body;
    const updateData = {};

    if (name !== undefined) updateData.name = name;
    if (profilePicture !== undefined)
      updateData.profilePicture = profilePicture;
    if (mobile !== undefined) updateData.mobile = mobile;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth;
    if (age !== undefined) updateData.age = age;
    if (gender !== undefined) updateData.gender = gender;
    if (bloodType !== undefined) updateData.bloodType = bloodType;
    if (height !== undefined) updateData.height = height;
    if (weight !== undefined) updateData.weight = weight;
    if (lastVisit !== undefined) updateData.lastVisit = lastVisit;
    if (nextAppointment !== undefined)
      updateData.nextAppointment = nextAppointment;
    if (aadhaar !== undefined) updateData.aadhaar = aadhaar;
    if (allergies !== undefined) {
      updateData.allergies = typeof allergies === "string" ? allergies : "";
    }
    if (emergencyContact && typeof emergencyContact === "object") {
      updateData.emergencyContact = {
        name: emergencyContact.name ?? null,
        relationship: emergencyContact.relationship ?? null,
        phone:
          emergencyContact.phone ??
          emergencyContact.mobile ??
          emergencyContact.number ??
          null,
      };
    }
    if (Array.isArray(medicalHistory))
      updateData.medicalHistory = medicalHistory;
    if (Array.isArray(medications)) updateData.medications = medications;

    const user = await User.findByIdAndUpdate(req.user._id, updateData, {
      new: true,
      runValidators: true,
    }).select("-password");

    const processedUser = await buildUserResponse(user);

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: { user: processedUser },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// @desc    Update the authenticated user's last known location (opt-in)
// @route   PUT /api/users/location
// @access  Private
export const updateUserLocation = async (req, res) => {
  try {
    const { lat, lng, address, locationSharingEnabled, lostPersonAlertsOptOut } =
      req.body;

    const update = {};

    // Only write coordinates when both are valid numbers in range.
    const latNum = Number(lat);
    const lngNum = Number(lng);
    const hasCoords =
      Number.isFinite(latNum) &&
      Number.isFinite(lngNum) &&
      latNum >= -90 &&
      latNum <= 90 &&
      lngNum >= -180 &&
      lngNum <= 180;

    if (hasCoords) {
      update.lastKnownLocation = {
        type: "Point",
        coordinates: [lngNum, latNum], // GeoJSON order: [lng, lat]
      };
      update.lastKnownLocationUpdatedAt = new Date();
      if (typeof address === "string") {
        update.lastKnownLocationAddress = address.trim() || null;
      }
    } else if (lat !== undefined || lng !== undefined) {
      return res.status(400).json({
        success: false,
        message: "Invalid coordinates. Provide numeric lat/lng in range.",
      });
    }

    if (locationSharingEnabled !== undefined) {
      update.locationSharingEnabled = Boolean(locationSharingEnabled);
    }
    if (lostPersonAlertsOptOut !== undefined) {
      update.lostPersonAlertsOptOut = Boolean(lostPersonAlertsOptOut);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No location fields provided.",
      });
    }

    const user = await User.findByIdAndUpdate(req.user._id, update, {
      new: true,
      runValidators: true,
    }).select(
      "lastKnownLocation lastKnownLocationAddress lastKnownLocationUpdatedAt locationSharingEnabled lostPersonAlertsOptOut",
    );

    res.json({
      success: true,
      message: "Location updated",
      data: {
        locationSharingEnabled: user?.locationSharingEnabled ?? false,
        lostPersonAlertsOptOut: user?.lostPersonAlertsOptOut ?? false,
        lastKnownLocationUpdatedAt: user?.lastKnownLocationUpdatedAt ?? null,
        address: user?.lastKnownLocationAddress ?? null,
      },
    });
  } catch (error) {
    console.error("Update user location error:", error);
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

const getUserProjection = (authRole, req) => {
  const role = String(authRole || "").toLowerCase();
  if (role === "admin") {
    // Admin receives minimum necessary demographic profile.
    return "name profilePicture age gender dateOfBirth bloodType email mobile createdAt status";
  }
  if (role === "doctor") {
    // A doctor's structured-data visibility is scoped exactly to their
    // active SessionAccessGrant — checkSession attaches it as
    // req.sessionAccessGrant, or rejects the request entirely if none
    // exists, so a doctor never reaches this projection ungated.
    return doctorProjectionForGrant(req?.sessionAccessGrant);
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

    const selectFields = getUserProjection(authRole, req);
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
        : authRole === "doctor"
        ? doctorProjectionForGrant(req.sessionAccessGrant)
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

      const [sessionPatientIds, appointmentPatientIds, activeSessions] =
        await Promise.all([
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
          ].filter(Boolean),
        ),
      ];

      activePatientIds = new Set(
        activeSessions.map((s) => s.patientId.toString()),
      );

      if (status && status !== "All") {
        if (status === "Active") {
          const filteredIds = Array.from(activePatientIds).filter((id) =>
            allDoctorPatientIds.includes(id),
          );
          query._id = { $in: filteredIds };
        } else {
          const filteredIds = allDoctorPatientIds.filter(
            (id) => !activePatientIds.has(id),
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
      .select(
        "name email mobile age gender dateOfBirth bloodType lastVisit isActive medicalRecords",
      )
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
      status: activePatientIds.has(patient._id.toString())
        ? "Active"
        : "Inactive",
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
