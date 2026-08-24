import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";

// Covers the S3-upload-path rewrite in routes/document.js: a patient
// upload must validate the medical/OCR content directly from the buffer
// multer already has in memory (never re-downloading the object from S3),
// while the S3 PUT itself runs concurrently rather than being awaited
// first. A file that fails the cheap magic-byte check must never reach S3
// at all - no wasted PUT+DELETE for obviously-corrupt uploads.

const PATIENT_ID = "507f1f77bcf86cd799439011";

// A minimal, valid PDF (matches the %PDF-1.4 magic bytes) with a body long
// enough that the mocked extractTextFromBuffer below stands in for OCR.
const validPdfBuffer = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF",
  "utf8",
);
// Same bytes but with the PDF magic-byte header corrupted.
const corruptPdfBuffer = Buffer.from(
  "NOT-A-PDF" + "%".repeat(50),
  "utf8",
);

const s3SendMock = jest.fn(async (command) => {
  if (command?.constructor?.name === "PutObjectCommand") {
    return { ETag: '"mock-etag"' };
  }
  return {};
});

let extractedTextForBuffer = "Medical Report Diagnosis: Fever Prescription: Paracetamol Hospital: City Clinic Patient Name: John";

const extractTextFromBufferMock = jest.fn(async () => ({
  success: true,
  text: extractedTextForBuffer,
  metadata: {},
}));

const documentCreateMock = jest.fn(async (payload) => ({
  _id: "507f1f77bcf86cd799439099",
  ...payload,
}));
const userFindByIdAndUpdateMock = jest.fn(async () => ({}));

await jest.unstable_mockModule("../middleware/checkSession.js", () => ({
  checkSession: (req, _res, next) => next(),
  checkSessionByEmail: (req, _res, next) => next(),
}));
await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: (req, _res, next) => {
    req.auth = { id: PATIENT_ID, role: "patient" };
    next();
  },
}));
await jest.unstable_mockModule("../middleware/requireVerified.js", () => ({
  requireVerified: (req, _res, next) => next(),
}));
await jest.unstable_mockModule("../models/File.js", () => ({
  Document: { create: documentCreateMock, find: jest.fn(), findById: jest.fn() },
}));
await jest.unstable_mockModule("../models/User.js", () => ({
  User: {
    findById: jest.fn(() => ({
      select: () => ({
        lean: async () => ({
          _id: PATIENT_ID,
          uploadPreferences: { aiMedicalCheckDisabled: false },
        }),
      }),
    })),
    findByIdAndUpdate: userFindByIdAndUpdateMock,
  },
}));
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({ DoctorUser: {} }));
await jest.unstable_mockModule("../models/Session.js", () => ({ Session: { findOne: () => ({ select: () => ({ lean: async () => null }) }) } }));
await jest.unstable_mockModule("../models/CareRelationship.js", () => ({ CareRelationship: { findOne: () => ({ lean: async () => null }) } }));
await jest.unstable_mockModule("../models/PatientProfile.js", () => ({ PatientProfile: { findOne: () => ({ lean: async () => null }) } }));
await jest.unstable_mockModule("../config/s3.js", () => ({
  default: { send: s3SendMock },
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
  canDoctorAccessPatient: jest.fn(async () => true),
}));
await jest.unstable_mockModule("../services/sessionAccessGrantService.js", () => ({
  grantAllowsDocument: jest.fn(() => false),
  filterDocumentsForRequester: jest.fn((req, docs) => docs),
}));
await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({ writeAuditLog: jest.fn(async () => {}) }));
await jest.unstable_mockModule("../middleware/rateLimit.js", () => ({ uploadLimiter: (req, _res, next) => next() }));
await jest.unstable_mockModule("../services/documentReader.js", () => ({
  default: class {
    extractTextFromBuffer(...args) {
      return extractTextFromBufferMock(...args);
    }
    extractTextFromS3() { return Promise.resolve({ success: false, text: "", metadata: {} }); }
    extractFromPDF() { return Promise.resolve({ text: "", metadata: {} }); }
    extractFromImage() { return Promise.resolve({ text: "", metadata: {} }); }
  },
}));
await jest.unstable_mockModule("../services/uploadStoragePolicy.js", () => ({
  resolveUploadStorage: jest.fn(async () => "s3"),
}));
await jest.unstable_mockModule("../services/aiGovernance.js", () => ({
  assertAIUsageAllowed: jest.fn(async () => {}),
  estimateTokensFromText: jest.fn(() => 0),
  getAISettings: jest.fn(async () => ({ documentVerificationAiEnabled: true, defaultModel: "gpt-4o-mini", maxOutputTokensPerRequest: 700 })),
  recordAIUsage: jest.fn(async () => {}),
}));
await jest.unstable_mockModule("../services/familyCareProfileService.js", () => ({
  findSelfPatientProfileId: jest.fn(async () => null),
  ensureSelfPatientProfile: jest.fn(async () => null),
}));

const { default: documentRouter } = await import("./document.js");

const app = express();
app.use("/api/files", documentRouter);

beforeEach(() => {
  s3SendMock.mockClear();
  extractTextFromBufferMock.mockClear();
  documentCreateMock.mockClear();
  extractedTextForBuffer = "Medical Report Diagnosis: Fever Prescription: Paracetamol Hospital: City Clinic Patient Name: John";
});

describe("POST /files/upload — S3 path validates from the buffer, not a re-download", () => {
  it("accepts a valid medical PDF: uploads to S3 and validates concurrently from the in-memory buffer (no extractTextFromS3 call)", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .attach("file", validPdfBuffer, { filename: "report.pdf", contentType: "application/pdf" })
      .field("title", "Surgery report");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.verificationStatus).toBe("verified");

    // The medical check must read the buffer directly...
    expect(extractTextFromBufferMock).toHaveBeenCalledTimes(1);
    const [bufferArg, extArg] = extractTextFromBufferMock.mock.calls[0];
    expect(Buffer.isBuffer(bufferArg)).toBe(true);
    expect(extArg).toBe("pdf");

    // ...and the object must actually have been written to S3 exactly once.
    const putCalls = s3SendMock.mock.calls.filter(
      ([command]) => command?.constructor?.name === "PutObjectCommand",
    );
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0][0].input.Bucket).toBe("test-bucket");
    expect(Buffer.isBuffer(putCalls[0][0].input.Body)).toBe(true);

    // No DeleteObjectCommand should run for a successful upload.
    const deleteCalls = s3SendMock.mock.calls.filter(
      ([command]) => command?.constructor?.name === "DeleteObjectCommand",
    );
    expect(deleteCalls).toHaveLength(0);

    expect(documentCreateMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a document with no medical signal, and cleans up the S3 object it had already started uploading", async () => {
    extractedTextForBuffer = "Random unrelated text with no medical terms at all, just filler words repeated to pass length checks nicely.";

    const res = await request(app)
      .post("/api/files/upload")
      .attach("file", validPdfBuffer, { filename: "notmedical.pdf", contentType: "application/pdf" })
      .field("title", "Random doc");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DOCUMENT_NOT_MEDICAL");

    // It still uploaded (ran concurrently with the check) then cleaned up.
    const putCalls = s3SendMock.mock.calls.filter(
      ([command]) => command?.constructor?.name === "PutObjectCommand",
    );
    const deleteCalls = s3SendMock.mock.calls.filter(
      ([command]) => command?.constructor?.name === "DeleteObjectCommand",
    );
    expect(putCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);
    expect(documentCreateMock).not.toHaveBeenCalled();
  });

  it("rejects a file whose bytes don't match its declared type before ever touching S3", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .attach("file", corruptPdfBuffer, { filename: "fake.pdf", contentType: "application/pdf" })
      .field("title", "Fake");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FILE_SECURITY_CHECK_FAILED");

    // Magic-byte check fails from the buffer alone, before any PUT or GET -
    // only the defensive (harmless, no-op-if-nothing-exists) cleanup DELETE
    // runs.
    const nonDeleteCalls = s3SendMock.mock.calls.filter(
      ([command]) => command?.constructor?.name !== "DeleteObjectCommand",
    );
    expect(nonDeleteCalls).toHaveLength(0);
    expect(extractTextFromBufferMock).not.toHaveBeenCalled();
    expect(documentCreateMock).not.toHaveBeenCalled();
  });

  it("lets a patient with aiMedicalCheckDisabled skip the content check but still uploads via the same parallel S3 path", async () => {
    const { User } = await import("../models/User.js");
    User.findById.mockImplementationOnce(() => ({
      select: () => ({
        lean: async () => ({
          _id: PATIENT_ID,
          uploadPreferences: { aiMedicalCheckDisabled: true },
        }),
      }),
    }));

    const res = await request(app)
      .post("/api/files/upload")
      .attach("file", validPdfBuffer, { filename: "anything.pdf", contentType: "application/pdf" })
      .field("title", "Whatever");

    expect(res.status).toBe(200);
    expect(res.body.medicalVerification.method).toBe("user_disabled");
    // The bypass never needs to read the document's content.
    expect(extractTextFromBufferMock).not.toHaveBeenCalled();

    const putCalls = s3SendMock.mock.calls.filter(
      ([command]) => command?.constructor?.name === "PutObjectCommand",
    );
    expect(putCalls).toHaveLength(1);
  });

  it("actually overlaps the S3 upload and the medical check in wall-clock time, instead of running them one after another", async () => {
    const DELAY_MS = 150;
    s3SendMock.mockImplementationOnce(
      (command) =>
        new Promise((resolve) => {
          setTimeout(() => resolve({}), command?.constructor?.name === "PutObjectCommand" ? DELAY_MS : 0);
        }),
    );
    extractTextFromBufferMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ success: true, text: extractedTextForBuffer, metadata: {} }),
            DELAY_MS,
          );
        }),
    );

    const start = Date.now();
    const res = await request(app)
      .post("/api/files/upload")
      .attach("file", validPdfBuffer, { filename: "timing.pdf", contentType: "application/pdf" })
      .field("title", "Timing check");
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(200);
    // If the upload and the check ran sequentially this would take
    // ~2*DELAY_MS; running concurrently it should be close to one DELAY_MS
    // plus overhead. Assert well under the sequential sum to catch a
    // regression back to "await upload, then await check".
    expect(elapsedMs).toBeLessThan(DELAY_MS * 1.8);
  });
});
