import { LostPersonReport } from "../models/LostPersonReport.js";
import { FoundPersonReport } from "../models/FoundPersonReport.js";
import { User } from "../models/User.js";
import { matchFoundToLost } from "../services/lostFoundMatcher.js";

const parseCoordinate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const buildPoint = (lat, lng) => {
  const parsedLat = parseCoordinate(lat);
  const parsedLng = parseCoordinate(lng);
  if (parsedLat === null || parsedLng === null) return undefined;
  return {
    type: "Point",
    coordinates: [parsedLng, parsedLat],
  };
};

const parseDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const createLostReport = async (req, res) => {
  try {
    const {
      lostPersonUserId,
      photoUrl,
      photoSource = "unknown",
      personName,
      approxAge,
      gender,
      description,
      lastSeenLat,
      lastSeenLng,
      lastSeenTime,
      medicalNotes,
    } = req.body;

    let resolvedPhotoUrl = photoUrl;
    let resolvedName = personName;

    if (photoSource === "vault_profile") {
      if (!lostPersonUserId) {
        return res.status(400).json({
          success: false,
          message:
            "lostPersonUserId is required when photoSource is vault_profile",
        });
      }

      const linkedUser = await User.findById(lostPersonUserId).select(
        "profilePicture name"
      );
      if (!linkedUser) {
        return res.status(404).json({
          success: false,
          message: "Linked MedicalVault profile not found",
        });
      }
      if (!linkedUser.profilePicture) {
        return res.status(400).json({
          success: false,
          message:
            "Linked profile does not have a profile picture. Upload a photo instead.",
        });
      }

      resolvedPhotoUrl = linkedUser.profilePicture;
      if (!resolvedName) {
        resolvedName = linkedUser.name;
      }
    } else if (photoSource === "uploaded_family") {
      if (!resolvedPhotoUrl) {
        return res.status(400).json({
          success: false,
          message: "photoUrl is required when using uploaded photo",
        });
      }
    }

    const location = buildPoint(lastSeenLat, lastSeenLng);
    const seenTime = parseDateOrNull(lastSeenTime);
    if (lastSeenTime && !seenTime) {
      return res.status(400).json({
        success: false,
        message: "Invalid lastSeenTime. Provide a valid ISO date.",
      });
    }

    const payload = {
      reportedByUserId: req.user?._id || req.auth?.id,
      lostPersonUserId: lostPersonUserId || null,
      personName: resolvedName,
      approxAge:
        approxAge !== undefined && approxAge !== null
          ? Number(approxAge)
          : undefined,
      gender: gender || "Unknown",
      description,
      lastSeenLocation: location,
      lastSeenTime: seenTime || undefined,
      photoUrl: resolvedPhotoUrl,
      photoSource,
      medicalNotes,
    };

    const lostReport = await LostPersonReport.create(payload);

    res.status(201).json({
      success: true,
      message: "Lost person report created",
      data: { lostReport },
    });
  } catch (error) {
    console.error("createLostReport error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create lost person report",
    });
  }
};

export const createFoundReport = async (req, res) => {
  try {
    const {
      approxAge,
      gender,
      description,
      condition,
      currentLat,
      currentLng,
      foundTime,
      currentHospitalId,
      photoUrl,
    } = req.body;

    const location = buildPoint(currentLat, currentLng);
    if (!location) {
      return res.status(400).json({
        success: false,
        message: "Valid currentLat and currentLng are required",
      });
    }

    if (!photoUrl) {
      return res.status(400).json({
        success: false,
        message: "photoUrl is required for found person reports",
      });
    }

    const parsedFoundTime = parseDateOrNull(foundTime) || new Date();

    const foundReport = await FoundPersonReport.create({
      reportedByUserId: req.user?._id || req.auth?.id,
      currentLocation: location,
      foundTime: parsedFoundTime,
      currentHospitalId: currentHospitalId || null,
      approxAge:
        approxAge !== undefined && approxAge !== null
          ? Number(approxAge)
          : undefined,
      gender: gender || "Unknown",
      description,
      condition,
      photoUrl,
    });

    // Run simple matching to suggest possible links
    let matches = [];
    try {
      matches = await matchFoundToLost(foundReport);
    } catch (matchErr) {
      console.error("matchFoundToLost error:", matchErr);
    }

    res.status(201).json({
      success: true,
      message: "Found person report created",
      data: {
        foundReport,
        suggestedMatches: matches.map((m) => ({
          id: m._id,
          lostReportId: m.lostReportId,
          score: m.score,
        })),
      },
    });
  } catch (error) {
    console.error("createFoundReport error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create found person report",
    });
  }
};

export const getMyLostReports = async (req, res) => {
  try {
    const userId = req.user?._id || req.auth?.id;
    const reports = await LostPersonReport.find({
      reportedByUserId: userId,
    })
      .sort({ createdAt: -1 })
      .populate(
        "matchedFoundReportId",
        "approxAge gender description currentLocation foundTime photoUrl condition status"
      );

    res.json({
      success: true,
      data: {
        reports,
      },
    });
  } catch (error) {
    console.error("getMyLostReports error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lost person reports",
    });
  }
};

