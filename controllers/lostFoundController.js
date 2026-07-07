import { LostPersonReport } from "../models/LostPersonReport.js";
import { FoundPersonReport } from "../models/FoundPersonReport.js";
import { User } from "../models/User.js";
import {
  matchFoundToLost,
  matchLostToFound,
} from "../services/lostFoundMatcher.js";
import { broadcastLostPersonAlert } from "../services/lostFoundBroadcast.js";
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
      allowReporterContact,
      publicContactName,
      publicContactPhone,
    } = req.body;

    const parseBoolean = (value) => {
      if (typeof value === "boolean") return value;
      const text = asText(value).toLowerCase();
      return ["true", "1", "yes", "on"].includes(text);
    };

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
      allowReporterContact: parseBoolean(allowReporterContact),
      publicContactName: nonEmptyOrUndefined(publicContactName),
      publicContactPhone: nonEmptyOrUndefined(publicContactPhone),
      // Notification-safe image (already a signed/public URL when present).
      notificationImageUrl: /^https?:\/\//i.test(asText(resolvedPhotoUrl))
        ? asText(resolvedPhotoUrl)
        : undefined,
    };

    const lostReport = await LostPersonReport.create(payload);

    runMatcherSoon("matchLostToFound", () => matchLostToFound(lostReport));
    // Nearby 100km alert broadcast (async, non-blocking, idempotent).
    runMatcherSoon("broadcastLostPersonAlert", () =>
      broadcastLostPersonAlert(lostReport),
    );

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
      personName,
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
      personName: nonEmptyOrUndefined(personName),
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

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mask all but the last 3 digits: 98765 43210 -> ******3210 (kept short).
const maskPhone = (value) => {
  const digits = asText(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 3) return "*".repeat(digits.length);
  return `${"*".repeat(Math.max(2, digits.length - 3))}${digits.slice(-3)}`;
};

// Build a privacy-safe public view of a lost report. Never exposes reporter
// phone/email, medical notes, identification details, or linked user ids.
const toPublicLostReport = async (reportObj, { includeContact = false } = {}) => {
  const allowContact = Boolean(reportObj.allowReporterContact);
  const photoUrl = reportObj.photoUrl
    ? await resolvePhotoUrl(reportObj.photoUrl)
    : null;

  const view = {
    id: String(reportObj._id),
    personName: reportObj.personName || null,
    approxAge: reportObj.approxAge ?? null,
    gender: reportObj.gender || "Unknown",
    description: reportObj.description || null,
    clothingDescription: reportObj.clothingDescription || null,
    photoUrl,
    lastSeenLocationText:
      reportObj.lastSeenLocationText ||
      [reportObj.area, reportObj.city, reportObj.state]
        .filter(Boolean)
        .join(", ") ||
      null,
    area: reportObj.area || null,
    city: reportObj.city || null,
    state: reportObj.state || null,
    lastSeenLocation: reportObj.lastSeenLocation || null,
    lastSeenTime: reportObj.lastSeenTime || null,
    status: reportObj.status || "open",
    createdAt: reportObj.createdAt || null,
    allowReporterContact: allowContact,
    contact: null,
  };

  if (allowContact) {
    view.contact = {
      name: reportObj.publicContactName || reportObj.reporterName || null,
      // Masked by default; full number only on explicit detail request.
      maskedPhone: maskPhone(reportObj.publicContactPhone),
      phone:
        includeContact && reportObj.publicContactPhone
          ? reportObj.publicContactPhone
          : null,
    };
  }

  return view;
};

// @desc   Search open lost-person reports (privacy-safe)
// @route  GET /api/lost-found/search
// @access Private
export const searchLostReports = async (req, res) => {
  try {
    const { q, age, gender, location, lat, lng, radiusKm, dateFrom, dateTo } =
      req.query;

    const query = { status: "open" };

    const name = asText(q);
    if (name) {
      query.personName = { $regex: escapeRegex(name), $options: "i" };
    }

    const normalizedGender = normalizeGender(gender);
    if (asText(gender) && normalizedGender !== "Unknown") {
      query.gender = normalizedGender;
    }

    const approxAge = parseOptionalNumber(age);
    if (approxAge !== undefined) {
      query.approxAge = { $gte: approxAge - 5, $lte: approxAge + 5 };
    }

    const loc = asText(location);
    if (loc) {
      const locRegex = { $regex: escapeRegex(loc), $options: "i" };
      query.$or = [
        { lastSeenLocationText: locRegex },
        { area: locRegex },
        { city: locRegex },
        { state: locRegex },
      ];
    }

    const from = parseDateOrNull(dateFrom);
    const to = parseDateOrNull(dateTo);
    if (from || to) {
      query.lastSeenTime = {};
      if (from) query.lastSeenTime.$gte = from;
      if (to) query.lastSeenTime.$lte = to;
    }

    const centerLng = parseCoordinate(lng);
    const centerLat = parseCoordinate(lat);
    const radius = parseOptionalNumber(radiusKm);
    if (centerLng !== null && centerLat !== null) {
      query.lastSeenLocation = {
        $near: {
          $geometry: { type: "Point", coordinates: [centerLng, centerLat] },
          $maxDistance: Math.round((radius || 100) * 1000),
        },
      };
    }

    const reports = await LostPersonReport.find(query)
      .sort(query.lastSeenLocation ? {} : { createdAt: -1 })
      .limit(50)
      .lean();

    const results = await Promise.all(
      reports.map((report) => toPublicLostReport(report)),
    );

    res.json({ success: true, data: { results, count: results.length } });
  } catch (error) {
    console.error("searchLostReports error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to search lost person reports",
    });
  }
};

// @desc   Lightweight name typeahead for open lost-person reports.
// @route  GET /api/lost-found/name-suggestions?q=...
// @access Private
// Optimised: prefix (anchored) regex, name-only projection, deduped, capped.
export const getLostReportNameSuggestions = async (req, res) => {
  try {
    const q = asText(req.query.q);
    // Only search once there is something meaningful to match on.
    if (q.length < 2) {
      return res.json({ success: true, data: { suggestions: [] } });
    }

    const reports = await LostPersonReport.find({
      status: "open",
      personName: { $regex: "^" + escapeRegex(q), $options: "i" },
    })
      .select("personName")
      .sort({ personName: 1 })
      .limit(20)
      .lean();

    const seen = new Set();
    const suggestions = [];
    for (const report of reports) {
      const name = asText(report.personName);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(name);
      if (suggestions.length >= 8) break;
    }

    res.json({ success: true, data: { suggestions } });
  } catch (error) {
    console.error("getLostReportNameSuggestions error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load name suggestions",
    });
  }
};

// @desc   Photo-assisted lost-person search without fake face recognition
// @route  POST /api/lost-found/search-photo
// @access Private
export const searchLostReportsByPhoto = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "A JPG or PNG photo is required for photo-assisted search.",
      });
    }

    const { q, age, gender, location, lat, lng, radiusKm, dateFrom, dateTo } =
      req.body || {};
    const query = {
      status: "open",
      photoUrl: { $exists: true, $ne: "" },
    };

    const name = asText(q);
    if (name) {
      query.personName = { $regex: escapeRegex(name), $options: "i" };
    }

    const normalizedGender = normalizeGender(gender);
    if (asText(gender) && normalizedGender !== "Unknown") {
      query.gender = normalizedGender;
    }

    const approxAge = parseOptionalNumber(age);
    if (approxAge !== undefined) {
      query.approxAge = { $gte: approxAge - 5, $lte: approxAge + 5 };
    }

    const loc = asText(location);
    if (loc) {
      const locRegex = { $regex: escapeRegex(loc), $options: "i" };
      query.$or = [
        { lastSeenLocationText: locRegex },
        { area: locRegex },
        { city: locRegex },
        { state: locRegex },
      ];
    }

    const from = parseDateOrNull(dateFrom);
    const to = parseDateOrNull(dateTo);
    if (from || to) {
      query.lastSeenTime = {};
      if (from) query.lastSeenTime.$gte = from;
      if (to) query.lastSeenTime.$lte = to;
    }

    const centerLng = parseCoordinate(lng);
    const centerLat = parseCoordinate(lat);
    const radius = parseOptionalNumber(radiusKm);
    if (centerLng !== null && centerLat !== null) {
      query.lastSeenLocation = {
        $near: {
          $geometry: { type: "Point", coordinates: [centerLng, centerLat] },
          $maxDistance: Math.round((radius || 100) * 1000),
        },
      };
    }

    const reports = await LostPersonReport.find(query)
      .sort(query.lastSeenLocation ? {} : { createdAt: -1 })
      .limit(25)
      .lean();

    const results = await Promise.all(
      reports.map(async (report) => ({
        ...(await toPublicLostReport(report)),
        matchScore: 0,
        photoMatchAvailable: false,
      })),
    );

    res.json({
      success: true,
      data: {
        results,
        count: results.length,
        photoSearch: {
          enabled: false,
          message:
            "Photo-based face/person matching is not AI-enabled yet. Results are filtered to active lost reports with photos and any text filters you provided.",
        },
      },
    });
  } catch (error) {
    console.error("searchLostReportsByPhoto error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to search lost person reports by photo",
    });
  }
};

// @desc   Get a single lost-person report (privacy-safe detail)
// @route  GET /api/lost-found/lost/:id
// @access Private
export const getLostReportDetail = async (req, res) => {
  try {
    const id = asText(req.params.id);
    if (!/^[a-fA-F0-9]{24}$/.test(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid report id" });
    }

    const report = await LostPersonReport.findById(id).lean();
    if (!report) {
      return res
        .status(404)
        .json({ success: false, message: "Lost person report not found" });
    }

    // Full contact (unmasked) only when the reporter allowed contact sharing.
    const detail = await toPublicLostReport(report, {
      includeContact: Boolean(report.allowReporterContact),
    });

    res.json({ success: true, data: { report: detail } });
  } catch (error) {
    console.error("getLostReportDetail error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lost person report",
    });
  }
};
