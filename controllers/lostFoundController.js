import { LostPersonReport } from "../models/LostPersonReport.js";
import { FoundPersonReport } from "../models/FoundPersonReport.js";
import { User } from "../models/User.js";
import {
  matchFoundToLost,
  matchLostToFound,
} from "../services/lostFoundMatcher.js";
import { generateSignedUrl } from "../utils/s3Utils.js";
import { BUCKET_NAME } from "../config/s3.js";

const asText = (value) => (value == null ? "" : String(value).trim());

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

const parseOptionalNumber = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const normalizeGender = (value) => {
  const raw = asText(value).toLowerCase();
  if (raw === "male") return "Male";
  if (raw === "female") return "Female";
  if (raw === "other") return "Other";
  return "Unknown";
};

const runMatcherSoon = (label, matcher) => {
  setImmediate(async () => {
    try {
      await matcher();
    } catch (error) {
      console.error(`${label} error:`, error);
    }
  });
};

const nonEmptyOrUndefined = (value) => {
  const text = asText(value);
  return text ? text : undefined;
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
      reportForType,
      selectedProfileName,
      clothingDescription,
      identificationDetails,
      reporterName,
      reporterPhone,
      alternateContact,
      reporterEmail,
      relationshipToPerson,
      address,
      area,
      city,
      state,
      pincode,
      landmark,
      lastSeenLocationText,
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
        "profilePicture name",
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
      lostPersonUserId: nonEmptyOrUndefined(lostPersonUserId) || null,
      personName: nonEmptyOrUndefined(resolvedName),
      approxAge: parseOptionalNumber(approxAge),
      gender: normalizeGender(gender),
      description: nonEmptyOrUndefined(description),
      lastSeenLocation: location,
      lastSeenTime: seenTime || undefined,
      photoUrl: nonEmptyOrUndefined(resolvedPhotoUrl),
      photoSource,
      reportForType:
        reportForType === "medicalvault_profile" ||
        reportForType === "family_friend"
          ? reportForType
          : lostPersonUserId
            ? "medicalvault_profile"
            : "family_friend",
      selectedProfileName: nonEmptyOrUndefined(selectedProfileName),
      clothingDescription: nonEmptyOrUndefined(clothingDescription),
      identificationDetails: nonEmptyOrUndefined(identificationDetails),
      medicalNotes: nonEmptyOrUndefined(medicalNotes),
      reporterName: nonEmptyOrUndefined(reporterName),
      reporterPhone: nonEmptyOrUndefined(reporterPhone),
      alternateContact: nonEmptyOrUndefined(alternateContact),
      reporterEmail: nonEmptyOrUndefined(reporterEmail),
      relationshipToPerson: nonEmptyOrUndefined(relationshipToPerson),
      address: nonEmptyOrUndefined(address),
      area: nonEmptyOrUndefined(area),
      city: nonEmptyOrUndefined(city),
      state: nonEmptyOrUndefined(state),
      pincode: nonEmptyOrUndefined(pincode),
      landmark: nonEmptyOrUndefined(landmark),
      lastSeenLocationText: nonEmptyOrUndefined(lastSeenLocationText),
    };

    const lostReport = await LostPersonReport.create(payload);

    runMatcherSoon("matchLostToFound", () => matchLostToFound(lostReport));

    res.status(201).json({
      success: true,
      message: "Lost person report created",
      data: { lostReport, matchingQueued: true },
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
      approxAge: parseOptionalNumber(approxAge),
      gender: normalizeGender(gender),
      description: nonEmptyOrUndefined(description),
      condition: nonEmptyOrUndefined(condition),
      photoUrl: nonEmptyOrUndefined(photoUrl),
    });

    runMatcherSoon("matchFoundToLost", () => matchFoundToLost(foundReport));

    res.status(201).json({
      success: true,
      message: "Found person report created",
      data: {
        foundReport,
        suggestedMatches: [],
        matchingQueued: true,
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

// Helper to generate signed URL if photoUrl is an S3 key
const resolvePhotoUrl = async (photoUrl) => {
  if (!photoUrl) return null;
  const text = String(photoUrl).trim();
  if (text.startsWith("/uploads/")) return text;
  if (text.startsWith("uploads/")) return `/${text}`;

  // If it's already a full URL (starts with http/https), return as is
  if (text.startsWith("http://") || text.startsWith("https://")) {
    // Check if it's a direct S3 URL that needs signing
    if (text.includes(".s3.") && text.includes(BUCKET_NAME)) {
      // Extract S3 key from URL
      const urlParts = text.split("/");
      const keyIndex = urlParts.findIndex((part) => part.includes(".s3."));
      if (keyIndex !== -1 && keyIndex < urlParts.length - 1) {
        const s3Key = urlParts.slice(keyIndex + 1).join("/");
        try {
          return await generateSignedUrl(s3Key, BUCKET_NAME, 3600 * 24 * 7); // 7 days
        } catch (err) {
          console.error("Error generating signed URL:", err);
          return text; // Fallback to original
        }
      }
    }
    return text;
  }

  // If it looks like an S3 key (no http), generate signed URL
  try {
    return await generateSignedUrl(text, BUCKET_NAME, 3600 * 24 * 7); // 7 days
  } catch (err) {
    console.error("Error generating signed URL for key:", err);
    return text; // Fallback to original
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
        "approxAge gender description currentLocation foundTime photoUrl condition status",
      );

    // Generate signed URLs for all photo URLs
    const reportsWithSignedUrls = await Promise.all(
      reports.map(async (report) => {
        const reportObj = report.toObject();

        // Resolve main photo URL
        if (reportObj.photoUrl) {
          reportObj.photoUrl = await resolvePhotoUrl(reportObj.photoUrl);
        }

        // Resolve matched report photo URL if exists
        if (reportObj.matchedFoundReportId?.photoUrl) {
          reportObj.matchedFoundReportId.photoUrl = await resolvePhotoUrl(
            reportObj.matchedFoundReportId.photoUrl,
          );
        }

        return reportObj;
      }),
    );

    res.json({
      success: true,
      data: {
        reports: reportsWithSignedUrls,
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
