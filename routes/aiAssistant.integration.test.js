import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockState = {
  openAiReply: "Mocked AI response.",
  doctorAccessDefault: true,
  doctorAccessByPair: new Map(),
  usersById: new Map(),
  doctorsById: new Map(),
  adminsById: new Map(),
  documentsById: new Map(),
  extractionResult: {
    success: true,
    text: "Hemoglobin 13.5 g/dL. WBC 7600 /uL.",
    metadata: {},
  },
  aiChatFindOneResult: null,
  aiChatFindByIdResult: null,
};

const makeQuery = (value) => ({
  sort: () => makeQuery(value),
  limit: (count) =>
    Promise.resolve(Array.isArray(value) ? value.slice(0, count) : value),
  lean: async () => value,
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  catch: (reject) => Promise.resolve(value).catch(reject),
});

const makeSelectChain = (value) => ({
  select: (projection) => {
    const normalized = String(projection || "").trim();
    if (normalized === "_id") {
      return {
        lean: async () =>
          value
            ? { _id: String(value._id || value.id || value) }
            : null,
      };
    }
    return Promise.resolve(value);
  },
});

const axiosPostMock = jest.fn(async () => ({
  data: {
    model: "gpt-4o-mini",
    choices: [{ message: { content: mockState.openAiReply } }],
  },
}));

const canDoctorAccessPatientMock = jest.fn(async (doctorId, patientId) => {
  const key = `${String(doctorId)}:${String(patientId)}`;
  if (mockState.doctorAccessByPair.has(key)) {
    return mockState.doctorAccessByPair.get(key);
  }
  return mockState.doctorAccessDefault;
});

const extractTextFromS3Mock = jest.fn(async () => mockState.extractionResult);

const userFindByIdMock = jest.fn((id) =>
  makeSelectChain(mockState.usersById.get(String(id)) || null)
);

const doctorFindByIdMock = jest.fn((id) =>
  makeSelectChain(mockState.doctorsById.get(String(id)) || null)
);

const adminFindByIdMock = jest.fn((id) =>
  makeSelectChain(mockState.adminsById.get(String(id)) || null)
);

const documentFindByIdMock = jest.fn(async (id) =>
  mockState.documentsById.get(String(id)) || null
);

const documentFindMock = jest.fn((filter = {}) => {
  let docs = Array.from(mockState.documentsById.values());
  if (filter.userId) {
    docs = docs.filter((doc) => String(doc.userId) === String(filter.userId));
  }
  if (filter.type) {
    docs = docs.filter((doc) => String(doc.type) === String(filter.type));
  }
  return makeQuery(docs);
});

const appointmentFindMock = jest.fn(() => makeQuery([]));

class MockAIChat {
  constructor(doc = {}) {
    this._id = doc._id || "chat-mock-1";
    this.userId = doc.userId;
    this.userRole = doc.userRole;
    this.patientId = doc.patientId ?? null;
    this.messages = Array.isArray(doc.messages) ? [...doc.messages] : [];
    this.expiresAt = doc.expiresAt || new Date(Date.now() + 3600_000);
    this.context = doc.context || {};
    this.lastActivityAt = doc.lastActivityAt || new Date();
  }

  async save() {
    return this;
  }

  static findById = jest.fn(async () => mockState.aiChatFindByIdResult);

  static findOne = jest.fn(() => makeQuery(mockState.aiChatFindOneResult));

  static deleteMany = jest.fn(async () => ({ deletedCount: 1 }));
}

const aiLimiterMock = jest.fn((req, res, next) => next());

const authMock = jest.fn((req, res, next) => {
  const role = String(req.headers["x-test-role"] || "patient").toLowerCase();
  const idHeader = req.headers["x-test-id"];
  const id =
    String(idHeader || "").trim() ||
    (role === "doctor"
      ? "doctor-1"
      : role === "admin"
        ? "admin-1"
        : role === "superadmin"
          ? "superadmin@example.com"
          : "patient-1");

  req.auth = { role, id, email: `${role}@example.com` };
  if (role === "patient") req.user = { _id: id, name: "Patient Mock" };
  if (role === "doctor") req.doctor = { _id: id, name: "Doctor Mock" };
  if (role === "admin") req.admin = { _id: id, name: "Admin Mock" };
  if (role === "superadmin") {
    req.superAdmin = { email: id, role: "SUPERADMIN" };
  }
  next();
});

await jest.unstable_mockModule("axios", () => ({
  default: { post: axiosPostMock },
}));

await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: authMock,
}));

await jest.unstable_mockModule("../middleware/rateLimit.js", () => ({
  aiLimiter: aiLimiterMock,
}));

await jest.unstable_mockModule("../services/accessControl.js", () => ({
  canDoctorAccessPatient: canDoctorAccessPatientMock,
}));

await jest.unstable_mockModule("../services/documentReader.js", () => ({
  default: class MockDocumentReader {
    async extractTextFromS3(...args) {
      return extractTextFromS3Mock(...args);
    }
  },
}));

await jest.unstable_mockModule("../models/User.js", () => ({
  User: {
    findById: userFindByIdMock,
  },
}));

await jest.unstable_mockModule("../models/DoctorUser.js", () => ({
  DoctorUser: {
    findById: doctorFindByIdMock,
  },
}));

await jest.unstable_mockModule("../models/AdminUser.js", () => ({
  AdminUser: {
    findById: adminFindByIdMock,
  },
}));

await jest.unstable_mockModule("../models/File.js", () => ({
  Document: {
    findById: documentFindByIdMock,
    find: documentFindMock,
  },
}));

await jest.unstable_mockModule("../models/Appointment.js", () => ({
  Appointment: {
    find: appointmentFindMock,
  },
}));

await jest.unstable_mockModule("../models/AIChat.js", () => ({
  AIChat: MockAIChat,
}));

const { default: aiAssistantRouter } = await import("./aiAssistant.js");

const app = express();
app.use(express.json());
app.use("/api/ai", aiAssistantRouter);

const resetState = () => {
  mockState.openAiReply = "Mocked AI response.";
  mockState.doctorAccessDefault = true;
  mockState.doctorAccessByPair = new Map();
  mockState.usersById = new Map([
    [
      "patient-1",
      {
        _id: "patient-1",
        name: "Patient One",
        preferredLanguage: "en",
      },
    ],
    ["patient-2", { _id: "patient-2", name: "Patient Two" }],
  ]);
  mockState.doctorsById = new Map([
    [
      "doctor-1",
      {
        _id: "doctor-1",
        name: "Doctor One",
        preferredLanguage: "en",
      },
    ],
  ]);
  mockState.adminsById = new Map([
    [
      "admin-1",
      {
        _id: "admin-1",
        name: "Admin One",
        preferredLanguage: "en",
      },
    ],
  ]);
  mockState.documentsById = new Map();
  mockState.extractionResult = {
    success: true,
    text: "Hemoglobin 13.5 g/dL. WBC 7600 /uL.",
    metadata: {},
  };
  mockState.aiChatFindOneResult = null;
  mockState.aiChatFindByIdResult = null;
};

describe("AI assistant /api/ai integration", () => {
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeAll(() => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  beforeEach(() => {
    resetState();
    axiosPostMock.mockClear();
    canDoctorAccessPatientMock.mockClear();
    extractTextFromS3Mock.mockClear();
    userFindByIdMock.mockClear();
    doctorFindByIdMock.mockClear();
    adminFindByIdMock.mockClear();
    documentFindByIdMock.mockClear();
    documentFindMock.mockClear();
    appointmentFindMock.mockClear();
    MockAIChat.findById.mockClear();
    MockAIChat.findOne.mockClear();
    MockAIChat.deleteMany.mockClear();
  });

  afterAll(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("ignores forged client userRole and uses authenticated patient persona", async () => {
    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "patient")
      .set("x-test-id", "patient-1")
      .send({
        prompt: "Explain my latest summary",
        userRole: "doctor",
        context: {
          preferredLanguage: "en",
          userInputLanguage: "en",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.context?.resolvedPersona).toBe("patient");
    expect(response.body.context?.userRole).toBe("patient");
    expect(response.body.context?.resolvedLanguage).toBe("english");
    expect(doctorFindByIdMock).not.toHaveBeenCalled();
  });

  it("returns 403 when doctor requests an unauthorized patient scope", async () => {
    mockState.doctorAccessDefault = false;

    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "doctor")
      .set("x-test-id", "doctor-1")
      .send({
        prompt: "Show patient lab report",
        patientId: "patient-2",
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("NO_ACTIVE_SESSION");
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("asks doctor to select patient for patient-specific intent without patient context", async () => {
    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "doctor")
      .set("x-test-id", "doctor-1")
      .send({
        prompt: "Analyze this lab report and diagnosis.",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("PATIENT_CONTEXT_REQUIRED");
    expect(String(response.body.message || "").toLowerCase()).toContain(
      "select a patient profile"
    );
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("keeps admin in restricted mode by default for patient-sensitive prompts", async () => {
    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "admin")
      .set("x-test-id", "admin-1")
      .send({
        prompt: "Summarize this patient report and diagnosis.",
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("PATIENT_CONTEXT_REQUIRED");
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("blocks non-operational admin prompts when no patient context exists", async () => {
    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "admin")
      .set("x-test-id", "admin-1")
      .send({
        prompt: "Tell me a general joke.",
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ADMIN_OPERATIONAL_ONLY");
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("allows admin operational prompts without patient context", async () => {
    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "admin")
      .set("x-test-id", "admin-1")
      .send({
        prompt: "Show compliance dashboard and security metrics.",
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.context?.resolvedPersona).toBe("admin");
    expect(response.body.context?.authorizedScope?.mode).toBe("operational_only");
  });

  it("analyzes explicit document when doctor scope and ownership are valid", async () => {
    const documentId = "64b1234567890abcdef12345";
    mockState.documentsById.set(documentId, {
      _id: documentId,
      userId: "patient-1",
      title: "CBC Report",
      originalName: "cbc-report.pdf",
      type: "Report",
      s3Key: "docs/cbc-report.pdf",
      s3Bucket: "unit-test-bucket",
      uploadedAt: new Date("2026-03-01T10:00:00.000Z"),
    });

    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "doctor")
      .set("x-test-id", "doctor-1")
      .send({
        prompt: "Analyze this document.",
        patientId: "patient-1",
        documentId,
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.documentMetadata?.documentType).toBe("Report");
    expect(response.body.context?.authorizedScope?.patientId).toBe("patient-1");
    expect(extractTextFromS3Mock).toHaveBeenCalledWith(
      "docs/cbc-report.pdf",
      "unit-test-bucket"
    );
  });

  it("blocks explicit document analysis when document is out of selected scope", async () => {
    const documentId = "64b1234567890abcdef12346";
    mockState.documentsById.set(documentId, {
      _id: documentId,
      userId: "patient-2",
      title: "Outside Scope Report",
      type: "Report",
      s3Key: "docs/outside.pdf",
      s3Bucket: "unit-test-bucket",
      uploadedAt: new Date("2026-03-01T10:00:00.000Z"),
    });

    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "doctor")
      .set("x-test-id", "doctor-1")
      .send({
        prompt: "Analyze this document.",
        patientId: "patient-1",
        documentId,
      });

    expect(response.status).toBe(403);
    expect(String(response.body.message || "").toLowerCase()).toContain(
      "access denied"
    );
    expect(extractTextFromS3Mock).not.toHaveBeenCalled();
  });

  it("returns confidence warnings when extraction quality is low", async () => {
    const documentId = "64b1234567890abcdef12347";
    mockState.documentsById.set(documentId, {
      _id: documentId,
      userId: "patient-1",
      title: "Scanned Prescription",
      originalName: "rx.jpg",
      type: "Prescription",
      s3Key: "docs/rx.jpg",
      s3Bucket: "unit-test-bucket",
      uploadedAt: new Date("2026-03-05T10:00:00.000Z"),
    });
    mockState.extractionResult = {
      success: true,
      text: "short text",
      metadata: { fallbackUsed: true, ocrEngine: "tesseract" },
    };

    const response = await request(app)
      .post("/api/ai/ask")
      .set("x-test-role", "doctor")
      .set("x-test-id", "doctor-1")
      .send({
        prompt: "Analyze this prescription document.",
        patientId: "patient-1",
        documentId,
      });

    expect(response.status).toBe(200);
    expect(response.body.documentMetadata?.extractionConfidence?.level).toBe("low");
    expect(response.body.safety?.warnings?.join(" ")).toMatch(
      /extraction confidence is low/i
    );
    const sectionKeys = (response.body.sections || []).map((section) => section.key);
    expect(sectionKeys).toContain("safety");
  });

  it("enforces doctor-patient validation on GET /api/ai/chat when patientId is supplied", async () => {
    mockState.doctorAccessDefault = false;

    const response = await request(app)
      .get("/api/ai/chat?patientId=patient-2")
      .set("x-test-role", "doctor")
      .set("x-test-id", "doctor-1");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("NO_ACTIVE_SESSION");
  });

  it("enforces doctor-patient validation on DELETE /api/ai/chat when patientId is supplied", async () => {
    mockState.doctorAccessDefault = false;

    const response = await request(app)
      .delete("/api/ai/chat?patientId=patient-2")
      .set("x-test-role", "doctor")
      .set("x-test-id", "doctor-1");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("NO_ACTIVE_SESSION");
  });
});
