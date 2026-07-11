import { getFamilyCareConfig } from "./familyCareConfigService.js";

const isDateActive = (date) => !date || new Date(date).getTime() > Date.now();

const configuredFlags = (config) => ({
  enabled: config?.enabled === true,
  medicationV2: config?.enabled === true && config?.features?.medicationV2 === true,
  caregiverAlerts: config?.enabled === true && config?.features?.caregiverAlerts === true,
  insights: config?.enabled === true && config?.features?.insights === true,
  emergencyCardV2: config?.enabled === true && config?.features?.emergencyCardV2 === true,
  vaccination: config?.enabled === true && config?.features?.vaccination === true,
  insurance: config?.enabled === true && config?.features?.insurance === true,
});

export const resolveFamilyCareEntitlementWithConfig = (user, config, {
  nodeEnv = process.env.NODE_ENV,
} = {}) => {
  const flags = configuredFlags(config);
  if (!flags.enabled) {
    return { allowed: false, code: "FAMILY_CARE_DISABLED", flags };
  }

  const production = String(nodeEnv || "development").toLowerCase() === "production";
  const platformLimits = {
    maxManagedProfiles: Number(config?.limits?.maxManagedProfiles ?? 5),
    maxCaregiversPerProfile: Number(config?.limits?.maxCaregiversPerProfile ?? 5),
  };
  if (!production && config?.developmentAutoEntitle === true) {
    return {
      allowed: true,
      source: "platform_development_default",
      status: "trial",
      limits: platformLimits,
      flags,
    };
  }

  const entitlement = user?.entitlements?.familyCare;
  const validStatus = entitlement?.status === "active" || entitlement?.status === "trial";
  const expiry = entitlement?.status === "trial"
    ? entitlement?.trialEndsAt
    : entitlement?.subscriptionEndsAt;
  const allowed = entitlement?.enabled === true && validStatus && isDateActive(expiry);
  const userManagedLimit = Number(entitlement?.limits?.maxManagedProfiles ?? platformLimits.maxManagedProfiles);
  const userCaregiverLimit = Number(entitlement?.limits?.maxCaregiversPerProfile ?? platformLimits.maxCaregiversPerProfile);
  return {
    allowed,
    code: allowed ? "" : "FAMILY_CARE_ENTITLEMENT_REQUIRED",
    source: "user_entitlement",
    status: entitlement?.status || "expired",
    limits: {
      maxManagedProfiles: Math.max(0, Math.min(userManagedLimit, platformLimits.maxManagedProfiles)),
      maxCaregiversPerProfile: Math.max(0, Math.min(userCaregiverLimit, platformLimits.maxCaregiversPerProfile)),
    },
    flags,
  };
};

export const resolveFamilyCareEntitlement = async (user) => {
  const config = await getFamilyCareConfig();
  return resolveFamilyCareEntitlementWithConfig(user, config);
};
