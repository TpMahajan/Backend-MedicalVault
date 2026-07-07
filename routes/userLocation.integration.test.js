import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const state = { lastUpdate: null };

const authMock = jest.fn((req, res, next) => {
  const role = String(req.headers["x-test-role"] || "").toLowerCase();
  if (!role || role === "anonymous") {
    return res.status(401).json({ success: false, message: "Auth required" });
  }
  req.auth = { role, id: "patient-1" };
  req.user = { _id: "patient-1" };
  next();
});

const userFindByIdAndUpdateMock = jest.fn((id, update) => {
  state.lastUpdate = update;
  return {
    select: async () => ({
      locationSharingEnabled: update.locationSharingEnabled ?? false,
      lostPersonAlertsOptOut: update.lostPersonAlertsOptOut ?? false,
      lastKnownLocationUpdatedAt: update.lastKnownLocationUpdatedAt ?? null,
      lastKnownLocationAddress: update.lastKnownLocationAddress ?? null,
    }),
  };
});

await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: authMock,
}));
await jest.unstable_mockModule("../middleware/validation.js", () => ({
  updateProfileValidation: (req, res, next) => next(),
  fcmTokenValidation: (req, res, next) => next(),
}));
await jest.unstable_mockModule("../middleware/rateLimit.js", () => ({
  fcmLimiter: (req, res, next) => next(),
}));
await jest.unstable_mockModule("../middleware/checkSession.js", () => ({
  checkSession: (req, res, next) => next(),
}));
await jest.unstable_mockModule("../middleware/rbac.js", () => ({
  checkRole: () => (req, res, next) => next(),
  requireOwnerOrRoles: () => (req, res, next) => next(),
}));
await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({
  auditTrail: () => (req, res, next) => next(),
  writeAuditLog: jest.fn(),
}));
await jest.unstable_mockModule("../models/User.js", () => ({
  User: { findByIdAndUpdate: userFindByIdAndUpdateMock },
}));
await jest.unstable_mockModule("../config/s3.js", () => ({
  default: { config: { credentials: null } },
  BUCKET_NAME: "test-bucket",
  REGION: "test-region",
}));

const { default: userRouter } = await import("./user.js");

const app = express();
app.use(express.json());
app.use("/api/users", userRouter);

describe("PUT /api/users/location", () => {
  beforeEach(() => {
    state.lastUpdate = null;
    userFindByIdAndUpdateMock.mockClear();
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .put("/api/users/location")
      .set("x-test-role", "anonymous")
      .send({ lat: 19.99, lng: 73.79 });
    expect(res.status).toBe(401);
  });

  it("stores coordinates as GeoJSON [lng, lat] with sharing flag", async () => {
    const res = await request(app)
      .put("/api/users/location")
      .set("x-test-role", "patient")
      .send({
        lat: 19.9975,
        lng: 73.7898,
        address: "Nashik, Maharashtra",
        locationSharingEnabled: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(state.lastUpdate.lastKnownLocation).toEqual({
      type: "Point",
      coordinates: [73.7898, 19.9975],
    });
    expect(state.lastUpdate.locationSharingEnabled).toBe(true);
    expect(state.lastUpdate.lastKnownLocationAddress).toBe("Nashik, Maharashtra");
  });

  it("rejects out-of-range coordinates", async () => {
    const res = await request(app)
      .put("/api/users/location")
      .set("x-test-role", "patient")
      .send({ lat: 200, lng: 73.79 });
    expect(res.status).toBe(400);
  });

  it("allows toggling sharing off without coordinates", async () => {
    const res = await request(app)
      .put("/api/users/location")
      .set("x-test-role", "patient")
      .send({ locationSharingEnabled: false });
    expect(res.status).toBe(200);
    expect(state.lastUpdate.locationSharingEnabled).toBe(false);
    expect(state.lastUpdate.lastKnownLocation).toBeUndefined();
  });

  it("400s when no location fields are provided", async () => {
    const res = await request(app)
      .put("/api/users/location")
      .set("x-test-role", "patient")
      .send({});
    expect(res.status).toBe(400);
  });
});
