import { writeAuditLog } from "../middleware/auditLogger.js";
import {
  FAMILY_CARE_NOTIFICATION_KEYS,
  normalizeFamilyCareNotificationPreferences,
  preferencesForProfile,
} from "../services/familyCareNotificationService.js";

const allowedKeys = new Set([...FAMILY_CARE_NOTIFICATION_KEYS, "quietHours"]);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Express 4 does not forward rejected async handlers automatically.  These
// settings are updated from the mobile client, so a validation/database/audit
// failure must be returned as JSON rather than leaving the HTTP socket open
// (or becoming an unhandled rejection that exits the process).
const safely = (handler) => async (req, res) => {
  try {
    return await handler(req, res);
  } catch (error) {
    console.error("Family Care notification preference request failed:", error.message);
    if (res.headersSent) return undefined;
    return res.status(500).json({
      success: false,
      code: "FAMILY_CARE_NOTIFICATION_PREFERENCES_UNAVAILABLE",
      message: "Family Care notification preferences could not be saved. Please try again.",
    });
  }
};

const validate = (patch = {}) => {
  const fields = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!allowedKeys.has(key)) fields[key] = "This notification preference is not supported.";
    if (FAMILY_CARE_NOTIFICATION_KEYS.includes(key) && typeof value !== "boolean") fields[key] = "Use true or false.";
  }
  if (patch.quietHours !== undefined) {
    if (!patch.quietHours || typeof patch.quietHours !== "object") fields.quietHours = "Quiet hours must be an object.";
    else {
      if (patch.quietHours.enabled !== undefined && typeof patch.quietHours.enabled !== "boolean") fields["quietHours.enabled"] = "Use true or false.";
      if (patch.quietHours.start !== undefined && !TIME.test(String(patch.quietHours.start))) fields["quietHours.start"] = "Use HH:mm.";
      if (patch.quietHours.end !== undefined && !TIME.test(String(patch.quietHours.end))) fields["quietHours.end"] = "Use HH:mm.";
    }
  }
  return fields;
};

const merge = (current, patch) => normalizeFamilyCareNotificationPreferences({
  ...normalizeFamilyCareNotificationPreferences(current),
  ...patch,
  quietHours: { ...(current?.quietHours?.toObject?.() || current?.quietHours || {}), ...(patch.quietHours || {}) },
});

export const getGlobalFamilyCareNotificationPreferences = safely(async (req, res) => res.json({
  success: true,
  data: { preferences: normalizeFamilyCareNotificationPreferences(req.user.familyCareNotificationPreferences || {}) },
}));

export const updateGlobalFamilyCareNotificationPreferences = safely(async (req, res) => {
  const fields = validate(req.body || {});
  if (Object.keys(fields).length) return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Please correct notification preferences.", error: { code: "VALIDATION_ERROR", fields } });
  const current = req.user.familyCareNotificationPreferences?.toObject?.() || req.user.familyCareNotificationPreferences || {};
  const preferences = merge(current, req.body || {});
  req.user.familyCareNotificationPreferences = {
    ...preferences,
    profileOverrides: current.profileOverrides || [],
  };
  await req.user.save();
  await writeAuditLog({ req, action: "family_notification_preferences_updated", resourceType: "UserFamilyCareNotificationPreferences", resourceId: req.auth.id });
  return res.json({ success: true, data: { preferences } });
});

export const getProfileFamilyCareNotificationPreferences = safely(async (req, res) => res.json({
  success: true,
  data: { preferences: preferencesForProfile(req.user, req.patientProfile._id) },
}));

export const updateProfileFamilyCareNotificationPreferences = safely(async (req, res) => {
  const fields = validate(req.body || {});
  if (Object.keys(fields).length) return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Please correct notification preferences.", error: { code: "VALIDATION_ERROR", fields } });
  const settings = req.user.familyCareNotificationPreferences || {};
  const global = normalizeFamilyCareNotificationPreferences(settings.toObject?.() || settings);
  const overrides = [...(settings.profileOverrides?.toObject?.() || settings.profileOverrides || [])];
  const index = overrides.findIndex((item) => String(item.patientProfileId) === String(req.patientProfile._id));
  const existing = index >= 0 ? overrides[index] : global;
  const preferences = merge(existing, req.body || {});
  const override = { patientProfileId: req.patientProfile._id, ...preferences };
  if (index >= 0) overrides[index] = override;
  else overrides.push(override);
  req.user.familyCareNotificationPreferences = { ...global, profileOverrides: overrides };
  await req.user.save();
  await writeAuditLog({ req, action: "family_profile_notification_preferences_updated", resourceType: "UserFamilyCareNotificationPreferences", resourceId: req.auth.id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, data: { preferences } });
});
