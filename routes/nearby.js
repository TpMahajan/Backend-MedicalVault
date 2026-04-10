import express from "express";
import axios from "axios";

import { auth } from "../middleware/auth.js";

const router = express.Router();

const GOOGLE_PLACES_API_KEY = String(process.env.GOOGLE_PLACES_API_KEY || "").trim();
const GOOGLE_PLACES_URL = "https://maps.googleapis.com/maps/api/place/nearbysearch/json";

const defaultCriticalServices = [
  {
    type: "AMBULANCE",
    name: "Emergency Ambulance",
    phone: "108",
  },
  {
    type: "HEALTH_HELPLINE",
    name: "Emergency Response",
    phone: "112",
  },
  {
    type: "WOMEN_HELPLINE",
    name: "Women Helpline",
    phone: "1091",
  },
];

const asText = (value) => (value == null ? "" : String(value).trim());

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseTypes = (value) => {
  const raw = Array.isArray(value) ? value : [value || ""]; 
  const allowed = new Set(["HOSPITAL", "CLINIC", "AMBULANCE", "DOCTOR"]);

  const normalized = raw
    .flatMap((entry) =>
      String(entry || "")
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean)
    )
    .filter((entry) => allowed.has(entry));

  return normalized.length > 0
    ? [...new Set(normalized)]
    : ["HOSPITAL", "CLINIC", "AMBULANCE", "DOCTOR"];
};

const haversineDistanceKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c;
};

const normalizePlaceType = (requestedType) => {
  switch (requestedType) {
    case "HOSPITAL":
      return { googleType: "hospital", keyword: "hospital" };
    case "CLINIC":
      return { googleType: "health", keyword: "clinic" };
    case "AMBULANCE":
      return { googleType: "hospital", keyword: "ambulance" };
    case "DOCTOR":
      return { googleType: "doctor", keyword: "doctor" };
    default:
      return { googleType: "health", keyword: "medical" };
  }
};

const mapPlaceResult = ({ place, queryType, fromLat, fromLng, nowIso }) => {
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

  return {
    serviceType: queryType,
    name: asText(place?.name || "Unknown Service"),
    placeId: asText(place?.place_id),
    address: asText(place?.vicinity || place?.formatted_address || ""),
    rating: Number(toNumber(place?.rating, 0).toFixed(1)),
    totalRatings: Math.max(0, toNumber(place?.user_ratings_total, 0)),
    availability,
    distanceKm: Number(distanceKm.toFixed(2)),
    distanceText: `${distanceKm.toFixed(2)} km`,
    latitude,
    longitude,
    lastUpdatedAt: nowIso,
  };
};

const dedupeByPlaceId = (services) => {
  const seen = new Set();
  return services.filter((service) => {
    const key = asText(service.placeId || `${service.serviceType}:${service.name}`);
    if (!key) return false;
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

    const radius = Math.min(
      Math.max(parseInt(String(req.query.radius || "5000"), 10) || 5000, 1000),
      30000
    );
    const types = parseTypes(req.query.types);
    const nowIso = new Date().toISOString();

    if (!GOOGLE_PLACES_API_KEY) {
      return res.json({
        success: true,
        services: [],
        criticalServices: defaultCriticalServices,
        source: "offline_fallback",
        lastUpdatedAt: nowIso,
        message: "Live discovery unavailable. Showing critical contacts.",
      });
    }

    const requests = types.map(async (type) => {
      const { googleType, keyword } = normalizePlaceType(type);
      const response = await axios.get(GOOGLE_PLACES_URL, {
        params: {
          location: `${lat},${lng}`,
          radius,
          type: googleType,
          keyword,
          key: GOOGLE_PLACES_API_KEY,
        },
        timeout: Number(process.env.NEARBY_PLACES_TIMEOUT_MS || 10000),
      });

      const results = Array.isArray(response?.data?.results)
        ? response.data.results
        : [];

      return results.map((place) =>
        mapPlaceResult({
          place,
          queryType: type,
          fromLat: lat,
          fromLng: lng,
          nowIso,
        })
      );
    });

    const grouped = await Promise.all(requests);
    const services = dedupeByPlaceId(grouped.flat())
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 120);

    return res.json({
      success: true,
      services,
      criticalServices: defaultCriticalServices,
      source: "google_places",
      lastUpdatedAt: nowIso,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch nearby services",
      error: error.message,
    });
  }
});

export default router;
