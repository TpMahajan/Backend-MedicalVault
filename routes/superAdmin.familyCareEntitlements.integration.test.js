import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// Regression coverage for a real production bug: PUT
// /superadmin/family-care-entitlements/:userId let an admin save
// status="active"/"trial" with enabled=false (toBoolean(req.body.enabled,
// false) silently defaults to false when the request omits it, or the admin
// UI's independent checkbox was left unchecked). That combination can never
// actually grant Family Care access
// (see services/familyCareEntitlementService.resolveFamilyCareEntitlementWithConfig),
// so a user could be told "granted" while still seeing "Family Care access
// is required". The route must now reject that combination outright.

const state = {
  user: null,
  familyCareConfig: { key: "GLOBAL", enabled: true, limits: { maxManagedProfiles: 5, maxCaregiversPerProfile: 5 } },
};

const requireSuperAdminAuthMock = jest.fn((req, _res, next) => {
  req.auth = { id: "superadmin@example.com", email: "superadmin@example.com" };
  req.superAdmin = { email: "superadmin@example.com" };
  next();
});

const writeAuditLogMock = jest.fn(async () => {});

const userFindOneAndUpdateMock = jest.fn((filter, update) => {
  if (!state.user || String(state.user._id) !== String(filter._id)) {
    return { select: () => ({ lean: async () => null }) };
  }
  state.user = { ...state.user, entitlements: { familyCare: update.$set["entitlements.familyCare"] } };
  return { select: () => ({ lean: async () => state.user }) };
});

await jest.unstable_mockModule("../middleware/superAdminAuth.js", () => ({
  requireSuperAdminAuth: requireSuperAdminAuthMock,
}));

await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({
  writeAuditLog: writeAuditLogMock,
}));

await jest.unstable_mockModule("../models/User.js", () => ({
  User: {
    findOneAndUpdate: userFindOneAndUpdateMock,
    find: jest.fn(() => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) })),
  },
}));

await jest.unstable_mockModule("../services/familyCareConfigService.js", () => ({
  getFamilyCareConfig: jest.fn(async () => state.familyCareConfig),
  clearFamilyCareConfigCache: jest.fn(),
  normalizeFamilyCareConfigInput: jest.fn((body) => body),
}));

await jest.unstable_mockModule("../config/firebase.js", () => ({
  initializeFirebase: jest.fn(),
  sendPushNotification: jest.fn(),
}));

// Everything below this line has nothing to do with the entitlements route
// but is imported by routes/superAdmin.js at module scope, so it must be
// stubbed out for the module to load in a test environment.
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({ DoctorUser: {} }));
await jest.unstable_mockModule("../models/SuperAdminCredential.js", () => ({ SuperAdminCredential: {} }));
await jest.unstable_mockModule("../models/Advertisement.js", () => ({ Advertisement: {} }));
await jest.unstable_mockModule("../models/Product.js", () => ({ Product: {} }));
await jest.unstable_mockModule("../models/UIConfig.js", () => ({ UIConfig: {} }));
await jest.unstable_mockModule("../models/AISettings.js", () => ({ AISettings: {} }));
await jest.unstable_mockModule("../models/AIUsage.js", () => ({ AIUsage: {} }));
await jest.unstable_mockModule("../models/FamilyCarePlatformConfig.js", () => ({ FamilyCarePlatformConfig: {} }));
await jest.unstable_mockModule("../models/Notification.js", () => ({ Notification: {} }));
await jest.unstable_mockModule("../models/Appointment.js", () => ({ Appointment: {} }));
await jest.unstable_mockModule("../models/Session.js", () => ({ Session: {} }));
await jest.unstable_mockModule("../models/File.js", () => ({ Document: {} }));
await jest.unstable_mockModule("../models/SosEvent.js", () => ({ SosEvent: {} }));
await jest.unstable_mockModule("../models/InventoryOrder.js", () => ({ InventoryOrder: {} }));
await jest.unstable_mockModule("../models/SuperAdminActivityLog.js", () => ({
  SuperAdminActivityLog: { create: jest.fn(async () => {}) },
}));
await jest.unstable_mockModule("../models/AdvertisementClickLog.js", () => ({ AdvertisementClickLog: {} }));
await jest.unstable_mockModule("./publicConfig.js", () => ({ clearPublicConfigCache: jest.fn() }));
await jest.unstable_mockModule("../services/notificationDeliveryService.js", () => ({
  deliverNotifications: jest.fn(async () => {}),
}));
await jest.unstable_mockModule("../models/DeviceToken.js", () => ({ DeviceToken: {} }));
await jest.unstable_mockModule("../config/s3.js", () => ({ default: {}, BUCKET_NAME: "test-bucket" }));
await jest.unstable_mockModule("../utils/s3Utils.js", () => ({ generateSignedUrl: jest.fn() }));
await jest.unstable_mockModule("../services/tokenService.js", () => ({
  parseCookies: jest.fn(),
  setAuthCookies: jest.fn(),
  clearAuthCookies: jest.fn(),
  verifyRefreshToken: jest.fn(),
  hashToken: jest.fn(),
  issueAuthTokenSet: jest.fn(),
}));
await jest.unstable_mockModule("../models/RefreshToken.js", () => ({ RefreshToken: {} }));
await jest.unstable_mockModule("../services/authSessionRealtime.js", () => ({
  emitSessionInvalidatedEvent: jest.fn(),
}));
await jest.unstable_mockModule("../services/storeInventoryBridge.js", () => ({
  ensureInventoryForProduct: jest.fn(),
  removeInventoryForProduct: jest.fn(),
}));
await jest.unstable_mockModule("../services/publicConfigRealtime.js", () => ({
  PUBLIC_AD_SURFACES: [],
  PUBLIC_ALERT_PLATFORMS: [],
  broadcastPublicConfigEvent: jest.fn(),
}));
await jest.unstable_mockModule("../services/aiGovernance.js", () => ({
  getAISettings: jest.fn(async () => ({})),
  getDateKey: jest.fn(() => "2026-07-16"),
  summarizeAIUsage: jest.fn(async () => ({})),
}));

const { default: superAdminRouter } = await import("./superAdmin.js");

const app = express();
app.use(express.json());
app.use("/api/superadmin", superAdminRouter);

describe("PUT /superadmin/family-care-entitlements/:userId", () => {
  const userId = "665f1f1f1f1f1f1f1f1f1f1f";

  beforeEach(() => {
    state.user = {
      _id: userId,
      name: "Test Patient",
      email: "patient@example.com",
      status: "ACTIVE",
      entitlements: { familyCare: { enabled: false, status: "expired" } },
    };
    state.familyCareConfig = {
      key: "GLOBAL",
      enabled: true,
      limits: { maxManagedProfiles: 5, maxCaregiversPerProfile: 5 },
    };
    writeAuditLogMock.mockClear();
    userFindOneAndUpdateMock.mockClear();
  });

  it("rejects status=active with enabled omitted (defaults false) instead of silently saving a no-op grant", async () => {
    const res = await request(app)
      .put(`/api/superadmin/family-care-entitlements/${userId}`)
      .send({ status: "active" }); // enabled intentionally omitted, mirrors the real bug

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/enabled.*true|status.*requires/i);
    expect(userFindOneAndUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects status=active with enabled explicitly false", async () => {
    const res = await request(app)
      .put(`/api/superadmin/family-care-entitlements/${userId}`)
      .send({ status: "active", enabled: false });

    expect(res.status).toBe(400);
    expect(userFindOneAndUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects status=trial with enabled omitted", async () => {
    const res = await request(app)
      .put(`/api/superadmin/family-care-entitlements/${userId}`)
      .send({ status: "trial" });

    expect(res.status).toBe(400);
    expect(userFindOneAndUpdateMock).not.toHaveBeenCalled();
  });

  it("accepts status=active with enabled=true and actually persists it", async () => {
    const res = await request(app)
      .put(`/api/superadmin/family-care-entitlements/${userId}`)
      .send({ status: "active", enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.entitlements.familyCare.enabled).toBe(true);
    expect(res.body.user.entitlements.familyCare.status).toBe("active");
    expect(userFindOneAndUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("allows status=expired with enabled=false (a legitimate revoke)", async () => {
    const res = await request(app)
      .put(`/api/superadmin/family-care-entitlements/${userId}`)
      .send({ status: "expired", enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.user.entitlements.familyCare.enabled).toBe(false);
    expect(res.body.user.entitlements.familyCare.status).toBe("expired");
  });

  it("allows status=suspended with enabled=false (a legitimate suspend)", async () => {
    const res = await request(app)
      .put(`/api/superadmin/family-care-entitlements/${userId}`)
      .send({ status: "suspended", enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.user.entitlements.familyCare.status).toBe("suspended");
  });
});
