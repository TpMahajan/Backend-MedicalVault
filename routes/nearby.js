import express from "express";
import axios from "axios";

import { auth } from "../middleware/auth.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Provider: Google Places LEGACY Web Service (default and only provider).
// Places API (New) — https://places.googleapis.com/v1 — is intentionally NOT
// called by default. All Google location features use the single env key
// GOOGLE_MAPS_API_KEY.
// ---------------------------------------------------------------------------
const PLACES_PROVIDER = "legacy"; // "legacy" is the only provider wired in.

const LEGACY_NEARBY_URL =
  "https://maps.googleapis.com/maps/api/place/nearbysearch/json";
const LEGACY_TEXT_URL =
  "https://maps.googleapis.com/maps/api/place/textsearch/json";

// Product behaviour lives in code, not in .env.
const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 25;
const MIN_RADIUS_METERS = 500;
const MAX_RADIUS_METERS = MAX_RADIUS_KM * 1000;
const GOOGLE_TIMEOUT_MS = 5000;
const MAX_RESULTS_PER_TYPE = 10;
const MAX_TOTAL_RESULTS = 40;

const defaultCriticalServices = [
  { type: "AMBULANCE", name: "Emergency Ambulance", phone: "108" },
  { type: "HEALTH_HELPLINE", name: "Emergency Response", phone: "112" },
  { type: "WOMEN_HELPLINE", name: "Women Helpline", phone: "1091" },
];

// Deterministic, instant fallback (no network) used whenever Google is
// unavailable. Matches the normalized service shape.
const fallbackEmergencyContacts = [
  {
    id: "emergency-108",
    placeId: "emergency-108",
    name: "108 Ambulance",
    type: "ambulance",
    address: "",
    phone: "108",
    lat: 0,
    lng: 0,
    distanceKm: 0,
    rating: 0,
    openNow: true,
    source: "fallback",
  },
  {
    id: "emergency-112",
    placeId: "emergency-112",
    name: "112 Emergency",
    type: "emergency_contact",
    address: "",
    phone: "112",
    lat: 0,
    lng: 0,
    distanceKm: 0,
    rating: 0,
    openNow: true,
    source: "fallback",
  },
  {
    id: "emergency-1091",
    placeId: "emergency-1091",
    name: "Women Helpline",
    type: "emergency_contact",
    address: "",
    phone: "1091",
    lat: 0,
    lng: 0,
    distanceKm: 0,
    rating: 0,
    openNow: true,
    source: "fallback",
  },
];

const asText = (value) => (value == null ? "" : String(value).trim());

// Single source of truth for the Google Maps Platform key.
const getGoogleMapsApiKey = () =>
  String(process.env.GOOGLE_MAPS_API_KEY || "").trim();

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeRequestedType = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

  if (["all", "any", "healthcare", "medical"].includes(normalized)) return "all";
  if (["hospital", "hospitals"].includes(normalized)) return "hospital";
  if (["clinic", "clinics"].includes(normalized)) return "clinic";
  if (["doctor", "doctors", "physician", "physicians"].includes(normalized)) {
    return "doctor";
  }
  if (
    ["pharmacy", "pharmacies", "medicalstore", "medicalstores", "chemist"].includes(
      normalized,
    )
  ) {
    return "pharmacy";
  }
  if (
    ["ambulance", "ambulances", "emergency", "emergencycontact"].includes(
      normalized,
    )
  ) {
    return "ambulance";
  }
  return "";
};

// Split a comma-separated `type` query safely and normalize each value.
const parseTypes = (query = {}) => {
  const raw = [
    ...(Array.isArray(query.types) ? query.types : [query.types || ""]),
    ...(Array.isArray(query.type) ? query.type : [query.type || ""]),
  ];
  const allowed = new Set(["hospital", "clinic", "ambulance", "doctor", "pharmacy"]);

  const normalized = raw
    .flatMap((entry) =>
      String(entry || "")
        .split(",")
        .map(normalizeRequestedType)
        .filter(Boolean),
    )
    .flatMap((entry) =>
      entry === "all"
        ? ["hospital", "clinic", "doctor", "pharmacy", "ambulance"]
        : [entry],
    )
    .filter((entry) => allowed.has(entry));

  return normalized.length > 0
    ? [...new Set(normalized)]
    : ["hospital", "clinic", "doctor", "pharmacy", "ambulance"];
};

const haversineDistanceKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c;
};

const toLegacyServiceType = (type) => {
  switch (type) {
    case "hospital":
      return "HOSPITAL";
    case "clinic":
      return "CLINIC";
    case "doctor":
      return "DOCTOR";
    case "pharmacy":
      return "PHARMACY";
    case "ambulance":
      return "AMBULANCE";
    default:
      return "HEALTHCARE";
  }
};

// App type -> Google Places Legacy strategy.
// nearbysearch for native place types; textsearch for keyword-driven types.
const legacyStrategyForType = (type) => {
  switch (type) {
    case "hospital":
      return { endpoint: "nearby", params: { type: "hospital" } };
    case "doctor":
      return { endpoint: "nearby", params: { type: "doctor" } };
    case "pharmacy":
      return { endpoint: "nearby", params: { type: "pharmacy" } };
    case "clinic":
      return { endpoint: "text", params: { query: "clinic" } };
    case "ambulance":
      return { endpoint: "text", params: { query: "ambulance service" } };
    default:
      return { endpoint: "text", params: { query: "medical" } };
  }
};

const mapLegacyResult = ({ place, queryType, fromLat, fromLng, nowIso }) => {
  const location = place?.geometry?.location || {};
  const latitude = toNumber(location.lat, 0);
  const longitude = toNumber(location.lng, 0);
  const distanceKm =
    latitude && longitude
      ? haversineDistanceKm(fromLat, fromLng, latitude, longitude)
      : 0;

  const openNow = place?.opening_hours?.open_now;
  const availability =
    openNow === true ? "OPEN_NOW" : openNow === false ? "CLOSED" : "UNKNOWN";
  const placeId = asText(place?.place_id);
  const id = placeId || `${queryType}:${latitude}:${longitude}`;

  return {
    id,
    placeId,
    name: asText(place?.name || "Unknown Service"),
    type: queryType,
    address: asText(place?.vicinity || place?.formatted_address || ""),
    // Legacy Nearby/Text Search do not return phone numbers. That is
    // acceptable — details are fetched on demand, not for every result.
    phone: null,
    lat: latitude,
    lng: longitude,
    distanceKm: Number(distanceKm.toFixed(2)),
    rating: Number(toNumber(place?.rating, 0).toFixed(1)),
    openNow: openNow === true,
    source: "google_places_legacy",
    mapsUrl: placeId
      ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}&query_place_id=${placeId}`
      : "",

    // Compatibility fields used by current Flutter builds/offline cache.
    serviceType: toLegacyServiceType(queryType),
    totalRatings: Math.max(0, toNumber(place?.user_ratings_total, 0)),
    availability,
    distanceText: `${distanceKm.toFixed(2)} km`,
    latitude,
    longitude,
    lastUpdatedAt: nowIso,
  };
};

// Error carrying the Google Places `status` (REQUEST_DENIED, etc.).
class GoogleStatusError extends Error {
  constructor(googleStatus, message) {
    super(message || googleStatus || "GOOGLE_ERROR");
    this.name = "GoogleStatusError";
    this.googleStatus = googleStatus || "UNKNOWN_ERROR";
  }
}

const fetchLegacyForType = async ({ type, lat, lng, radius, apiKey, nowIso }) => {
  const strategy = legacyStrategyForType(type);
  const url = strategy.endpoint === "nearby" ? LEGACY_NEARBY_URL : LEGACY_TEXT_URL;
  const params = {
    location: `${lat},${lng}`,
    radius,
    key: apiKey,
    ...strategy.params,
  };

  const response = await axios.get(url, { params, timeout: GOOGLE_TIMEOUT_MS });
  const data = response?.data || {};
  const status = asText(data.status).toUpperCase();

  if (status === "OK") {
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .slice(0, MAX_RESULTS_PER_TYPE)
      .map((place) =>
        mapLegacyResult({ place, queryType: type, fromLat: lat, fromLng: lng, nowIso }),
      );
  }

  if (status === "ZERO_RESULTS") return [];

  // REQUEST_DENIED, OVER_QUERY_LIMIT, INVALID_REQUEST, UNKNOWN_ERROR, ...
  throw new GoogleStatusError(
    status,
    data.error_message || `Google Places status: ${status}`,
  );
};

// Deduplicate by place_id, falling back to name + coordinates.
const dedupeServices = (services) => {
  const seen = new Set();
  return services.filter((service) => {
    const placeId = asText(service.placeId || service.id);
    const key =
      placeId || `${asText(service.name)}:${service.lat}:${service.lng}`;
    if (!key || key === "::") return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

router.get("/services", auth, async (req, res) => {
  try {
    const lat = toNumber(req.query.lat, NaN);
    const lng = toNumber(req.query.lng, NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        success: false,
        message: "Valid lat and lng are required",
      });
    }

    const radiusKmRaw = toNumber(req.query.radiusKm, NaN);
    const radiusMetersRaw = toNumber(req.query.radius, NaN);
    const defaultRadiusMeters = DEFAULT_RADIUS_KM * 1000;
    const radius = Number.isFinite(radiusKmRaw)
      ? Math.round(radiusKmRaw * 1000)
      : Math.round(radiusMetersRaw || defaultRadiusMeters);
    const normalizedRadius = Math.min(
      Math.max(radius || defaultRadiusMeters, MIN_RADIUS_METERS),
      MAX_RADIUS_METERS,
    );
    const radiusKm = Number((normalizedRadius / 1000).toFixed(2));
    const types = parseTypes(req.query);
    const nowIso = new Date().toISOString();

    const googleMapsApiKey = getGoogleMapsApiKey();

    // No key — clear degraded response with emergency contacts. Never blank.
    if (!googleMapsApiKey) {
      return res.status(503).json({
        success: false,
        code: "GOOGLE_MAPS_API_KEY_MISSING",
        message: "Google Maps API key is not configured on the backend.",
        services: [],
        fallback: fallbackEmergencyContacts,
        criticalServices: defaultCriticalServices,
        source: "fallback",
        radiusKm,
        lastUpdatedAt: nowIso,
      });
    }

    // Guard against any accidental non-legacy provider wiring.
    if (PLACES_PROVIDER !== "legacy") {
      throw new Error(`Unsupported PLACES_PROVIDER: ${PLACES_PROVIDER}`);
    }

    // Query each requested type independently so one failure/empty type does
    // not blank the rest.
    const settled = await Promise.allSettled(
      types.map((type) =>
        fetchLegacyForType({
          type,
          lat,
          lng,
          radius: normalizedRadius,
          apiKey: googleMapsApiKey,
          nowIso,
        }),
      ),
    );

    const collected = [];
    let requestDenied = false;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        collected.push(...result.value);
        continue;
      }
      const err = result.reason;
      const googleStatus = err?.googleStatus;
      if (googleStatus === "REQUEST_DENIED") requestDenied = true;
      console.warn("[nearby] Google Places (legacy) request failed:", {
        googleStatus: googleStatus || err?.code,
        message: err?.message,
      });
    }

    // All calls denied and nothing collected — clear, actionable error.
    if (requestDenied && collected.length === 0) {
      return res.status(200).json({
        success: false,
        code: "GOOGLE_MAPS_REQUEST_DENIED",
        message:
          "Google Maps API key is not allowed to access Places API. Enable Places API and allow it on the key.",
        services: [],
        fallback: fallbackEmergencyContacts,
        criticalServices: defaultCriticalServices,
        source: "fallback",
        radiusKm,
        lastUpdatedAt: nowIso,
      });
    }

    const services = dedupeServices(collected)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_TOTAL_RESULTS);

    // Ambulance requested (or nothing found) → include emergency fallbacks so
    // the app always has actionable contacts.
    const includeFallback =
      types.includes("ambulance") || services.length === 0;

    return res.status(200).json({
      success: true,
      source: "google_places_legacy",
      services,
      fallback: includeFallback ? fallbackEmergencyContacts : [],
      criticalServices: defaultCriticalServices,
      radiusKm,
      count: services.length,
      lastUpdatedAt: nowIso,
      message:
        services.length > 0
          ? "Nearby healthcare services loaded from Google Places."
          : "No nearby healthcare services found for the selected filters.",
    });
  } catch (error) {
    console.warn("[nearby] Nearby lookup failed:", {
      code: error?.code,
      message: error?.message,
    });
    return res.status(502).json({
      success: false,
      code: "NEARBY_UNAVAILABLE",
      message: "Nearby lookup is temporarily unavailable.",
      services: [],
      fallback: fallbackEmergencyContacts,
      criticalServices: defaultCriticalServices,
    });
  }
});

export default router;
