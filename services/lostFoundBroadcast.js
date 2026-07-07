import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { LostPersonReport } from "../models/LostPersonReport.js";
import { sendPushNotification } from "../config/firebase.js";

/**
 * Nearby lost-person alert broadcaster.
 *
 * When an open lost-person report is created, notify users within a radius
 * (default 100 km) of the last-seen location. Privacy-first:
 *  - only users who explicitly enabled location sharing and did not opt out,
 *  - who have an FCM token, excluding the reporter,
 *  - the push/in-app payload carries only safe summary fields + reportId;
 *    full details are loaded from the backend after the user taps.
 *
 * Idempotent: an atomic status claim prevents duplicate broadcasts for the
 * same report even under concurrent invocation.
 */

export const DEFAULT_BROADCAST_RADIUS_KM = Number(
  process.env.LOST_FOUND_BROADCAST_RADIUS_KM || 100,
);
export const MAX_BROADCAST_RECIPIENTS = Number(
  process.env.LOST_FOUND_BROADCAST_MAX_RECIPIENTS || 500,
);

const asCoordinates = (report) => {
  const coords = report?.lastSeenLocation?.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return { lng, lat };
};

const safeNotificationImage = (report) => {
  const url = String(report?.notificationImageUrl || report?.photoUrl || "").trim();
  // Only pass an absolute http(s) URL; never a raw key or private path.
  return /^https?:\/\//i.test(url) ? url : "";
};

const summariseArea = (report) =>
  String(
    report?.city ||
      report?.area ||
      report?.lastSeenLocationText ||
      report?.state ||
      "your area",
  ).trim() || "your area";

/**
 * Build the geospatial query for nearby, alert-eligible users.
 * Exported for unit testing (pure).
 */
export const buildNearbyUsersQuery = ({ lng, lat, radiusKm, reporterId }) => {
  const query = {
    fcmToken: { $exists: true, $nin: [null, ""] },
    locationSharingEnabled: true,
    lostPersonAlertsOptOut: { $ne: true },
    lastKnownLocation: {
      $near: {
        $geometry: { type: "Point", coordinates: [lng, lat] },
        $maxDistance: Math.round(Number(radiusKm) * 1000),
      },
    },
  };
  if (reporterId) {
    query._id = { $ne: reporterId };
  }
  return query;
};

const markBroadcast = (reportId, fields) =>
  LostPersonReport.findByIdAndUpdate(reportId, { $set: fields }).catch((error) => {
    console.error("lostFoundBroadcast: failed to update broadcast status", error);
  });

/**
 * Broadcast a lost-person alert to nearby users.
 * @returns {Promise<{status: string, reason?: string, recipientCount?: number}>}
 */
export const broadcastLostPersonAlert = async (report, options = {}) => {
  const radiusKm = Number(options.radiusKm || DEFAULT_BROADCAST_RADIUS_KM);

  if (!report?._id) return { status: "skipped", reason: "no_report" };
  if (report.status && report.status !== "open") {
    return { status: "skipped", reason: "not_open" };
  }

  const coords = asCoordinates(report);
  if (!coords) {
    await markBroadcast(report._id, {
      broadcastStatus: "skipped",
      broadcastRadiusKm: radiusKm,
      broadcastRecipientCount: 0,
    });
    return { status: "skipped", reason: "no_coordinates" };
  }

  // Atomic dedupe claim: only broadcast if not already sent/in-flight.
  const claim = await LostPersonReport.findOneAndUpdate(
    { _id: report._id, broadcastStatus: { $in: [null, "pending", "failed"] } },
    { $set: { broadcastStatus: "processing" } },
    { new: true },
  );
  if (!claim) {
    return { status: "skipped", reason: "already_broadcast" };
  }

  try {
    const recipients = await User.find(
      buildNearbyUsersQuery({
        ...coords,
        radiusKm,
        reporterId: report.reportedByUserId,
      }),
    )
      .select("_id fcmToken")
      .limit(MAX_BROADCAST_RECIPIENTS)
      .lean();

    if (!recipients.length) {
      await markBroadcast(report._id, {
        broadcastStatus: "sent",
        broadcastSentAt: new Date(),
        broadcastRadiusKm: radiusKm,
        broadcastRecipientCount: 0,
      });
      return { status: "sent", recipientCount: 0, pushDelivered: 0 };
    }

    const image = safeNotificationImage(report);
    const area = summariseArea(report);
    const personName = String(report.personName || "A person").trim();
    const title = "Missing person reported nearby";
    const body = `${personName} was last seen near ${area}`;
    const route = `/lost-found/report/${String(report._id)}`;
    const pushData = {
      type: "lost_person_alert",
      reportId: String(report._id),
      route,
      ...(image ? { image } : {}),
    };

    let pushDelivered = 0;
    const notificationDocs = [];

    for (const user of recipients) {
      if (user.fcmToken) {
        const result = await sendPushNotification(
          user.fcmToken,
          { title, body, ...(image ? { image } : {}) },
          pushData,
        ).catch(() => ({ success: false }));
        if (result?.success) pushDelivered += 1;
      }
      notificationDocs.push({
        title,
        body,
        type: "lost_person_alert",
        data: {
          reportId: String(report._id),
          imageUrl: image || null,
          route,
          lastSeenLocation: area,
          createdBy: String(report.reportedByUserId || ""),
        },
        recipientId: user._id,
        recipientRole: "patient",
        senderId: "system",
        senderRole: "system",
      });
    }

    if (notificationDocs.length) {
      await Notification.insertMany(notificationDocs, { ordered: false });
    }

    await markBroadcast(report._id, {
      broadcastStatus: "sent",
      broadcastSentAt: new Date(),
      broadcastRadiusKm: radiusKm,
      broadcastRecipientCount: recipients.length,
    });

    return { status: "sent", recipientCount: recipients.length, pushDelivered };
  } catch (error) {
    console.error("broadcastLostPersonAlert error:", error);
    await markBroadcast(report._id, {
      broadcastStatus: "failed",
      broadcastError: String(error?.message || error).slice(0, 500),
    });
    return { status: "failed", error: String(error?.message || error) };
  }
};

export const constants = {
  DEFAULT_BROADCAST_RADIUS_KM,
  MAX_BROADCAST_RECIPIENTS,
};
