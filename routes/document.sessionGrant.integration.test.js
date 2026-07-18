import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";

// Covers the session-grant-based document authorization rewrite in
// routes/document.js: list endpoints must filter by the requester's active
// SessionAccessGrant (never return the full patient document set to an
// unauthorized/partially-authorized doctor), view vs. download must be
// checked as distinct capabilities, and edit/delete must reject doctors
// outright since no grant capability ever authorizes mutation.

const PATIENT_ID = "507f1f77bcf86cd799439011";
const DOCTOR_ID = "507f1f77bcf86cd799439012";
const DOC_VIEWABLE = "507f1f77bcf86cd799439021";
const DOC_NOT_GRANTED = "507f1f77bcf86cd799439022";

const documents = [
  { _id: DOC_VIEWABLE, userId: PATIENT_ID, category: "Report", title: "Granted report", s3Key: "k1", s3Bucket: "b", toObject() { return this; } },
  { _id: DOC_NOT_GRANTED, userId: PATIENT_ID, category: "Bill", title: "Ungranted bill", s3Key: "k2", s3Bucket: "b", toObject() { return this; } },
];

const documentFindMock = jest.fn(() => {
  const thenable = Promise.resolve(documents);
  return Object.assign(thenable, { sort: () => thenable });
});
const documentFindByIdMock = jest.fn(async (id) => documents.find((d) => String(d._id) === String(id)) || null);

// checkSession is mocked directly so this suite controls req.sessionAccessGrant
// precisely per test, isolating the document-route logic from the
// already-covered middleware behavior (see middleware/checkSession.test.js).
let injectedGrant = null;
let injectedRole = "doctor";

await jest.unstable_mockModule("../middleware/checkSession.js", () => ({
  checkSession: (req, _res, next) => {
    req.auth = { id: injectedRole === "doctor" ? DOCTOR_ID : PATIENT_ID, role: injectedRole };
    req.patientId = PATIENT_ID;
    if (injectedGrant) req.sessionAccessGrant = injectedGrant;
    next();
  },
  checkSessionByEmail: (req, res, next) => next(),
}));
await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: (req, _res, next) => {
    req.auth = { id: injectedRole === "doctor" ? DOCTOR_ID : PATIENT_ID, role: injectedRole };
    next();
  },
}));
await jest.unstable_mockModule("../middleware/requireVerified.js", () => ({
  requireVerified: (req, _res, next) => next(),
}));
await jest.unstable_mockModule("../models/File.js", () => ({
  Document: { find: documentFindMock, findById: documentFindByIdMock },
}));
await jest.unstable_mockModule("../models/User.js", () => ({ User: {} }));
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({ DoctorUser: {} }));
await jest.unstable_mockModule("../models/Session.js", () => ({ Session: {} }));
await jest.unstable_mockModule("../models/CareRelationship.js", () => ({ CareRelationship: { findOne: () => ({ lean: async () => null }) } }));
await jest.unstable_mockModule("../models/PatientProfile.js", () => ({ PatientProfile: { findOne: () => ({ lean: async () => null }) } }));
await jest.unstable_mockModule("../config/s3.js", () => ({
  default: {},
  BUCKET_NAME: "test-bucket",
  REGION: "ap-south-1",
}));
await jest.unstable_mockModule("../utils/s3Utils.js", () => ({
  generateSignedUrl: jest.fn(async () => "https://example.com/signed"),
  generatePreviewUrl: jest.fn(async () => "https://example.com/preview"),
  generateDownloadUrl: jest.fn(async () => "https://example.com/download"),
}));
await jest.unstable_mockModule("../utils/notifications.js", () => ({ sendNotification: jest.fn(async () => true) }));
await jest.unstable_mockModule("../services/accessControl.js", () => ({
  canDoctorAccessPatient: jest.fn(async () => true), // must NOT be what actually gates access anymore
}));
await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({ writeAuditLog: jest.fn(async () => {}) }));
await jest.unstable_mockModule("../middleware/rateLimit.js", () => ({ uploadLimiter: (req, _res, next) => next() }));
await jest.unstable_mockModule("../services/documentReader.js", () => ({
  default: class {
    extractTextFromS3() { return Promise.resolve(""); }
    extractFromPDF() { return Promise.resolve(""); }
    extractFromImage() { return Promise.resolve(""); }
  },
}));
await jest.unstable_mockModule("../services/uploadStoragePolicy.js", () => ({
  resolveUploadStorage: jest.fn(async () => "s3"),
}));
await jest.unstable_mockModule("../services/aiGovernance.js", () => ({
  assertAIUsageAllowed: jest.fn(async () => {}),
  estimateTokensFromText: jest.fn(() => 0),
  getAISettings: jest.fn(async () => ({})),
  recordAIUsage: jest.fn(async () => {}),
}));

const { default: documentRouter } = await import("./document.js");

const app = express();
app.use(express.json());
app.use("/api/files", documentRouter);

beforeEach(() => {
  documentFindMock.mockClear();
  documentFindByIdMock.mockClear();
  injectedGrant = null;
  injectedRole = "doctor";
});

describe("GET /files/user/:userId — doctor list filtering", () => {
  it("returns nothing when the doctor has no active grant on the request", async () => {
    injectedGrant = null;
    const res = await request(app).get(`/api/files/user/${PATIENT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it("returns only the grant-selected document, never the patient's full document set", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true, canDownloadDocuments: false },
      selectedDocumentIds: [DOC_VIEWABLE],
    };
    const res = await request(app).get(`/api/files/user/${PATIENT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.documents[0]._id).toBe(DOC_VIEWABLE);
  });

  it("returns everything unfiltered for a patient viewing their own documents", async () => {
    injectedRole = "patient";
    injectedGrant = null;
    const res = await request(app).get(`/api/files/user/${PATIENT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

describe("GET /files/patient/:patientId — alias route, same filtering", () => {
  it("applies the identical grant filter as /user/:userId", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true },
      selectedDocumentIds: [DOC_VIEWABLE],
    };
    const res = await request(app).get(`/api/files/patient/${PATIENT_ID}`);
    expect(res.body.count).toBe(1);
    expect(res.body.documents[0]._id).toBe(DOC_VIEWABLE);
  });
});

describe("GET /files/user/:userId/grouped — grouped view respects the grant too", () => {
  it("only includes the granted document in its category group", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true },
      selectedDocumentIds: [DOC_VIEWABLE],
    };
    const res = await request(app).get(`/api/files/user/${PATIENT_ID}/grouped`);
    expect(res.status).toBe(200);
    expect(res.body.counts.reports).toBe(1);
    expect(res.body.counts.bills).toBe(0);
  });
});

describe("GET /files/:id/preview-url — view capability", () => {
  it("allows a doctor whose grant includes the document and permits viewing", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true, canDownloadDocuments: false },
      selectedDocumentIds: [DOC_VIEWABLE],
    };
    const res = await request(app).get(`/api/files/${DOC_VIEWABLE}/preview-url`);
    expect(res.status).toBe(200);
  });

  it("rejects a doctor for a document not present in the grant, even if it belongs to the same patient", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true },
      selectedDocumentIds: [DOC_VIEWABLE], // DOC_NOT_GRANTED intentionally excluded
    };
    const res = await request(app).get(`/api/files/${DOC_NOT_GRANTED}/preview-url`);
    expect(res.status).toBe(403);
  });
});

describe("GET /files/:id/download — download is a distinct capability from view", () => {
  it("rejects a doctor whose grant allows viewing but not downloading", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true, canDownloadDocuments: false },
      selectedDocumentIds: [DOC_VIEWABLE],
    };
    const res = await request(app).get(`/api/files/${DOC_VIEWABLE}/download`);
    expect(res.status).toBe(403);
  });

  it("allows a doctor whose grant explicitly permits downloading", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true, canDownloadDocuments: true },
      selectedDocumentIds: [DOC_VIEWABLE],
    };
    // The route's default (non-JSON-accept) behavior is a redirect to the
    // signed URL — a 302 here means authorization passed and it proceeded
    // to generate a real download link, which is what this test verifies.
    const res = await request(app)
      .get(`/api/files/${DOC_VIEWABLE}/download`)
      .set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("PUT /files/:id and DELETE /files/:id — no grant capability ever authorizes mutation", () => {
  it("rejects a doctor on PUT even with full view+download+upload capabilities granted", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true, canDownloadDocuments: true, canUploadDocuments: true },
      selectedDocumentIds: [DOC_VIEWABLE],
    };
    const res = await request(app).put(`/api/files/${DOC_VIEWABLE}`).send({ title: "Renamed" });
    expect(res.status).toBe(403);
  });

  it("rejects a doctor on DELETE the same way", async () => {
    injectedGrant = {
      capabilities: { canViewDocuments: true, canDownloadDocuments: true, canUploadDocuments: true },
      selectedDocumentIds: [DOC_VIEWABLE],
    };
    const res = await request(app).delete(`/api/files/${DOC_VIEWABLE}`);
    expect(res.status).toBe(403);
  });
});
