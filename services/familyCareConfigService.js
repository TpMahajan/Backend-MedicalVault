import { FamilyCarePlatformConfig } from "../models/FamilyCarePlatformConfig.js";

const CACHE_TTL_MS = 15_000;
let cached = null;
let cachedUntil = 0;

const plain = (value) => {
  if (!value) return null;
  return typeof value.toObject === "function" ? value.toObject() : value;
};

export const getFamilyCareConfig = async ({ fresh = false } = {}) => {
  if (!fresh && cached && Date.now() < cachedUntil) return cached;
  let config = await FamilyCarePlatformConfig.findOne({ key: "GLOBAL" }).lean();
  if (!config) {
    const created = await FamilyCarePlatformConfig.findOneAndUpdate(
      { key: "GLOBAL" },
      { $setOnInsert: { key: "GLOBAL" } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    config = plain(created);
  }
  cached = config;
  cachedUntil = Date.now() + CACHE_TTL_MS;
  return config;
};

export const clearFamilyCareConfigCache = () => {
  cached = null;
  cachedUntil = 0;
};

const booleanValue = (value, fallback) => {
  if (typeof value === "boolean") return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  return fallback;
};

const boundedInteger = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
};

export const normalizeFamilyCareConfigInput = (body = {}, existing = {}) => {
  const features = body.features && typeof body.features === "object" ? body.features : {};
  const limits = body.limits && typeof body.limits === "object" ? body.limits : {};
  const invitations = body.invitations && typeof body.invitations === "object" ? body.invitations : {};
  return {
    enabled: booleanValue(body.enabled, existing.enabled ?? false),
    developmentAutoEntitle: booleanValue(
      body.developmentAutoEntitle,
      existing.developmentAutoEntitle ?? false,
    ),
    features: {
      medicationV2: booleanValue(features.medicationV2, existing.features?.medicationV2 ?? false),
      caregiverAlerts: booleanValue(features.caregiverAlerts, existing.features?.caregiverAlerts ?? false),
      insights: booleanValue(features.insights, existing.features?.insights ?? false),
      emergencyCardV2: booleanValue(features.emergencyCardV2, existing.features?.emergencyCardV2 ?? false),
      vaccination: booleanValue(features.vaccination, existing.features?.vaccination ?? false),
      insurance: booleanValue(features.insurance, existing.features?.insurance ?? false),
    },
    limits: {
      maxManagedProfiles: boundedInteger(limits.maxManagedProfiles, existing.limits?.maxManagedProfiles ?? 5, 0, 50),
      maxCaregiversPerProfile: boundedInteger(limits.maxCaregiversPerProfile, existing.limits?.maxCaregiversPerProfile ?? 5, 0, 50),
    },
    invitations: {
      windowMinutes: boundedInteger(invitations.windowMinutes, existing.invitations?.windowMinutes ?? 60, 1, 1440),
      maxPerWindow: boundedInteger(invitations.maxPerWindow, existing.invitations?.maxPerWindow ?? 10, 1, 1000),
    },
  };
};
