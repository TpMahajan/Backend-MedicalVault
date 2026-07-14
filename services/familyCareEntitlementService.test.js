import { resolveFamilyCareEntitlementWithConfig } from "./familyCareEntitlementService.js";

const enabledConfig = (overrides = {}) => ({
  enabled: true,
  developmentAutoEntitle: false,
  features: {},
  limits: { maxManagedProfiles: 5, maxCaregiversPerProfile: 5 },
  ...overrides,
});

describe("Family Care entitlements", () => {
  it("is fail-closed when the persisted platform switch is off", () => {
    const result = resolveFamilyCareEntitlementWithConfig({}, { enabled: false }, { nodeEnv: "production" });
    expect(result.code).toBe("FAMILY_CARE_DISABLED");
  });

  it("rejects an expired subscription even when enabled", () => {
    const result = resolveFamilyCareEntitlementWithConfig({ entitlements: { familyCare: {
      enabled: true,
      status: "active",
      subscriptionEndsAt: new Date(Date.now() - 1000),
    } } }, enabledConfig(), { nodeEnv: "production" });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("FAMILY_CARE_ENTITLEMENT_EXPIRED");
  });

  it("allows an unexpired trial and applies platform hard caps", () => {
    const result = resolveFamilyCareEntitlementWithConfig({ entitlements: { familyCare: {
      enabled: true,
      status: "trial",
      trialEndsAt: new Date(Date.now() + 60000),
      limits: { maxManagedProfiles: 20, maxCaregiversPerProfile: 3 },
    } } }, enabledConfig({ limits: { maxManagedProfiles: 7, maxCaregiversPerProfile: 8 } }), { nodeEnv: "production" });
    expect(result.allowed).toBe(true);
    expect(result.limits).toEqual({ maxManagedProfiles: 7, maxCaregiversPerProfile: 3 });
  });

  it("uses SuperAdmin development auto-entitlement only outside production", () => {
    const config = enabledConfig({ developmentAutoEntitle: true });
    expect(resolveFamilyCareEntitlementWithConfig({}, config, { nodeEnv: "development" }).allowed).toBe(true);
    expect(resolveFamilyCareEntitlementWithConfig({}, config, { nodeEnv: "production" }).allowed).toBe(false);
  });

  it("returns distinct expired and suspended entitlement codes", () => {
    const expired = resolveFamilyCareEntitlementWithConfig({ entitlements: { familyCare: {
      enabled: true,
      status: "active",
      subscriptionEndsAt: new Date(Date.now() - 1000),
    } } }, enabledConfig(), { nodeEnv: "production" });
    const suspended = resolveFamilyCareEntitlementWithConfig({ entitlements: { familyCare: {
      enabled: true,
      status: "suspended",
    } } }, enabledConfig(), { nodeEnv: "production" });
    expect(expired.code).toBe("FAMILY_CARE_ENTITLEMENT_EXPIRED");
    expect(suspended.code).toBe("FAMILY_CARE_ENTITLEMENT_SUSPENDED");
  });
});
