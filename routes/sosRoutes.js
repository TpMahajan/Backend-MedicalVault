import express from "express";
import { auth } from "../middleware/auth.js";
import SOS from "../models/SOS.js";
import { User } from "../models/User.js";
import { SosEvent } from "../models/SosEvent.js";
import { MassIncident } from "../models/MassIncident.js";
import { checkRole } from "../middleware/rbac.js";
import { writeAuditLog } from "../middleware/auditLogger.js";
import { requireAdminPermissions } from "../middleware/adminAuth.js";

const router = express.Router();

const MASS_WINDOW_MINUTES = 10;
const MASS_RADIUS_METERS = 15;
const MASS_THRESHOLD = 8;

const normalizeRole = (role) => String(role || "").toLowerCase();
const asText = (value) => (value == null ? "" : String(value).trim());

const parseDateOrNow = (value) => {
  if (!value) return new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const parseFiniteNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeSource = (value) => {
  const source = asText(value).toLowerCase();
  if (["android", "ios", "web", "patient_app", "doctor_app", "volunteer"].includes(source)) {
    return source;
  }
  return "other";
};

const normalizeNetworkMode = (value) => {
  const mode = asText(value).toLowerCase();
  if (mode === "online" || mode === "offline") return mode;
  return "unknown";
};

const normalizeSyncStatus = (value) => {
  const status = asText(value).toLowerCase();
  if (status === "pending" || status === "failed") return status;
  return "synced";
};

const mapRecipientStatus = (value) => {
  const status = asText(value).toLowerCase();
  if (!status) return "unknown";
  return status.slice(0, 60);
};

const sanitizeRecipients = (items) => {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 25).map((entry) => {
    const item = entry && typeof entry === "object" ? entry : {};
    return {
      name: asText(item.name).slice(0, 120),
      phone: asText(item.phone || item.recipient).slice(0, 32),
      relation: asText(item.relation || item.relationship).slice(0, 80),
      status: mapRecipientStatus(item.status),
      error: asText(item.error || item.errorMessage || item.errorCode).slice(0, 240),
    };
  });
};

const resolveEventLocation = (locationPayload = {}) => {
  const lat = parseFiniteNumber(locationPayload.lat ?? locationPayload.latitude);
  const lng = parseFiniteNumber(locationPayload.lng ?? locationPayload.longitude);
  const accuracy = parseFiniteNumber(locationPayload.accuracy ?? locationPayload.accuracyMeters);
  const hasCoordinates = lat !== null && lng !== null;
  const mapsUrl = hasCoordinates
    ? `https://maps.google.com/?q=${lat},${lng}`
    : asText(locationPayload.mapsUrl);

  return {
    hasCoordinates,
    lat,
    lng,
    accuracy,
    mapsUrl,
    geo: hasCoordinates
      ? {
          type: "Point",
          coordinates: [lng, lat],
        }
      : undefined,
    snapshot: {
      ...(hasCoordinates ? { lat, lng } : {}),
      ...(accuracy !== null ? { accuracy } : {}),
      mapsUrl,
      unavailable: !hasCoordinates,
    },
  };
};

const canListAllSosEvents = (req) => {
  const role = normalizeRole(req.auth?.role);
  if (role === "superadmin") return true;
  if (role !== "admin") return false;
  const adminRole = String(req.admin?.role || "").toUpperCase();
  if (adminRole === "SUPER_ADMIN") return true;
  const assigned = new Set(
    (Array.isArray(req.admin?.permissions) ? req.admin.permissions : [])
      .map((entry) => String(entry || "").trim().toUpperCase())
  );
  return assigned.has("VIEW_SOS");
};

const toEventResponse = (event) => {
  const obj = typeof event.toObject === "function" ? event.toObject() : event;
  const coordinates = obj.location?.coordinates;
  const lat =
    obj.locationSnapshot?.lat ??
    (Array.isArray(coordinates) && coordinates.length === 2 ? coordinates[1] : undefined);
  const lng =
    obj.locationSnapshot?.lng ??
    (Array.isArray(coordinates) && coordinates.length === 2 ? coordinates[0] : undefined);
  return {
    id: obj._id,
    eventId: obj.eventId || String(obj._id || ""),
    userId: obj.userId,
    profileId: obj.profileId || "",
    userName: obj.userName || "",
    phone: obj.phone || "",
    timestamp: obj.timestamp || obj.createdAt,
    location: {
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      accuracy: obj.locationSnapshot?.accuracy ?? obj.accuracyMeters ?? null,
      mapsUrl: obj.locationSnapshot?.mapsUrl || (lat !== undefined && lng !== undefined
        ? `https://maps.google.com/?q=${lat},${lng}`
        : ""),
      unavailable: obj.locationSnapshot?.unavailable === true || lat === undefined || lng === undefined,
    },
    messagePreview: obj.messagePreview || "",
    recipients: obj.recipients || [],
    source: obj.source || "other",
    networkMode: obj.networkMode || "unknown",
    syncStatus: obj.syncStatus || "synced",
    status: obj.status || "open",
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
};

// Create SOS message (patient/doctor/admin)
router.post("/", auth, async (req, res) => {
  try {
    const { latitude, longitude } = req.body || {};
    const hasGeoPayload =
      latitude !== undefined &&
      longitude !== undefined &&
      Number.isFinite(Number(latitude)) &&
      Number.isFinite(Number(longitude));

    const role = normalizeRole(req.auth?.role || "patient");
    const userId = req.user?._id || req.user?.id || req.auth?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unable to resolve user for SOS request.",
      });
    }

    if (!hasGeoPayload) {
      const { profileId, name, age, location, mobile } = req.body || {};

      const legacySos = await SOS.create({
        patientId: role === "patient" ? userId : undefined,
        profileId: profileId?.toString?.() ?? profileId ?? "",
        name: name ?? "",
        age: age?.toString?.() ?? age ?? "",
        mobile: (mobile ?? (role === "patient" ? req.user?.mobile || "" : ""))?.toString?.() ?? "",
        location: location ?? "",
        submittedByRole: role,
      });

      await writeAuditLog({
        req,
        action: "CREATE_SOS",
        resourceType: "SOS",
        resourceId: legacySos._id?.toString(),
        patientId: legacySos.patientId?.toString?.() || "",
        statusCode: 201,
      });

      return res.status(201).json({
        success: true,
        data: legacySos,
        massIncidentTriggered: false,
        massIncidentId: null,
      });
    }

    const lng = Number(longitude);
    const lat = Number(latitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        success: false,
        message: "Latitude and longitude must be valid numbers.",
      });
    }

    const accuracyMeters =
      req.body.accuracyMeters !== undefined ? Number(req.body.accuracyMeters) : undefined;
    const notes =
      typeof req.body.notes === "string" && req.body.notes.trim().length
        ? req.body.notes.trim()
        : undefined;
    const source = typeof req.body.source === "string" ? req.body.source : "patient_app";
    const providedAllergies =
      typeof req.body.allergies === "string" && req.body.allergies.trim().length
        ? req.body.allergies.trim()
        : undefined;
    const providedName =
      typeof req.body.name === "string" && req.body.name.trim().length
        ? req.body.name.trim()
        : undefined;
    const providedMobile =
      typeof req.body.mobile === "string" && req.body.mobile.trim().length
        ? req.body.mobile.trim()
        : undefined;
    const providedAge =
      typeof req.body.age === "string" && req.body.age.trim().length
        ? req.body.age.trim()
        : undefined;
    const providedLocationText =
      typeof req.body.locationText === "string" && req.body.locationText.trim().length
        ? req.body.locationText.trim()
        : undefined;
    const providedProfileId =
      typeof req.body.profileId === "string" && req.body.profileId.trim().length
        ? req.body.profileId.trim()
        : undefined;

    const userProfile = await User.findById(userId).select("allergies name mobile age dateOfBirth");
    const allergiesSnapshot =
      providedAllergies ?? userProfile?.allergies?.trim?.() ?? userProfile?.allergies ?? "";
    const displayName = providedName ?? userProfile?.name ?? "";
    const displayMobile = providedMobile ?? userProfile?.mobile?.toString?.() ?? "";

    const computeAgeFromDob = (dobValue) => {
      if (!dobValue) return null;
      try {
        const dob = dobValue instanceof Date ? dobValue : new Date(dobValue?.toString?.() ?? dobValue);
        if (Number.isNaN(dob.getTime())) return null;
        const now = new Date();
        let age = now.getUTCFullYear() - dob.getUTCFullYear();
        const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
        if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
          age--;
        }
        return age;
      } catch {
        return null;
      }
    };

    const derivedAge =
      providedAge ??
      (userProfile?.age != null ? String(userProfile.age) : undefined) ??
      (() => {
        const computed = computeAgeFromDob(userProfile?.dateOfBirth);
        return computed != null ? String(computed) : undefined;
      })();

    const sosEvent = await SosEvent.create({
      userId,
      source,
      location: {
        type: "Point",
        coordinates: [lng, lat],
      },
      accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : undefined,
      allergiesSnapshot,
      severity: "red",
      notes,
    });

    const locationString =
      providedLocationText ??
      `${lat.toFixed(6)},${lng.toFixed(6)}${
        Number.isFinite(accuracyMeters) ? ` (±${Math.round(Math.abs(accuracyMeters))}m)` : ""
      }`;

    const queueEntry = await SOS.create({
      patientId: userId,
      profileId: providedProfileId ?? userId.toString(),
      name: displayName,
      age: derivedAge,
      mobile: displayMobile,
      location: locationString,
      submittedByRole: role,
      allergiesSnapshot,
      notes,
      accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : undefined,
      geoLat: lat,
      geoLng: lng,
    });

    const now = new Date();
    const since = new Date(now.getTime() - MASS_WINDOW_MINUTES * 60 * 1000);

    const sosNearby = await SosEvent.find({
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [lng, lat] },
          $maxDistance: MASS_RADIUS_METERS,
        },
      },
      createdAt: { $gte: since },
    });

    let incident = null;

    if (sosNearby.length >= MASS_THRESHOLD) {
      incident = await MassIncident.findOne({
        status: "active",
        center: {
          $near: {
            $geometry: { type: "Point", coordinates: [lng, lat] },
            $maxDistance: MASS_RADIUS_METERS,
          },
        },
      });

      if (!incident) {
        const firstCreatedAt = sosNearby.reduce(
          (earliest, event) => (event.createdAt < earliest ? event.createdAt : earliest),
          sosNearby[0].createdAt
        );

        incident = await MassIncident.create({
          center: { type: "Point", coordinates: [lng, lat] },
          radiusMeters: MASS_RADIUS_METERS,
          sosCount: sosNearby.length,
          firstSOSAt: firstCreatedAt,
          lastSOSAt: now,
          status: "active",
        });
      } else {
        incident.sosCount = sosNearby.length;
        incident.lastSOSAt = now;
        await incident.save();
      }
    }

    await writeAuditLog({
      req,
      action: "CREATE_SOS",
      resourceType: "SOS",
      resourceId: queueEntry._id?.toString(),
      patientId: queueEntry.patientId?.toString?.() || "",
      statusCode: 201,
      metadata: {
        massIncidentTriggered: Boolean(incident),
        massIncidentId: incident ? incident._id?.toString() : "",
      },
    });

    return res.status(201).json({
      success: true,
      sos: sosEvent,
      massIncidentTriggered: Boolean(incident),
      massIncidentId: incident ? incident._id : null,
    });
  } catch (e) {
    console.error("SOS create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create SOS" });
  }
});

router.post("/events", auth, async (req, res) => {
  try {
    const role = normalizeRole(req.auth?.role || "patient");
    const userId = req.user?._id || req.user?.id || req.auth?.id;

    if (!userId || role !== "patient") {
      return res.status(403).json({
        success: false,
        message: "Only authenticated patients can create SOS event logs.",
      });
    }

    const body = req.body || {};
    const eventId = asText(body.eventId);
    if (eventId) {
      const existing = await SosEvent.findOne({ eventId, userId }).lean();
      if (existing) {
        return res.status(200).json({
          success: true,
          data: { event: toEventResponse(existing), deduped: true },
        });
      }
    }

    const location = resolveEventLocation(body.location || {
      lat: body.latitude,
      lng: body.longitude,
      accuracy: body.accuracyMeters,
    });
    const timestamp = parseDateOrNow(body.timestamp || body.capturedAt);
    const recipients = sanitizeRecipients(body.recipients || body.attemptedContacts);
    const userName = asText(body.userName || body.name || req.user?.name).slice(0, 160);
    const phone = asText(body.phone || body.mobile || req.user?.mobile).slice(0, 32);
    const profileId = asText(body.profileId || userId).slice(0, 120);
    const messagePreview = asText(body.messagePreview).slice(0, 480);

    const sosEvent = await SosEvent.create({
      eventId: eventId || undefined,
      userId,
      profileId,
      userName,
      phone,
      timestamp,
      source: normalizeSource(body.source),
      ...(location.geo ? { location: location.geo } : {}),
      locationSnapshot: location.snapshot,
      accuracyMeters: location.accuracy ?? undefined,
      notes: asText(body.notes).slice(0, 500) || undefined,
      messagePreview,
      recipients,
      networkMode: normalizeNetworkMode(body.networkMode),
      syncStatus: "synced",
      severity: "red",
      status: "open",
    });

    await SOS.create({
      patientId: userId,
      profileId,
      name: userName,
      mobile: phone,
      location: location.hasCoordinates
        ? `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`
        : "Location unavailable",
      submittedByRole: role,
      notes: "Client SOS SMS event",
      accuracyMeters: location.accuracy ?? undefined,
      geoLat: location.lat ?? undefined,
      geoLng: location.lng ?? undefined,
    });

    await writeAuditLog({
      req,
      action: "CREATE_SOS_EVENT",
      resourceType: "SosEvent",
      resourceId: sosEvent._id?.toString(),
      patientId: userId?.toString?.() || String(userId),
      statusCode: 201,
      metadata: {
        eventId: eventId || sosEvent._id?.toString(),
        recipientCount: recipients.length,
        networkMode: sosEvent.networkMode,
        source: sosEvent.source,
        hasLocation: location.hasCoordinates,
      },
    });

    return res.status(201).json({
      success: true,
      data: { event: toEventResponse(sosEvent) },
    });
  } catch (e) {
    console.error("SOS event create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create SOS event" });
  }
});

router.get("/events/me", auth, async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id || req.auth?.id;
    if (!userId || normalizeRole(req.auth?.role) !== "patient") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const events = await SosEvent.find({ userId })
      .sort({ timestamp: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: events.map(toEventResponse),
    });
  } catch (e) {
    console.error("SOS event self list error:", e);
    return res.status(500).json({ success: false, message: "Failed to fetch SOS events" });
  }
});

router.get("/events", auth, async (req, res) => {
  try {
    const role = normalizeRole(req.auth?.role);
    if (!canListAllSosEvents(req)) {
      if (role === "patient") {
        const userId = req.user?._id || req.user?.id || req.auth?.id;
        const events = await SosEvent.find({ userId })
          .sort({ timestamp: -1, createdAt: -1 })
          .limit(Math.min(parseInt(req.query.limit || "50", 10), 100))
          .lean();
        return res.json({ success: true, data: events.map(toEventResponse) });
      }
      return res.status(403).json({ success: false, message: "Insufficient permissions" });
    }

    const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
    const events = await SosEvent.find({})
      .sort({ timestamp: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    await writeAuditLog({
      req,
      action: "LIST_SOS_EVENTS",
      resourceType: "SosEvent",
      resourceId: "",
      statusCode: 200,
      metadata: { count: events.length },
    });

    return res.json({ success: true, data: events.map(toEventResponse) });
  } catch (e) {
    console.error("SOS event list error:", e);
    return res.status(500).json({ success: false, message: "Failed to fetch SOS events" });
  }
});

// List SOS messages
router.get("/", auth, async (req, res) => {
  try {
    const role = normalizeRole(req.auth?.role);
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
    const skip = Math.max(parseInt(req.query.skip || "0", 10), 0);
    const unreadOnly = String(req.query.unread || "false").toLowerCase() === "true";

    const baseFilter = unreadOnly ? { isRead: { $ne: true } } : {};
    let filter = baseFilter;

    if (role === "patient") {
      filter = { ...baseFilter, patientId: req.auth.id };
    } else if (!role || !["admin", "superadmin"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    } else if (role === "admin") {
      const assigned = new Set(
        (Array.isArray(req.admin?.permissions) ? req.admin.permissions : [])
          .map((entry) => String(entry || "").trim().toUpperCase())
      );
      const isSuperAdminRole = String(req.admin?.role || "").toUpperCase() === "SUPER_ADMIN";
      if (!isSuperAdminRole && !assigned.has("VIEW_SOS")) {
        return res.status(403).json({ success: false, message: "Insufficient permissions" });
      }
    }

    const items = await SOS.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean();

    await writeAuditLog({
      req,
      action: "LIST_SOS",
      resourceType: "SOS",
      resourceId: "",
      patientId: role === "patient" ? String(req.auth.id) : "",
      statusCode: 200,
      metadata: { count: items.length },
    });

    return res.json({ success: true, data: items });
  } catch (e) {
    console.error("SOS list error:", e);
    return res.status(500).json({ success: false, message: "Failed to fetch SOS" });
  }
});

// Mark a batch of SOS messages as read (admin/superadmin only)
router.post(
  "/mark-read",
  auth,
  checkRole("admin", "superadmin"),
  requireAdminPermissions("HANDLE_SOS"),
  async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ success: false, message: "ids array is required" });

    await SOS.updateMany({ _id: { $in: ids } }, { $set: { isRead: true } });

    await writeAuditLog({
      req,
      action: "MARK_SOS_READ",
      resourceType: "SOS",
      resourceId: ids.join(","),
      statusCode: 200,
      metadata: { idsCount: ids.length },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("SOS mark-read error:", e);
    return res.status(500).json({ success: false, message: "Failed to mark as read" });
  }
  }
);

// Delete/clear an SOS item (admin/superadmin only)
router.delete(
  "/:id",
  auth,
  checkRole("admin", "superadmin"),
  requireAdminPermissions("HANDLE_SOS"),
  async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: "Missing id" });

    const result = await SOS.findByIdAndDelete(id);
    if (!result) return res.status(404).json({ success: false, message: "Not found" });

    await writeAuditLog({
      req,
      action: "DELETE_SOS",
      resourceType: "SOS",
      resourceId: id,
      patientId: result.patientId?.toString?.() || "",
      statusCode: 200,
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("SOS delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete" });
  }
  }
);

export default router;
