import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";

// Covers the new patient-controlled session data sharing endpoints added to
// routes/sessionRoutes.js: sharing preferences, approval preview, the
// shared-data summary, and revocation (single document, and whole session).
// Grant materialization on accept is exercised separately in
// respondToSessionRequest tests below within this same suite.

const PATIENT_ID = "507f1f77bcf86cd799439011";
const DOCTOR_ID = "507f1f77bcf86cd799439012";
const SESSION_ID = "507f1f77bcf86cd799439013";
const DOC_1 = "507f1f77bcf86cd799439021";
const DOC_2 = "507f1f77bcf86cd799439022";

const state = {
  session: null,
  grant: null,
  preference: null,
};

const sessionFindByIdMock = jest.fn(async () => state.session);
const sessionUpdateOneMock = jest.fn(async () => ({ modifiedCount: 1 }));

const allDocuments = [
  { _id: DOC_1, category: "Report", title: "Report 1", createdAt: new Date() },
  { _id: DOC_2, category: "Bill", title: "Bill 1", createdAt: new Date() },
];
const documentFindMock = jest.fn((filter) => {
  if (filter?._id?.$in) {
    const allowed = new Set(filter._id.$in.map(String));
    return allDocuments.filter((doc) => allowed.has(String(doc._id)));
  }
  return allDocuments;
});

const grantFindOneMock = jest.fn(async () => state.grant);
const grantFindOneAndUpdateMock = jest.fn(async (filter, update) => {
  const current = state.grant || { version: 0, selectedDocumentIds: [] };
  const next = {
    ...current,
    ...update.$set,
    version: (current.version || 0) + (update.$inc?.version || 0),
    save: jest.fn(async function () { state.grant = this; return this; }),
  };
  state.grant = next;
  return next;
});

const preferenceFindOneMock = jest.fn(async () => state.preference);
const preferenceFindOneAndUpdateMock = jest.fn(async (filter, update) => {
  const current = state.preference || {
    categoryDefaults: { Report: "ask", Prescription: "ask", Bill: "deny", Insurance: "deny" },
    structuredDataDefaults: {
      profile: true, allergies: true, conditions: true, medications: true, appointments: false, emergencyInformation: true,
    },
    capabilities: { allowDoctorDownload: false, allowDoctorUploadToPatient: true },
    version: 1,
  };
  const next = { ...current, ...update.$set, version: current.version + (update.$inc?.version || 0) };
  state.preference = next;
  return next;
});

const emitSessionPermissionsUpdatedMock = jest.fn();

const authMock = jest.fn((req, _res, next) => {
  req.auth = req.__testAuth || { role: "patient", id: PATIENT_ID };
  req.user = { _id: req.auth.id };
  next();
});

await jest.unstable_mockModule("../middleware/auth.js", () => ({ auth: authMock }));
await jest.unstable_mockModule("../models/Session.js", () => ({
  Session: {
    findById: (...args) => ({
      select: () => ({ lean: async () => sessionFindByIdMock(...args) }),
      populate: () => ({ lean: async () => sessionFindByIdMock(...args) }),
      lean: async () => sessionFindByIdMock(...args),
    }),
    findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }),
    updateOne: sessionUpdateOneMock,
  },
}));
await jest.unstable_mockModule("../models/Appointment.js", () => ({
  Appointment: { findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }) },
}));
await jest.unstable_mockModule("../models/User.js", () => ({
  User: {
    findById: () => ({ select: () => ({ lean: async () => null }) }),
    findByIdAndUpdate: jest.fn(async () => ({})),
  },
}));
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({
  DoctorUser: { findById: () => ({ select: () => ({ lean: async () => ({ name: "Dr. Test" }) }) }) },
}));
await jest.unstable_mockModule("../models/DirectMessage.js", () => ({
  DirectMessage: { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }), create: jest.fn(), findOne: jest.fn(), updateMany: jest.fn(), aggregate: jest.fn(async () => []) },
}));
await jest.unstable_mockModule("../models/ChatThreadHiddenState.js", () => ({
  ChatThreadHiddenState: { findOne: () => ({ select: () => ({ lean: async () => null }) }), find: () => ({ select: () => ({ lean: async () => [] }) }), findOneAndUpdate: jest.fn(), deleteMany: jest.fn() },
}));
await jest.unstable_mockModule("../models/Notification.js", () => ({ Notification: { create: jest.fn(async (p) => ({ _id: "notif-1", ...p })) } }));
await jest.unstable_mockModule("../controllers/notificationController.js", () => ({ broadcastNotification: jest.fn(async () => {}) }));
await jest.unstable_mockModule("../utils/notifications.js", () => ({
  sendNotification: jest.fn(async () => true),
  sendNotificationToDoctor: jest.fn(async () => true),
}));
await jest.unstable_mockModule("../services/chatPresenceRealtime.js", () => ({
  emitNewDirectMessage: jest.fn(),
  emitTypingEvent: jest.fn(),
  emitMessageDeleted: jest.fn(),
  emitSessionPermissionsUpdated: emitSessionPermissionsUpdatedMock,
}));
await jest.unstable_mockModule("../services/sessionHistoryPersistence.js", () => ({ persistSessionHistory: jest.fn(async () => ({})) }));
await jest.unstable_mockModule("../config/s3.js", () => ({ BUCKET_NAME: "test-bucket" }));
await jest.unstable_mockModule("../utils/s3Utils.js", () => ({ generateSignedUrl: jest.fn(async () => "https://example.com/signed") }));
await jest.unstable_mockModule("../models/RefreshToken.js", () => ({ RefreshToken: {} }));
await jest.unstable_mockModule("../models/File.js", () => ({
  Document: {
    find: (...args) => ({
      select: () => ({
        sort: () => ({ lean: async () => documentFindMock(...args) }),
        lean: async () => documentFindMock(...args),
      }),
      lean: async () => documentFindMock(...args),
    }),
  },
}));
await jest.unstable_mockModule("../models/SessionAccessGrant.js", () => ({
  SessionAccessGrant: { findOne: grantFindOneMock, findOneAndUpdate: grantFindOneAndUpdateMock },
}));
await jest.unstable_mockModule("../models/PatientSessionSharingPreference.js", () => ({
  PatientSessionSharingPreference: {
    findOne: (...args) => ({ lean: async () => preferenceFindOneMock(...args) }),
    findOneAndUpdate: (...args) => ({ lean: async () => preferenceFindOneAndUpdateMock(...args) }),
  },
}));

const { default: sessionRouter } = await import("./sessionRoutes.js");

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionRouter);

const withAuth = (auth) => {
  authMock.mockImplementation((req, _res, next) => {
    req.auth = auth;
    req.user = { _id: auth.id };
    next();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  state.session = { _id: SESSION_ID, doctorId: DOCTOR_ID, patientId: PATIENT_ID, status: "accepted", expiresAt: new Date(Date.now() + 20 * 60000) };
  state.grant = null;
  state.preference = null;
  withAuth({ role: "patient", id: PATIENT_ID });
});

describe("GET/PATCH /api/sessions/sharing-preferences", () => {
  it("returns product defaults for a patient who has never saved any", async () => {
    const res = await request(app).get("/api/sessions/sharing-preferences");
    expect(res.status).toBe(200);
    expect(res.body.data.preferences.categoryDefaults.Bill).toBe("deny");
  });

  it("rejects a non-patient role", async () => {
    withAuth({ role: "doctor", id: DOCTOR_ID });
    const res = await request(app).get("/api/sessions/sharing-preferences");
    expect(res.status).toBe(403);
  });

  it("updates preferences with a partial patch", async () => {
    const res = await request(app)
      .patch("/api/sessions/sharing-preferences")
      .send({ categoryDefaults: { Report: "share" } });
    expect(res.status).toBe(200);
    expect(res.body.data.preferences.categoryDefaults.Report).toBe("share");
  });
});

describe("GET /api/sessions/:id/approval-preview", () => {
  it("rejects when the session doesn't belong to the requesting patient", async () => {
    state.session = { ...state.session, patientId: "507f1f77bcf86cd799439099" };
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/approval-preview`);
    expect(res.status).toBe(403);
  });

  it("returns category counts and structured-data defaults", async () => {
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/approval-preview`);
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toHaveLength(4);
    expect(res.body.data.sessionDurationMinutes).toBe(20);
  });
});

describe("GET /api/sessions/:sessionId/shared-data (doctor)", () => {
  it("rejects a patient calling this doctor-only endpoint", async () => {
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/shared-data`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with a specific code when the grant is expired/revoked", async () => {
    withAuth({ role: "doctor", id: DOCTOR_ID });
    state.grant = null;
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/shared-data`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SESSION_ACCESS_REVOKED_OR_EXPIRED");
  });

  it("returns exactly the granted documents/scopes/capabilities when active", async () => {
    withAuth({ role: "doctor", id: DOCTOR_ID });
    state.grant = {
      status: "active",
      expiresAt: new Date(Date.now() + 60000),
      selectedDocumentIds: [DOC_1],
      selectedCategories: ["Report"],
      structuredDataScopes: ["allergies"],
      capabilities: { canViewDocuments: true, canDownloadDocuments: false, canUploadDocuments: false },
      version: 1,
      save: jest.fn(),
    };
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/shared-data`);
    expect(res.status).toBe(200);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.documents[0].id).toBe(DOC_1);
    expect(res.body.data.structuredDataScopes).toEqual(["allergies"]);
  });

  it("rejects a doctor who is not the one attached to this session", async () => {
    withAuth({ role: "doctor", id: "507f1f77bcf86cd799439098" });
    const res = await request(app).get(`/api/sessions/${SESSION_ID}/shared-data`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/sessions/:sessionId/access-grant", () => {
  beforeEach(() => {
    state.grant = {
      status: "active",
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      sessionId: SESSION_ID,
      selectedDocumentIds: [DOC_1],
      structuredDataScopes: ["allergies"],
      capabilities: { canViewDocuments: true, canDownloadDocuments: false, canUploadDocuments: false },
      version: 1,
      save: jest.fn(async function () { return this; }),
    };
  });

  it("adds and removes document ids", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${SESSION_ID}/access-grant`)
      .send({ addDocumentIds: [DOC_2], removeDocumentIds: [DOC_1] });
    expect(res.status).toBe(200);
    expect(res.body.data.selectedDocumentIds).toEqual([DOC_2]);
    expect(res.body.data.version).toBe(2);
  });

  it("rejects a stale expectedVersion (optimistic concurrency)", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${SESSION_ID}/access-grant`)
      .send({ expectedVersion: 0, addDocumentIds: [DOC_2] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GRANT_VERSION_STALE");
  });

  it("accepts a matching expectedVersion", async () => {
    const res = await request(app)
      .patch(`/api/sessions/${SESSION_ID}/access-grant`)
      .send({ expectedVersion: 1, structuredDataScopes: ["medications"] });
    expect(res.status).toBe(200);
    expect(res.body.data.structuredDataScopes).toEqual(["medications"]);
  });

  it("rejects a patient patching another patient's grant", async () => {
    withAuth({ role: "patient", id: "507f1f77bcf86cd799439099" });
    const res = await request(app)
      .patch(`/api/sessions/${SESSION_ID}/access-grant`)
      .send({ addDocumentIds: [DOC_2] });
    expect(res.status).toBe(404);
  });

  it("emits session:permissions_updated to the doctor", async () => {
    await request(app).patch(`/api/sessions/${SESSION_ID}/access-grant`).send({ addDocumentIds: [DOC_2] });
    expect(emitSessionPermissionsUpdatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: DOCTOR_ID, changedScope: "partial_update" })
    );
  });
});

describe("DELETE /api/sessions/:sessionId/access-grant/documents/:documentId", () => {
  it("removes exactly the named document and bumps version", async () => {
    state.grant = {
      status: "active",
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      sessionId: SESSION_ID,
      selectedDocumentIds: [DOC_1, DOC_2],
      version: 1,
      save: jest.fn(async function () { return this; }),
    };
    const res = await request(app).delete(`/api/sessions/${SESSION_ID}/access-grant/documents/${DOC_1}`);
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);
    expect(state.grant.selectedDocumentIds.map(String)).toEqual([DOC_2]);
  });

  it("is idempotent: removing a document already absent from the grant still succeeds", async () => {
    state.grant = {
      status: "active",
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      sessionId: SESSION_ID,
      selectedDocumentIds: [DOC_2],
      version: 1,
      save: jest.fn(async function () { return this; }),
    };
    const res = await request(app).delete(`/api/sessions/${SESSION_ID}/access-grant/documents/${DOC_1}`);
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(false);
  });
});

describe("POST /api/sessions/:sessionId/revoke", () => {
  it("revokes an active grant and ends the underlying session", async () => {
    state.grant = {
      status: "active",
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      sessionId: SESSION_ID,
      version: 1,
    };
    const res = await request(app).post(`/api/sessions/${SESSION_ID}/revoke`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("revoked");
    expect(sessionUpdateOneMock).toHaveBeenCalledWith(
      expect.objectContaining({ _id: SESSION_ID, status: "accepted" }),
      expect.objectContaining({ $set: expect.objectContaining({ status: "ended" }) })
    );
    expect(emitSessionPermissionsUpdatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ changedScope: "full_session", status: "revoked" })
    );
  });

  it("is idempotent when called on an already-revoked grant", async () => {
    state.grant = {
      status: "revoked",
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      sessionId: SESSION_ID,
      version: 2,
    };
    const res = await request(app).post(`/api/sessions/${SESSION_ID}/revoke`);
    expect(res.status).toBe(200);
  });

  it("rejects revoking a grant that doesn't belong to the requesting patient", async () => {
    state.grant = { status: "active", patientId: "507f1f77bcf86cd799439099", doctorId: DOCTOR_ID, sessionId: SESSION_ID, version: 1 };
    const res = await request(app).post(`/api/sessions/${SESSION_ID}/revoke`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/respond — grant materialization on accept", () => {
  // The Session document here needs the full mongoose-document shape the
  // route expects (populate/save/toString on _id), unlike the lean() shape
  // used by the other describe blocks above.
  const buildPendingSession = () => ({
    _id: SESSION_ID,
    doctorId: { _id: DOCTOR_ID, name: "Dr. Test" },
    patientId: PATIENT_ID,
    status: "pending",
    expiresAt: new Date(Date.now() + 20 * 60000),
    respondedAt: null,
    populate: jest.fn(async function () { return this; }),
    save: jest.fn(async function () { return this; }),
  });

  it("materializes a grant reflecting the patient's explicit selection and returns it in data.relationship", async () => {
    const pendingSession = buildPendingSession();
    sessionFindByIdMock.mockResolvedValueOnce(pendingSession);
    // Override the chainable mock for this specific call shape (.populate() then used directly).
    const { Session } = await import("../models/Session.js");
    Session.findById = jest.fn(() => ({ populate: async () => pendingSession }));

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/respond`)
      .send({
        status: "accepted",
        selection: {
          selectedDocumentIds: [DOC_1],
          selectedCategories: ["Report"],
          structuredDataScopes: ["allergies"],
          capabilities: { allowDoctorDownload: true, allowDoctorUploadToPatient: false },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.relationship).not.toBeNull();
    expect(res.body.data.relationship.selectedDocumentIds).toEqual([DOC_1]);
    expect(res.body.data.relationship.capabilities.canDownloadDocuments).toBe(true);
    expect(res.body.data.relationship.status).toBe("active");
  });
});
