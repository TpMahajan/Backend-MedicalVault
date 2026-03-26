import express from "express";
import { randomUUID } from "node:crypto";

import { Advertisement } from "../models/Advertisement.js";
import { AdvertisementClickLog } from "../models/AdvertisementClickLog.js";
import { Product } from "../models/Product.js";
import { UIConfig } from "../models/UIConfig.js";
import { User } from "../models/User.js";
import { PUBLIC_ALERT_PLATFORMS } from "../services/publicConfigRealtime.js";
import { BUCKET_NAME } from "../config/s3.js";
import { generateSignedUrl } from "../utils/s3Utils.js";
import { buildUserResponse } from "../utils/userResponse.js";

const router = express.Router();
const hasAWSCredentials =
  !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;

const CACHE_TTL_MS = Number(process.env.PUBLIC_CONFIG_CACHE_TTL_MS || 60_000);
const cacheState = {
  ads: new Map(),
  products: null,
  uiConfig: null,
};

function readCache(entry) {
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.value;
}

function writeCache(value) {
  return {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
}

export function clearPublicConfigCache() {
  cacheState.ads.clear();
  cacheState.products = null;
  cacheState.uiConfig = null;
}

function sanitizeString(value, maxLength = 120) {
  if (value == null) return "";
  return String(value).trim().slice(0, maxLength);
}

function normalizeGeoDimension(value, maxLength = 80) {
  return sanitizeString(value, maxLength).toUpperCase();
}

function normalizePlatform(value) {
  const raw = sanitizeString(value, 40).toLowerCase();
  if (!raw) return "unknown";
  if (raw.includes("web")) return "web";
  if (raw.includes("app") || raw.includes("flutter") || raw.includes("android") || raw.includes("ios")) {
    return "app";
  }
  return "unknown";
}

function normalizeSurface(value, fallback = "") {
  const raw = sanitizeString(value || fallback, 60)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "");
  return raw || "UNKNOWN";
}

function normalizeAlertPlatforms(value) {
  const raw = Array.isArray(value) ? value : [value];
  const normalized = raw
    .flatMap((entry) =>
      String(entry || "")
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean)
    )
    .filter(
      (entry) => entry === "ALL" || PUBLIC_ALERT_PLATFORMS.includes(entry)
    );

  if (normalized.includes("ALL")) return [...PUBLIC_ALERT_PLATFORMS];
  const unique = [...new Set(normalized.filter((entry) => entry !== "ALL"))];
  return unique.length > 0 ? unique : [...PUBLIC_ALERT_PLATFORMS];
}

function buildTrackedUrl(redirectUrl, params) {
  try {
    const url = new URL(redirectUrl);
    Object.entries(params).forEach(([key, value]) => {
      if (value != null && String(value).trim() !== "") {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  } catch {
    return redirectUrl;
  }
}

function toAbsoluteUploadsUrl(value) {
  const raw = sanitizeString(value, 500);
  if (!raw) return "";
  if (raw.startsWith("data:image/")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  const baseUrl = sanitizeString(
    process.env.PUBLIC_SERVER_BASE_URL || process.env.API_BASE_URL,
    300
  ).replace(/\/api\/?$/i, "");
  const resolvedBase = baseUrl || `http://localhost:${process.env.PORT || 5000}`;
  if (raw.startsWith("/uploads/")) return `${resolvedBase}${raw}`;
  if (raw.startsWith("uploads/")) return `${resolvedBase}/${raw}`;
  return "";
}

async function resolveStoredMediaUrl({ imageUrl, imageKey }) {
  const key = sanitizeString(imageKey, 500);
  if (key) {
    const direct = toAbsoluteUploadsUrl(key);
    if (direct) return direct;
    if (hasAWSCredentials) {
      try {
        return await generateSignedUrl(key, BUCKET_NAME);
      } catch {
        // Fall through to imageUrl resolution.
      }
    }
  }

  const directUrl = toAbsoluteUploadsUrl(imageUrl);
  if (directUrl) return directUrl;

  const rawUrl = sanitizeString(imageUrl, 500);
  if (rawUrl.startsWith("data:image/")) return rawUrl;
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
}

function matchesGeoTargets(entity, { country, state, region }) {
  const countries = Array.isArray(entity?.targetCountries)
    ? entity.targetCountries
        .map((entry) => normalizeGeoDimension(entry))
        .filter(Boolean)
    : [];
  const states = Array.isArray(entity?.targetStates)
    ? entity.targetStates
        .map((entry) => normalizeGeoDimension(entry))
        .filter(Boolean)
    : [];
  const regions = Array.isArray(entity?.targetRegions)
    ? entity.targetRegions
        .map((entry) => normalizeGeoDimension(entry))
        .filter(Boolean)
    : [];

  const hasTargets =
    countries.length > 0 || states.length > 0 || regions.length > 0;
  if (!hasTargets) return true;

  const hasAnyLocationInput = Boolean(country || state || region);
  if (!hasAnyLocationInput) return false;

  if (countries.length > 0 && (!country || !countries.includes(country))) {
    return false;
  }
  if (states.length > 0 && (!state || !states.includes(state))) {
    return false;
  }
  if (regions.length > 0 && (!region || !regions.includes(region))) {
    return false;
  }

  return true;
}

// Public emergency medical-card endpoint for QR scans.
// Intentionally accessible without authentication.
router.get("/medical-card/:id", async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim();
    if (!/^[a-fA-F0-9]{24}$/.test(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid patient id",
      });
    }

    const selectFields =
      "name profilePicture age gender dateOfBirth bloodType height weight email mobile medications allergies emergencyContact";
    const user = await User.findById(userId).select(selectFields).lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Medical card not found",
      });
    }

    const processedUser = await buildUserResponse(user);
    if (processedUser && !processedUser._id && processedUser.id) {
      processedUser._id = processedUser.id;
    }

    return res.json({
      success: true,
      data: { user: processedUser },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch medical card",
      error: error.message,
    });
  }
});

router.get("/ads", async (req, res) => {
  try {
    const placement = String(req.query.placement || "").toUpperCase().trim();
    const country = normalizeGeoDimension(req.query.country);
    const state = normalizeGeoDimension(req.query.state);
    const region = normalizeGeoDimension(req.query.region);
    const cacheKey = [placement || "ALL", country || "*", state || "*", region || "*"].join("|");
    const cached = readCache(cacheState.ads.get(cacheKey));
    if (cached) {
      return res.json({ success: true, ads: cached, cached: true });
    }

    const now = new Date();
    const query = {
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
    };

    if (placement) {
      query.$or = [{ placement }, { placements: placement }];
    }

    const adsRaw = await Advertisement.find(query)
      .sort({ createdAt: -1 })
      .lean();
    const ads = await Promise.all(
      adsRaw
        .filter((ad) => matchesGeoTargets(ad, { country, state, region }))
        .map(async (ad) => ({
          ...ad,
          imageUrl: await resolveStoredMediaUrl({
            imageUrl: ad.imageUrl,
            imageKey: ad.imageKey,
          }),
        }))
    );

    cacheState.ads.set(cacheKey, writeCache(ads));
    return res.json({ success: true, ads, cached: false });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch advertisements",
      error: error.message,
    });
  }
});

router.post("/ads/:id/click", async (req, res) => {
  try {
    const adId = sanitizeString(req.params.id, 60);
    if (!adId) {
      return res
        .status(400)
        .json({ success: false, message: "Advertisement ID is required" });
    }

    const ad = await Advertisement.findById(adId).lean();
    if (!ad) {
      return res
        .status(404)
        .json({ success: false, message: "Advertisement not found" });
    }

    const now = new Date();
    const startDate = new Date(ad.startDate);
    const endDate = new Date(ad.endDate);
    const isCurrentlyActive =
      ad.isActive === true &&
      !Number.isNaN(startDate.getTime()) &&
      !Number.isNaN(endDate.getTime()) &&
      startDate <= now &&
      endDate >= now;

    if (!isCurrentlyActive) {
      return res.status(400).json({
        success: false,
        message: "Advertisement is not currently active",
      });
    }

    const targetSurfaces = Array.isArray(ad.placements) && ad.placements.length > 0
      ? ad.placements
      : [String(ad.placement || "").toUpperCase()].filter(Boolean);

    const body = req.body || {};
    const platform = normalizePlatform(body.platform || req.query.platform);
    const surface = normalizeSurface(
      body.surface || req.query.surface,
      targetSurfaces[0] || ad.placement
    );
    if (
      targetSurfaces.length > 0 &&
      !targetSurfaces.includes(surface)
    ) {
      return res.status(400).json({
        success: false,
        message: "Advertisement is not configured for this surface",
      });
    }
    const userId = sanitizeString(body.userId || req.query.userId, 120);
    const userType = sanitizeString(body.userType || req.query.userType, 60);
    const sessionId = sanitizeString(body.sessionId || req.query.sessionId, 120);
    const sourceApp = sanitizeString(body.sourceApp || req.query.sourceApp, 60);

    const eventId = randomUUID();
    const adObjectId = ad._id?.toString() || adId;
    const utmSource =
      platform === "app" ? "medicalvault_app" : platform === "web" ? "medicalvault_web" : "medicalvault";
    const utmMedium = surface.toLowerCase();
    const utmCampaign = "medicalvault_ads";
    const utmContent = adObjectId;

    const trackedUrl = buildTrackedUrl(ad.redirectUrl, {
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      utm_content: utmContent,
      mv_event_id: eventId,
      mv_ad_id: adObjectId,
      mv_surface: surface,
    });

    await AdvertisementClickLog.create({
      eventId,
      advertisementId: ad._id,
      placement: surface,
      redirectUrl: ad.redirectUrl,
      trackedUrl,
      platform,
      surface,
      sourceApp,
      userId,
      userType,
      sessionId,
      ipAddress: req.ip || "",
      userAgent: req.headers["user-agent"] || "",
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
    });

    return res.json({
      success: true,
      eventId,
      trackedUrl,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to register advertisement click",
      error: error.message,
    });
  }
});

router.get("/products", async (req, res) => {
  try {
    const category = String(req.query.category || "").trim();
    const country = normalizeGeoDimension(req.query.country);
    const state = normalizeGeoDimension(req.query.state);
    const region = normalizeGeoDimension(req.query.region);
    const cacheKey = [category || "ALL", country || "*", state || "*", region || "*"].join("|");
    const cached = readCache(cacheState.products?.[cacheKey]);
    if (cached) {
      return res.json({ success: true, products: cached, cached: true });
    }

    const query = { isActive: true };
    if (category) query.category = category;

    const productsRaw = await Product.find(query)
      .select(
        "name shortDescription fullDescription category subCategory tags mrp sellingPrice discountPercent discountAmount media imageUrl imageKey inventory brand sku expiryDate prescriptionRequired customFields geoScope targetCountries targetStates targetRegions isActive createdAt updatedAt"
      )
      .sort({ updatedAt: -1 })
      .lean();
    const products = await Promise.all(
      productsRaw
        .filter((product) => matchesGeoTargets(product, { country, state, region }))
        .map(async (product) => ({
          ...product,
          imageUrl: await resolveStoredMediaUrl({
            imageUrl: product.imageUrl,
            imageKey: product.imageKey,
          }),
        }))
    );
    const currentProductsCache = cacheState.products || {};
    currentProductsCache[cacheKey] = writeCache(products);
    cacheState.products = currentProductsCache;

    return res.json({ success: true, products, cached: false });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
});

router.get("/ui-config", async (req, res) => {
  try {
    const cached = readCache(cacheState.uiConfig);
    if (cached) {
      return res.json({ success: true, config: cached, cached: true });
    }

    let config = await UIConfig.findOne({ key: "GLOBAL" }).lean();
    if (!config) {
      const created = await UIConfig.create({ key: "GLOBAL" });
      config = created.toObject();
    }

    const alerts = Array.isArray(config.dashboardAlerts)
      ? config.dashboardAlerts.map((alert) => {
          const platforms = normalizeAlertPlatforms(
            alert?.platforms ?? alert?.platform
          );
          return {
            ...alert,
            platforms,
            platform:
              platforms.length >= PUBLIC_ALERT_PLATFORMS.length
                ? "ALL"
                : platforms.join(","),
          };
        })
      : [];

    const payload = {
      buttonColor: config.buttonColor,
      iconColor: config.iconColor,
      cardStyle: config.cardStyle,
      themeMode: config.themeMode,
      qrActions: config.qrActions || [],
      dashboardCards: config.dashboardCards || [],
      dashboardAlerts: alerts,
      updatedAt: config.updatedAt,
    };

    cacheState.uiConfig = writeCache(payload);
    return res.json({ success: true, config: payload, cached: false });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch UI config",
      error: error.message,
    });
  }
});

export default router;
