import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// Regression coverage for a real bug: the "Top Doctors" dashboard toggle
// (Settings > Controls) was only ever persisted to local SharedPreferences
// on the device, so it reset to ON whenever the user logged in on a
// different device or reinstalled the app. These routes make it a
// per-account preference synced from the backend, mirroring the existing
// allowMultipleSessions ("session policy") pattern.

const state = { user: null };

const authMiddlewareMock = jest.fn((req, _res, next) => {
  req.auth = { id: state.user?._id || "patient-1", role: "patient" };
  next();
});

const userFindByIdMock = jest.fn(() => ({
  select: () => ({ lean: async () => state.user }),
}));

const userFindByIdAndUpdateMock = jest.fn((_id, update) => {
  if (!state.user) return { lean: async () => null };
  const showTopDoctors = update.$set["dashboardPreferences.showTopDoctors"];
  state.user = {
    ...state.user,
    dashboardPreferences: { showTopDoctors },
  };
  return { lean: async () => state.user };
});

await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: authMiddlewareMock,
}));
await jest.unstable_mockModule("../models/User.js", () => ({
  User: {
    findById: userFindByIdMock,
    findByIdAndUpdate: userFindByIdAndUpdateMock,
  },
}));

// Everything below has nothing to do with these two routes but is imported
// by routes/authRoutes.js at module scope, so it must be stubbed for the
// module to load in a test environment.
await jest.unstable_mockModule("express-rate-limit", () => ({
  default: () => (req, _res, next) => next(),
}));
await jest.unstable_mockModule("../middleware/rateLimit.js", () => ({
  authLimiter: (req, _res, next) => next(),
}));
await jest.unstable_mockModule("../controllers/authController.js", () => ({
  getMe: jest.fn(),
  updateMe: jest.fn(),
}));
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({ DoctorUser: {} }));
await jest.unstable_mockModule("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken() {}
  },
}));
await jest.unstable_mockModule("../models/EmailVerify.js", () => ({ EmailVerify: {} }));
await jest.unstable_mockModule("../utils/emailService.js", () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
}));
await jest.unstable_mockModule("../config/s3.js", () => ({ default: {}, BUCKET_NAME: "test-bucket" }));
await jest.unstable_mockModule("@aws-sdk/client-s3", () => ({ GetObjectCommand: class {} }));
await jest.unstable_mockModule("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }));
await jest.unstable_mockModule("../utils/userResponse.js", () => ({ buildUserResponse: jest.fn((u) => u) }));
await jest.unstable_mockModule("../services/tokenService.js", () => ({
  clearAuthCookies: jest.fn(),
  hashToken: jest.fn(),
  issueAuthTokenSet: jest.fn(),
  parseCookies: jest.fn(),
  signLoginAttemptToken: jest.fn(),
  setAuthCookies: jest.fn(),
  verifyLoginAttemptToken: jest.fn(),
  verifyRefreshToken: jest.fn(),
}));
await jest.unstable_mockModule("../models/RefreshToken.js", () => ({ RefreshToken: {} }));
await jest.unstable_mockModule("../models/LoginAttempt.js", () => ({ LoginAttempt: {} }));
await jest.unstable_mockModule("../services/securityMonitorService.js", () => ({
  isActorTemporarilyBlocked: jest.fn(),
  monitorFailedLogin: jest.fn(),
  monitorSuspiciousSession: jest.fn(),
}));
await jest.unstable_mockModule("../services/authSessionRealtime.js", () => ({
  emitLoginApprovedEvent: jest.fn(),
  emitLoginAttemptEvent: jest.fn(),
  emitLoginDeniedEvent: jest.fn(),
  emitSessionInvalidatedEvent: jest.fn(),
  hasActiveSessionSocket: jest.fn(),
}));

const { default: authRouter } = await import("./authRoutes.js");

const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);

describe("GET/PUT /auth/dashboard-preferences", () => {
  beforeEach(() => {
    state.user = { _id: "patient-1", dashboardPreferences: { showTopDoctors: true } };
    userFindByIdMock.mockClear();
    userFindByIdAndUpdateMock.mockClear();
  });

  it("returns the saved preference (default true) for a patient", async () => {
    const res = await request(app).get("/api/auth/dashboard-preferences");
    expect(res.status).toBe(200);
    expect(res.body.dashboardPreferences.showTopDoctors).toBe(true);
  });

  it("reflects a previously saved false value", async () => {
    state.user.dashboardPreferences.showTopDoctors = false;
    const res = await request(app).get("/api/auth/dashboard-preferences");
    expect(res.status).toBe(200);
    expect(res.body.dashboardPreferences.showTopDoctors).toBe(false);
  });

  it("persists turning the toggle off", async () => {
    const res = await request(app)
      .put("/api/auth/dashboard-preferences")
      .send({ showTopDoctors: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dashboardPreferences.showTopDoctors).toBe(false);
    expect(userFindByIdAndUpdateMock).toHaveBeenCalledWith(
      "patient-1",
      { $set: { "dashboardPreferences.showTopDoctors": false } },
      expect.objectContaining({ new: true }),
    );

    // Simulates "log in on another device": a fresh GET must see the
    // persisted value, not a device-local default.
    const followUp = await request(app).get("/api/auth/dashboard-preferences");
    expect(followUp.body.dashboardPreferences.showTopDoctors).toBe(false);
  });

  it("persists turning the toggle back on", async () => {
    state.user.dashboardPreferences.showTopDoctors = false;
    const res = await request(app)
      .put("/api/auth/dashboard-preferences")
      .send({ showTopDoctors: true });

    expect(res.status).toBe(200);
    expect(res.body.dashboardPreferences.showTopDoctors).toBe(true);
  });

  it("rejects the update when showTopDoctors is omitted", async () => {
    const res = await request(app).put("/api/auth/dashboard-preferences").send({});
    expect(res.status).toBe(400);
    expect(userFindByIdAndUpdateMock).not.toHaveBeenCalled();
  });

  it("denies non-patient roles from updating the preference", async () => {
    authMiddlewareMock.mockImplementationOnce((req, _res, next) => {
      req.auth = { id: "doctor-1", role: "doctor" };
      next();
    });
    const res = await request(app)
      .put("/api/auth/dashboard-preferences")
      .send({ showTopDoctors: false });
    expect(res.status).toBe(403);
  });

  it("returns a read-only default for non-patient roles on GET", async () => {
    authMiddlewareMock.mockImplementationOnce((req, _res, next) => {
      req.auth = { id: "doctor-1", role: "doctor" };
      next();
    });
    const res = await request(app).get("/api/auth/dashboard-preferences");
    expect(res.status).toBe(200);
    expect(res.body.readOnly).toBe(true);
    expect(res.body.dashboardPreferences.showTopDoctors).toBe(true);
  });
});
