import mongoose from "mongoose";
import { LostPersonReport } from "../models/LostPersonReport.js";
import { FoundPersonReport } from "../models/FoundPersonReport.js";
import { LostFoundMatch } from "../models/LostFoundMatch.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { sendPushNotification } from "../config/firebase.js";
import { generateSignedUrl } from "../utils/s3Utils.js";
import { BUCKET_NAME } from "../config/s3.js";

const LOST_STATUS_VALUES = [
  "open",
  "under_review",
  "matched",
  "found",
  "resolved",
  "closed",
];

const MATCH_ACTION_STATUS_VALUES = [
  "notification_sent",
  "match_confirmed",
  "match_rejected",
];

const MATCH_STATUS_VALUES = ["suggested", "confirmed", "rejected"];
const GENDER_VALUES = ["Male", "Female", "Other", "Unknown"];
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const asText = (value) => (value == null ? "" : String(value).trim());

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const parseDateStart = (value) => {
  const text = asText(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
};

const parseDateEnd = (value) => {
  const text = asText(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setHours(23, 59, 59, 999);
  return parsed;
};

const parseCsv = (value) =>
  asText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeLostStatus = (value) => {
  const raw = asText(value).toLowerCase().replace(/\s+/g, "_");
  if (!raw) return "";

  const aliasMap = {
    open: "open",
    under_review: "under_review",
    underreview: "under_review",
    review: "under_review",
    matched: "matched",
    found: "found",
    resolved: "resolved",
    close: "closed",
    closed: "closed",
  };

  const normalized = aliasMap[raw] || raw;
  return LOST_STATUS_VALUES.includes(normalized) ? normalized : "";
};

const normalizeGender = (value) => {
  const raw = asText(value).toLowerCase();
  if (!raw) return "";
  const mapped =
    raw === "male"
      ? "Male"
      : raw === "female"
        ? "Female"
        : raw === "other"
          ? "Other"
          : raw === "unknown"
            ? "Unknown"
            : "";
  return GENDER_VALUES.includes(mapped) ? mapped : "";
};

const normalizeReportType = (value) => {
  const raw = asText(value).toLowerCase().replace(/\s+/g, "_");
  if (!raw || raw === "all") return "";

  if (["medicalvault_profile", "medical_vault_profile", "profile"].includes(raw)) {
    return "medicalvault_profile";
  }
  if (["family_friend", "family", "friend"].includes(raw)) {
    return "family_friend";
  }
  return "";
};

const mapMatchActionStatus = (value) => {
  if (LOST_STATUS_VALUES.includes(value)) return value;
  if (MATCH_ACTION_STATUS_VALUES.includes(value)) return value;
  return "open";
};

const getAdminName = (req) => {
  const adminName = asText(req.admin?.name);
  if (adminName) return adminName;
  const adminEmail = asText(req.admin?.email);
  if (adminEmail) return adminEmail;
  return "Admin";
};

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(asText(value));

const buildMatchFilters = (query) => {
  const matchQuery = {};

  const statuses = parseCsv(query.status)
    .map((entry) => asText(entry).toLowerCase())
    .filter((entry) => MATCH_STATUS_VALUES.includes(entry));

  if (statuses.length) {
    matchQuery.status = { $in: statuses };
  } else if (asText(query.status).toLowerCase() !== "all") {
    matchQuery.status = "suggested";
  }

  const lostReportId = asText(query.lostReportId);
  if (isObjectId(lostReportId)) {
    matchQuery.lostReportId = lostReportId;
  }

  const foundReportId = asText(query.foundReportId);
  if (isObjectId(foundReportId)) {
    matchQuery.foundReportId = foundReportId;
  }

  return matchQuery;
};

const resolvePhotoUrl = async (photoUrl) => {
  const text = asText(photoUrl);
  if (!text) return "";

  if (text.startsWith("http://") || text.startsWith("https://")) {
    if (text.includes(".s3.") && text.includes(BUCKET_NAME)) {
      try {
        const urlParts = text.split("/");
        const keyIndex = urlParts.findIndex((part) => part.includes(".s3."));
        if (keyIndex !== -1 && keyIndex < urlParts.length - 1) {
          const s3Key = urlParts.slice(keyIndex + 1).join("/");
          return await generateSignedUrl(s3Key, BUCKET_NAME, 3600 * 24 * 7);
        }
      } catch (error) {
        console.error("resolvePhotoUrl (url) error:", error);
      }
    }
    return text;
  }

  try {
    return await generateSignedUrl(text, BUCKET_NAME, 3600 * 24 * 7);
  } catch (error) {
    console.error("resolvePhotoUrl (key) error:", error);
    return text;
  }
};

const enrichLostReportMedia = async (report) => {
  if (!report) return null;

  const output = { ...report };
  output.photoUrl = await resolvePhotoUrl(output.photoUrl);

  if (output.lostPersonUserId?.profilePicture) {
    output.lostPersonUserId = {
      ...output.lostPersonUserId,
      profilePicture: await resolvePhotoUrl(output.lostPersonUserId.profilePicture),
    };
  }

  if (output.reportedByUserId?.profilePicture) {
    output.reportedByUserId = {
      ...output.reportedByUserId,
      profilePicture: await resolvePhotoUrl(output.reportedByUserId.profilePicture),
    };
  }

  if (output.matchedFoundReportId?.photoUrl) {
    output.matchedFoundReportId = {
      ...output.matchedFoundReportId,
      photoUrl: await resolvePhotoUrl(output.matchedFoundReportId.photoUrl),
    };
  }

  return output;
};

const enrichMatchMedia = async (match) => {
  if (!match) return null;
  const output = { ...match };

  if (output.lostReportId?.photoUrl) {
    output.lostReportId = {
      ...output.lostReportId,
      photoUrl: await resolvePhotoUrl(output.lostReportId.photoUrl),
    };
  }

  if (output.foundReportId?.photoUrl) {
    output.foundReportId = {
      ...output.foundReportId,
      photoUrl: await resolvePhotoUrl(output.foundReportId.photoUrl),
    };
  }

  return output;
};

const deriveReportType = (report) => {
  const explicitType = asText(report.reportForType).toLowerCase();
  if (["medicalvault_profile", "family_friend"].includes(explicitType)) {
    return explicitType;
  }
  return report?.lostPersonUserId ? "medicalvault_profile" : "family_friend";
};

const extractReporter = (report) => {
  const reporterUser = report?.reportedByUserId || {};
  const emergencyPhone = asText(reporterUser?.emergencyContact?.phone);

  return {
    name: asText(report?.reporterName) || asText(reporterUser?.name),
    phone:
      asText(report?.reporterPhone) ||
      asText(reporterUser?.mobile) ||
      emergencyPhone,
    alternateContact: asText(report?.alternateContact) || emergencyPhone,
    email: asText(report?.reporterEmail) || asText(reporterUser?.email),
    relationshipToPerson: asText(report?.relationshipToPerson),
  };
};

const extractAddress = (report) => {
  const segments = [
    asText(report?.address),
    asText(report?.area),
    asText(report?.landmark),
    [asText(report?.city), asText(report?.state), asText(report?.pincode)]
      .filter(Boolean)
      .join(", "),
  ].filter(Boolean);

  return {
    address: asText(report?.address),
    area: asText(report?.area),
    city: asText(report?.city),
    state: asText(report?.state),
    pincode: asText(report?.pincode),
    landmark: asText(report?.landmark),
    fullAddress: segments.join("\n"),
    lastSeenLocationText: asText(report?.lastSeenLocationText),
  };
};

const toAdminReportPayload = (report, matchStats = {}) => {
  const reporter = extractReporter(report);
  const address = extractAddress(report);
  const actionHistory = Array.isArray(report?.actionHistory)
    ? [...report.actionHistory].sort(
        (a, b) => new Date(b?.changedAt || 0).getTime() - new Date(a?.changedAt || 0).getTime()
      )
    : [];

  const coordinates = Array.isArray(report?.lastSeenLocation?.coordinates)
    ? report.lastSeenLocation.coordinates
    : [];

  const reportId = asText(report?._id);
  const suggested = matchStats[reportId] || { count: 0, maxScore: 0 };

  return {
    ...report,
    reportId,
    normalizedStatus: normalizeLostStatus(report?.status) || "open",
    normalizedReportType: deriveReportType(report),
    reporter,
    address,
    actionHistory,
    lastSeenGeo:
      coordinates.length === 2
        ? { lng: Number(coordinates[0]), lat: Number(coordinates[1]) }
        : null,
    suggestedMatches: {
      count: Number(suggested.count || 0),
      maxScore: Number(suggested.maxScore || 0),
    },
  };
};

const buildLostReportQuery = async (params) => {
  const conditions = [];

  const statuses = parseCsv(params.status)
    .map(normalizeLostStatus)
    .filter(Boolean);
  if (statuses.length) {
    conditions.push({ status: { $in: statuses } });
  }

  const reportType = normalizeReportType(params.reportType);
  if (reportType === "medicalvault_profile") {
    conditions.push({
      $or: [
        { reportForType: "medicalvault_profile" },
        { lostPersonUserId: { $exists: true, $ne: null } },
      ],
    });
  }
  if (reportType === "family_friend") {
    conditions.push({
      $or: [
        { reportForType: "family_friend" },
        {
          $and: [
            {
              $or: [
                { reportForType: { $exists: false } },
                { reportForType: "unknown" },
              ],
            },
            {
              $or: [
                { lostPersonUserId: { $exists: false } },
                { lostPersonUserId: null },
              ],
            },
          ],
        },
      ],
    });
  }

  const gender = normalizeGender(params.gender);
  if (gender) {
    conditions.push({ gender });
  }

  const fromDate = parseDateStart(params.from);
  const toDate = parseDateEnd(params.to);
  if (fromDate || toDate) {
    const createdAt = {};
    if (fromDate) createdAt.$gte = fromDate;
    if (toDate) createdAt.$lte = toDate;
    conditions.push({ createdAt });
  }

  const search = asText(params.search);
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    const searchConditions = [
      { personName: regex },
      { reporterName: regex },
      { reporterPhone: regex },
      { alternateContact: regex },
      { reporterEmail: regex },
      { city: regex },
      { state: regex },
      { pincode: regex },
      { area: regex },
      { address: regex },
      { lastSeenLocationText: regex },
      { selectedProfileName: regex },
      { internalNotes: regex },
      { adminRemarks: regex },
      { matchNotes: regex },
    ];

    if (isObjectId(search)) {
      searchConditions.push({ _id: search });
    }

    const matchedUsers = await User.find({
      $or: [{ name: regex }, { email: regex }, { mobile: regex }],
    })
      .select("_id")
      .limit(100)
      .lean();

    if (matchedUsers.length > 0) {
      searchConditions.push({
        reportedByUserId: { $in: matchedUsers.map((entry) => entry._id) },
      });
      searchConditions.push({
        lostPersonUserId: { $in: matchedUsers.map((entry) => entry._id) },
      });
    }

    conditions.push({ $or: searchConditions });
  }

  if (conditions.length === 0) {
    return {};
  }
  if (conditions.length === 1) {
    return conditions[0];
  }
  return { $and: conditions };
};

const appendReportAction = ({
  report,
  action,
  status,
  note = "",
  location = "",
  message = "",
  req,
}) => {
  const actionEntry = {
    action: asText(action) || "status_updated",
    status: mapMatchActionStatus(status),
    note: asText(note),
    location: asText(location),
    message: asText(message),
    changedByAdminId: req.admin?._id || null,
    changedByName: getAdminName(req),
    changedAt: new Date(),
  };

  if (!Array.isArray(report.actionHistory)) {
    report.actionHistory = [];
  }
  report.actionHistory.push(actionEntry);
};

const hydrateReportById = async (reportId) => {
  const report = await LostPersonReport.findById(reportId)
    .populate("reportedByUserId", "name email mobile emergencyContact profilePicture")
    .populate("lostPersonUserId", "name email mobile gender age profilePicture")
    .populate(
      "matchedFoundReportId",
      "_id approxAge gender description currentLocation foundTime photoUrl condition status createdAt updatedAt"
    )
    .populate("assignedAdminId", "name email role")
    .lean();

  if (!report) return null;
  return enrichLostReportMedia(report);
};

export const getSummary = async (req, res) => {
  try {
    const [
      totalLostReports,
      openReports,
      foundResolvedReports,
      unmatchedFoundReports,
      suggestedMatches,
      notificationsSent,
    ] = await Promise.all([
      LostPersonReport.countDocuments({}),
      LostPersonReport.countDocuments({
        status: { $in: ["open", "under_review", "matched"] },
      }),
      LostPersonReport.countDocuments({ status: { $in: ["found", "resolved"] } }),
      FoundPersonReport.countDocuments({ status: "unmatched" }),
      LostFoundMatch.countDocuments({ status: "suggested" }),
      Notification.countDocuments({ "data.module": "lost_found" }),
    ]);

    res.json({
      success: true,
      summary: {
        totalLostReports,
        openReports,
        foundResolvedReports,
        unmatchedFoundReports,
        suggestedMatches,
        notificationsSent,
        openLostCount: openReports,
        unmatchedFoundCount: unmatchedFoundReports,
        suggestedMatchesCount: suggestedMatches,
      },
    });
  } catch (error) {
    console.error("getSummary error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load lost & found summary",
    });
  }
};

export const listReports = async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(
      parsePositiveInt(req.query.limit, DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE
    );
    const sort = asText(req.query.sort).toLowerCase() === "oldest" ? 1 : -1;

    const query = await buildLostReportQuery(req.query);

    const [total, reports] = await Promise.all([
      LostPersonReport.countDocuments(query),
      LostPersonReport.find(query)
        .sort({ createdAt: sort, _id: sort })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("reportedByUserId", "name email mobile emergencyContact profilePicture")
        .populate("lostPersonUserId", "name email mobile gender age profilePicture")
        .populate(
          "matchedFoundReportId",
          "_id approxAge gender description currentLocation foundTime photoUrl condition status createdAt updatedAt"
        )
        .populate("assignedAdminId", "name email role")
        .lean(),
    ]);

    const reportIds = reports.map((entry) => entry._id);
    let matchStatsByReportId = {};

    if (reportIds.length > 0) {
      const matchStats = await LostFoundMatch.aggregate([
        {
          $match: {
            status: "suggested",
            lostReportId: { $in: reportIds },
          },
        },
        {
          $group: {
            _id: "$lostReportId",
            count: { $sum: 1 },
            maxScore: { $max: "$score" },
          },
        },
      ]);

      matchStatsByReportId = matchStats.reduce((acc, row) => {
        acc[asText(row._id)] = {
          count: Number(row.count || 0),
          maxScore: Number(row.maxScore || 0),
        };
        return acc;
      }, {});
    }

    const reportsWithMedia = await Promise.all(
      reports.map((report) => enrichLostReportMedia(report))
    );

    const items = reportsWithMedia.map((report) =>
      toAdminReportPayload(report, matchStatsByReportId)
    );

    res.json({
      success: true,
      data: {
        reports: items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
    });
  } catch (error) {
    console.error("listReports error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lost person reports",
    });
  }
};

export const updateReportStatus = async (req, res) => {
  try {
    const reportId = asText(req.params.id);
    if (!isObjectId(reportId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid report ID",
      });
    }

    const status = normalizeLostStatus(req.body?.status);
    if (!status) {
      return res.status(400).json({
        success: false,
        message: "A valid status is required",
      });
    }

    const report = await LostPersonReport.findById(reportId);
    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Lost person report not found",
      });
    }

    const previousStatus = normalizeLostStatus(report.status) || "open";

    report.status = status;

    if (status === "found" && !report.foundAt) {
      report.foundAt = new Date();
    }
    if (status === "resolved" && !report.resolvedAt) {
      report.resolvedAt = new Date();
    }
    if (status === "closed" && !report.closedAt) {
      report.closedAt = new Date();
    }

    const foundLocation = asText(req.body?.foundLocation);
    const note = asText(req.body?.note);
    if (foundLocation) {
      report.foundLocation = foundLocation;
    }
    if (note) {
      report.foundNotes = note;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "internalNotes")) {
      report.internalNotes = asText(req.body?.internalNotes);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "adminRemarks")) {
      report.adminRemarks = asText(req.body?.adminRemarks);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "matchNotes")) {
      report.matchNotes = asText(req.body?.matchNotes);
    }

    const incomingAssignedAdmin = asText(req.body?.assignedAdminId);
    if (incomingAssignedAdmin && isObjectId(incomingAssignedAdmin)) {
      report.assignedAdminId = incomingAssignedAdmin;
    } else if (!report.assignedAdminId && req.admin?._id) {
      report.assignedAdminId = req.admin._id;
    }

    appendReportAction({
      report,
      action: "status_updated",
      status,
      note,
      location: foundLocation,
      message: `Status updated from ${previousStatus} to ${status}`,
      req,
    });

    await report.save();

    const hydrated = await hydrateReportById(reportId);

    res.json({
      success: true,
      message: "Report status updated",
      data: {
        report: toAdminReportPayload(hydrated || report.toObject()),
        previousStatus,
      },
    });
  } catch (error) {
    console.error("updateReportStatus error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update report status",
    });
  }
};

export const sendReporterNotification = async (req, res) => {
  try {
    const reportId = asText(req.params.id);
    if (!isObjectId(reportId)) {
      return res.status(400).json({ success: false, message: "Invalid report ID" });
    }

    const report = await LostPersonReport.findById(reportId);
    if (!report) {
      return res
        .status(404)
        .json({ success: false, message: "Lost person report not found" });
    }

    const recipientUserId = asText(report.reportedByUserId);
    if (!isObjectId(recipientUserId)) {
      return res.status(400).json({
        success: false,
        message: "Reporter account is not available for notifications",
      });
    }

    const foundLocation = asText(req.body?.foundLocation) || asText(report.foundLocation);
    const customMessage = asText(req.body?.message);
    const statusLabel = normalizeLostStatus(report.status) || "open";

    const title =
      asText(req.body?.title) ||
      (statusLabel === "found" || statusLabel === "resolved"
        ? "Lost Person Update: Person Found"
        : "Lost Person Report Update");

    const body =
      customMessage ||
      (statusLabel === "found" || statusLabel === "resolved"
        ? `Your reported person has been marked as ${statusLabel}.${foundLocation ? ` Found location: ${foundLocation}.` : ""}`
        : `Your lost person report is now ${statusLabel.replace(/_/g, " ")}.`);

    const notification = await Notification.create({
      title,
      body,
      type: "system",
      data: {
        module: "lost_found",
        reportId,
        status: statusLabel,
        foundLocation,
      },
      recipientId: recipientUserId,
      recipientRole: "patient",
      senderId: req.admin?._id || req.auth?.id || "system",
      senderRole: "admin",
      fcmSent: false,
    });

    let push = { success: false, error: "No FCM token" };
    const reporter = await User.findById(recipientUserId).select("fcmToken").lean();
    if (reporter?.fcmToken) {
      push = await sendPushNotification(reporter.fcmToken, { title, body }, {
        module: "lost_found",
        reportId,
        status: statusLabel,
      });
    }

    if (push.success) {
      notification.fcmSent = true;
      notification.fcmMessageId = asText(push.messageId);
      await notification.save();
    }

    report.notificationStatus = {
      sent: true,
      lastSentAt: new Date(),
      lastMessage: body,
      sentByAdminId: req.admin?._id || null,
    };

    appendReportAction({
      report,
      action: "notification_sent",
      status: "notification_sent",
      note: asText(req.body?.note),
      location: foundLocation,
      message: body,
      req,
    });

    await report.save();

    try {
      const notificationModule = await import("./notificationController.js");
      if (typeof notificationModule.broadcastNotification === "function") {
        await notificationModule.broadcastNotification(notification);
      }
    } catch (broadcastError) {
      console.error("sendReporterNotification broadcast error:", broadcastError);
    }

    res.json({
      success: true,
      message: "Notification sent to reporter",
      data: {
        notificationId: notification._id,
        pushSent: Boolean(push.success),
        pushError: push.success ? "" : asText(push.error),
      },
    });
  } catch (error) {
    console.error("sendReporterNotification error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send notification",
    });
  }
};

export const listMatches = async (req, res) => {
  try {
    const matchQuery = buildMatchFilters(req.query);
    const limit = Math.min(parsePositiveInt(req.query.limit, 50), 200);

    const matches = await LostFoundMatch.find(matchQuery)
      .sort({ score: -1, createdAt: -1 })
      .limit(limit)
      .populate(
        "lostReportId",
        "_id personName approxAge gender description clothingDescription identificationDetails medicalNotes lastSeenLocation lastSeenLocationText lastSeenTime photoUrl status city state pincode createdAt updatedAt"
      )
      .populate(
        "foundReportId",
        "_id approxAge gender description currentLocation foundTime photoUrl condition status currentHospitalId createdAt updatedAt"
      )
      .populate("reviewedByAdminId", "name email")
      .lean();

    const items = await Promise.all(matches.map((entry) => enrichMatchMedia(entry)));

    res.json({
      success: true,
      data: { matches: items },
    });
  } catch (error) {
    console.error("listMatches error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lost & found matches",
    });
  }
};

export const confirmMatch = async (req, res) => {
  try {
    const matchId = asText(req.params.id);
    const match = await LostFoundMatch.findById(matchId);
    if (!match) {
      return res
        .status(404)
        .json({ success: false, message: "Match suggestion not found" });
    }

    match.status = "confirmed";
    match.reviewedByAdminId = req.admin?._id || null;
    match.reviewedAt = new Date();
    await match.save();

    const actionTime = new Date();

    await Promise.all([
      LostPersonReport.findByIdAndUpdate(
        match.lostReportId,
        {
          status: "matched",
          matchedFoundReportId: match.foundReportId,
          assignedAdminId: req.admin?._id || null,
          $push: {
            actionHistory: {
              action: "match_confirmed",
              status: "match_confirmed",
              note: "Suggested match accepted",
              message: `Match confirmed with confidence ${Math.round(
                Number(match.score || 0)
              )}%`,
              changedByAdminId: req.admin?._id || null,
              changedByName: getAdminName(req),
              changedAt: actionTime,
            },
          },
        },
        { new: true }
      ),
      FoundPersonReport.findByIdAndUpdate(match.foundReportId, {
        status: "matched",
        matchedLostReportId: match.lostReportId,
      }),
      LostFoundMatch.updateMany(
        {
          _id: { $ne: match._id },
          $or: [
            { lostReportId: match.lostReportId },
            { foundReportId: match.foundReportId },
          ],
          status: "suggested",
        },
        {
          $set: {
            status: "rejected",
            reviewedByAdminId: req.admin?._id || null,
            reviewedAt: actionTime,
          },
        }
      ),
    ]);

    res.json({
      success: true,
      message: "Match confirmed",
    });
  } catch (error) {
    console.error("confirmMatch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to confirm match",
    });
  }
};

export const rejectMatch = async (req, res) => {
  try {
    const matchId = asText(req.params.id);
    const match = await LostFoundMatch.findById(matchId);
    if (!match) {
      return res
        .status(404)
        .json({ success: false, message: "Match suggestion not found" });
    }

    match.status = "rejected";
    match.reviewedByAdminId = req.admin?._id || null;
    match.reviewedAt = new Date();
    await match.save();

    await LostPersonReport.findByIdAndUpdate(match.lostReportId, {
      $push: {
        actionHistory: {
          action: "match_rejected",
          status: "match_rejected",
          note: "Suggested match rejected",
          message: "Suggested match was rejected by admin",
          changedByAdminId: req.admin?._id || null,
          changedByName: getAdminName(req),
          changedAt: new Date(),
        },
      },
    });

    res.json({
      success: true,
      message: "Match rejected",
    });
  } catch (error) {
    console.error("rejectMatch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reject match",
    });
  }
};
