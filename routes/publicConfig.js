import express from "express";
import { randomUUID } from "node:crypto";

import { Advertisement } from "../models/Advertisement.js";
import { AdvertisementClickLog } from "../models/AdvertisementClickLog.js";
import { Product } from "../models/Product.js";
import { UIConfig } from "../models/UIConfig.js";

const router = express.Router();

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

router.get("/ads", async (req, res) => {
  try {
    const placement = String(req.query.placement || "").toUpperCase().trim();
    const cacheKey = placement || "ALL";
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
      query.placement = placement;
    }

    const ads = await Advertisement.find(query)
      .sort({ placement: 1, createdAt: -1 })
      .lean();

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

    const body = req.body || {};
    const platform = normalizePlatform(body.platform || req.query.platform);
    const surface = normalizeSurface(body.surface || req.query.surface, ad.placement);
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
      placement: ad.placement,
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
    const cacheKey = category || "ALL";
    const cached = readCache(cacheState.products?.[cacheKey]);
    if (cached) {
      return res.json({ success: true, products: cached, cached: true });
    }

    const query = { isActive: true };
    if (category) query.category = category;

    const products = await Product.find(query).sort({ createdAt: -1 }).lean();
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

    const payload = {
      buttonColor: config.buttonColor,
      iconColor: config.iconColor,
      cardStyle: config.cardStyle,
      themeMode: config.themeMode,
      qrActions: config.qrActions || [],
      dashboardCards: config.dashboardCards || [],
      dashboardAlerts: config.dashboardAlerts || [],
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
