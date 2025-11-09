import express from "express";
import { auth, optionalAuth } from "../middleware/auth.js";
import SOS from "../models/SOS.js";
import { User } from "../models/User.js";
import { SosEvent } from "../models/SosEvent.js";
import { MassIncident } from "../models/MassIncident.js";

const router = express.Router();

// Mass crowd SOS detection thresholds (Meters + Minutes)
const MASS_WINDOW_MINUTES = 10; // time window to consider for clustering
const MASS_RADIUS_METERS = 15; // radius within which events are considered part of the same cluster
const MASS_THRESHOLD = 8; // minimum SOS events required to trigger a mass incident

// Create SOS message (patient/doctor)
router.post("/", auth, async (req, res) => {
  try {
    const { latitude, longitude } = req.body || {};
    const hasGeoPayload =
      latitude !== undefined &&
      longitude !== undefined &&
      Number.isFinite(Number(latitude)) &&
      Number.isFinite(Number(longitude));

    // Legacy fallback for older clients that still POST profile/name/location strings
    if (!hasGeoPayload) {
      const role = req.auth?.role || "patient";
      const patientId =
        role === "patient" ? (req.user?._id || req.user?.id) : undefined;
      const { profileId, name, age, location, mobile } = req.body || {};

      const legacySos = await SOS.create({
        patientId,
        profileId: profileId?.toString?.() ?? profileId ?? "",
        name: name ?? "",
        age: age?.toString?.() ?? age ?? "",
        mobile:
          (mobile ?? (role === "patient" ? req.user?.mobile || "" : ""))?.toString?.() ??
          "",
        location: location ?? "",
        submittedByRole: role,
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
      req.body.accuracyMeters !== undefined
        ? Number(req.body.accuracyMeters)
        : undefined;
    const notes =
      typeof req.body.notes === "string" && req.body.notes.trim().length
        ? req.body.notes.trim()
        : undefined;
    const source =
      typeof req.body.source === "string" ? req.body.source : "patient_app";
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
      typeof req.body.locationText === "string" &&
      req.body.locationText.trim().length
        ? req.body.locationText.trim()
        : undefined;
    const providedProfileId =
      typeof req.body.profileId === "string" && req.body.profileId.trim().length
        ? req.body.profileId.trim()
        : undefined;

    const userId = req.user?._id || req.user?.id || req.auth?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unable to resolve user for SOS request.",
      });
    }

    const userProfile = await User.findById(userId).select(
      "allergies name mobile age dateOfBirth"
    );
    const allergiesSnapshot =
      providedAllergies ??
      userProfile?.allergies?.trim?.() ??
      userProfile?.allergies ??
      "";
    const displayName = providedName ?? userProfile?.name ?? "";
    const displayMobile =
      providedMobile ?? userProfile?.mobile?.toString?.() ?? "";

    const computeAgeFromDob = (dobValue) => {
      if (!dobValue) return null;
      try {
        const dob =
          dobValue instanceof Date
            ? dobValue
            : new Date(dobValue?.toString?.() ?? dobValue);
        if (Number.isNaN(dob.getTime())) return null;
        const now = new Date();
        let age = now.getUTCFullYear() - dob.getUTCFullYear();
        const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
        if (
          monthDiff < 0 ||
          (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())
        ) {
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
        Number.isFinite(accuracyMeters)
          ? ` (±${Math.round(Math.abs(accuracyMeters))}m)`
          : ""
      }`;

    await SOS.create({
      patientId: userId,
      profileId: providedProfileId ?? userId.toString(),
      name: displayName,
      age: derivedAge,
      mobile: displayMobile,
      location: locationString,
      submittedByRole: req.auth?.role || "patient",
      allergiesSnapshot,
      notes,
      accuracyMeters: Number.isFinite(accuracyMeters)
        ? accuracyMeters
        : undefined,
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
          (earliest, event) =>
            event.createdAt < earliest ? event.createdAt : earliest,
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

      // TODO: Integrate FCM/email/SMS alerts for admins/responders (#mass-sos-alerts)
      console.log(
        "MASS INCIDENT DETECTED:",
        incident._id.toString(),
        sosNearby.length,
        "events"
      );
    }

    return res.status(201).json({
      success: true,
      sos: sosEvent,
      massIncidentTriggered: Boolean(incident),
      massIncidentId: incident ? incident._id : null,
    });
  } catch (e) {
    console.error("SOS create error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create SOS" });
  }
});

// List SOS messages FIFO (admins/doctors) — for now allow doctors
// TEMP: Public listing for prototyping admin UI; will secure later
router.get("/", optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
    const skip = Math.max(parseInt(req.query.skip || "0", 10), 0);
    const unreadOnly = String(req.query.unread || "false").toLowerCase() === 'true';
    const filter = unreadOnly ? { isRead: { $ne: true } } : {};
    const items = await SOS.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean();
    return res.json({ success: true, data: items });
  } catch (e) {
    console.error("SOS list error:", e);
    return res.status(500).json({ success: false, message: "Failed to fetch SOS" });
  }
});

// Mark a batch of SOS messages as read
router.post("/mark-read", optionalAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ success: false, message: "ids array is required" });
    await SOS.updateMany({ _id: { $in: ids } }, { $set: { isRead: true } });
    return res.json({ success: true });
  } catch (e) {
    console.error("SOS mark-read error:", e);
    return res.status(500).json({ success: false, message: "Failed to mark as read" });
  }
});

export default router;

// Delete/clear an SOS item (temporary open access; secure later)
router.delete("/:id", optionalAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: "Missing id" });
    const result = await SOS.findByIdAndDelete(id);
    if (!result) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("SOS delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete" });
  }
});


