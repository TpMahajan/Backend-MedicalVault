import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";

// Verifies the security-critical rewrite of checkSession: a doctor's access
// is now authorized exclusively by an active SessionAccessGrant for a
// currently-accepted Session, never by the old binary
// canDoctorAccessPatient() check. Patient/admin/superadmin behavior must be
// completely unchanged.

const PATIENT_ID = "507f1f77bcf86cd799439011";
const DOCTOR_ID = "507f1f77bcf86cd799439012";
const SESSION_ID = "507f1f77bcf86cd799439013";

const sessionFindOneMock = jest.fn();
const resolveActiveGrantMock = jest.fn();
const userFindOneMock = jest.fn();
const documentFindByIdMock = jest.fn();

await jest.unstable_mockModule("../models/User.js", () => ({
  User: { findOne: (...args) => ({ select: () => ({ lean: async () => userFindOneMock(...args) }) }) },
}));
await jest.unstable_mockModule("../models/Session.js", () => ({
  Session: {
    findOne: (...args) => ({
      sort: () => ({ select: () => ({ lean: async () => sessionFindOneMock(...args) }) }),
    }),
  },
}));
await jest.unstable_mockModule("../models/File.js", () => ({
  Document: { findById: (...args) => ({ select: () => ({ lean: async () => documentFindByIdMock(...args) }) }) },
}));
await jest.unstable_mockModule("../services/sessionAccessGrantService.js", () => ({
  resolveActiveGrant: resolveActiveGrantMock,
}));

const { checkSession, checkSessionByEmail } = await import("./checkSession.js");

const buildApp = () => {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = req.headers["x-test-role"]
      ? { id: req.headers["x-test-id"], role: req.headers["x-test-role"] }
      : undefined;
    next();
  });
  app.get("/patient/:patientId", checkSession, (req, res) =>
    res.json({ success: true, grant: req.sessionAccessGrant ? "present" : null })
  );
  app.get("/user/:userId", checkSession, (req, res) => res.json({ success: true }));
  app.get("/doc/:id", checkSession, (req, res) => res.json({ success: true }));
  app.get("/by-email/:email", checkSessionByEmail, (req, res) => res.json({ success: true }));
  return app;
};

const withRole = (req, role, id) => req.set("x-test-role", role).set("x-test-id", id);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("checkSession — patient role", () => {
  it("allows a patient to access their own resource", async () => {
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "patient", PATIENT_ID);
    expect(res.status).toBe(200);
    expect(sessionFindOneMock).not.toHaveBeenCalled();
  });

  it("rejects a patient accessing another patient's resource", async () => {
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "patient", "507f1f77bcf86cd799439099");
    expect(res.status).toBe(403);
  });
});

describe("checkSession — admin/superadmin roles", () => {
  it("allows admin through without consulting Session or the grant service", async () => {
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "admin", "some-admin-id");
    expect(res.status).toBe(200);
    expect(sessionFindOneMock).not.toHaveBeenCalled();
    expect(resolveActiveGrantMock).not.toHaveBeenCalled();
  });

  it("allows superadmin through the same way", async () => {
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "superadmin", "some-superadmin-id");
    expect(res.status).toBe(200);
  });
});

describe("checkSession — doctor role (the rewritten security surface)", () => {
  it("rejects a doctor when there is no accepted session at all (previously: canDoctorAccessPatient false)", async () => {
    sessionFindOneMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "doctor", DOCTOR_ID);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NO_ACTIVE_SESSION");
    expect(resolveActiveGrantMock).not.toHaveBeenCalled();
  });

  it("rejects a doctor when an accepted session exists but its grant was revoked", async () => {
    sessionFindOneMock.mockResolvedValue({ _id: SESSION_ID });
    resolveActiveGrantMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "doctor", DOCTOR_ID);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NO_ACTIVE_SESSION");
  });

  it("rejects a doctor when the grant has expired even though the check runs after Session's own expiresAt filter (defense in depth)", async () => {
    sessionFindOneMock.mockResolvedValue({ _id: SESSION_ID });
    resolveActiveGrantMock.mockResolvedValue(null); // resolveActiveGrant itself already re-checks expiry
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "doctor", DOCTOR_ID);
    expect(res.status).toBe(403);
  });

  it("allows a doctor through and attaches the resolved grant to the request when active", async () => {
    sessionFindOneMock.mockResolvedValue({ _id: SESSION_ID });
    resolveActiveGrantMock.mockResolvedValue({ status: "active", selectedDocumentIds: [] });
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "doctor", DOCTOR_ID);
    expect(res.status).toBe(200);
    expect(res.body.grant).toBe("present");
    expect(resolveActiveGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, doctorId: DOCTOR_ID, patientId: PATIENT_ID })
    );
  });

  it("rejects an invalid patient id before ever querying Session (fail closed on malformed input)", async () => {
    const app = buildApp();
    const res = await withRole(request(app).get("/patient/not-an-object-id"), "doctor", DOCTOR_ID);
    expect(res.status).toBe(403);
    expect(sessionFindOneMock).not.toHaveBeenCalled();
  });

  it("resolves the :id/records style route via the document's own userId, then applies the same grant check", async () => {
    documentFindByIdMock.mockResolvedValue({ userId: PATIENT_ID });
    sessionFindOneMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await withRole(request(app).get(`/doc/507f1f77bcf86cd799439055`), "doctor", DOCTOR_ID);
    expect(res.status).toBe(403);
    expect(documentFindByIdMock).toHaveBeenCalled();
  });
});

describe("checkSession — unknown/unsupported role", () => {
  it("rejects any role other than patient/doctor/admin/superadmin", async () => {
    const app = buildApp();
    const res = await withRole(request(app).get(`/patient/${PATIENT_ID}`), "system", "x");
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const app = buildApp();
    const res = await request(app).get(`/patient/${PATIENT_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("checkSessionByEmail", () => {
  it("resolves the patient by email then delegates to the same grant-based doctor check", async () => {
    userFindOneMock.mockResolvedValue({ _id: PATIENT_ID });
    sessionFindOneMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await withRole(
      request(app).get("/by-email/patient@example.test"),
      "doctor",
      DOCTOR_ID
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NO_ACTIVE_SESSION");
  });

  it("returns 404 when no user matches the email", async () => {
    userFindOneMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await withRole(
      request(app).get("/by-email/nobody@example.test"),
      "doctor",
      DOCTOR_ID
    );
    expect(res.status).toBe(404);
  });
});
