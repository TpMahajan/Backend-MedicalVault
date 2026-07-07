import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const state = { reports: new Map() };

const authMock = jest.fn((req, res, next) => {
  const role = String(req.headers["x-test-role"] || "").toLowerCase();
  if (!role || role === "anonymous") {
    return res
      .status(401)
      .json({ success: false, message: "Authentication required" });
  }
  const id = String(req.headers["x-test-id"] || `${role}-1`);
  req.auth = { role, id, email: `${role}@example.com` };
  if (role === "patient") req.user = { _id: id };
  return next();
});

// LostPersonReport.find(query).sort().limit().lean()  and  findById(id).lean()
const applyFilter = (query = {}) => {
  let docs = Array.from(state.reports.values());
  if (query.status) docs = docs.filter((d) => d.status === query.status);
  if (query.personName?.$regex) {
    const re = new RegExp(query.personName.$regex, query.personName.$options);
    docs = docs.filter((d) => re.test(d.personName || ""));
  }
  if (query.gender) docs = docs.filter((d) => d.gender === query.gender);
  return docs;
};

const lostPersonReportMock = {
  find: jest.fn((query = {}) => {
    const chain = {
      sort: () => chain,
      limit: () => chain,
      lean: async () => applyFilter(query),
      then: (resolve, reject) =>
        Promise.resolve(applyFilter(query)).then(resolve, reject),
    };
    return chain;
  }),
  findById: jest.fn((id) => ({
    lean: async () => state.reports.get(String(id)) || null,
  })),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findOneAndUpdate: jest.fn(),
};

await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: authMock,
}));
await jest.unstable_mockModule("../middleware/rateLimit.js", () => ({
  lostReportLimiter: (req, res, next) => next(),
}));
await jest.unstable_mockModule("../config/s3.js", () => ({
  default: { config: { credentials: null } },
  BUCKET_NAME: "test-bucket",
  REGION: "test-region",
}));
await jest.unstable_mockModule("../utils/s3Utils.js", () => ({
  generateSignedUrl: jest.fn(async (key) => `https://signed.example/${key}`),
  generatePreviewUrl: jest.fn(async (key) => `https://signed.example/${key}`),
  generateDownloadUrl: jest.fn(async (key) => `https://signed.example/${key}`),
}));
await jest.unstable_mockModule("../services/uploadStoragePolicy.js", () => ({
  resolveUploadStorage: jest.fn(async () => "local"),
}));
await jest.unstable_mockModule("../services/lostFoundMatcher.js", () => ({
  matchLostToFound: jest.fn(),
  matchFoundToLost: jest.fn(),
}));
await jest.unstable_mockModule("../services/lostFoundBroadcast.js", () => ({
  broadcastLostPersonAlert: jest.fn(),
}));
await jest.unstable_mockModule("../models/LostPersonReport.js", () => ({
  LostPersonReport: lostPersonReportMock,
}));
await jest.unstable_mockModule("../models/FoundPersonReport.js", () => ({
  FoundPersonReport: { create: jest.fn() },
}));
await jest.unstable_mockModule("../models/User.js", () => ({
  User: { findById: jest.fn(() => ({ select: async () => null })) },
}));

const { default: lostFoundRouter } = await import("./lostFound.js");

const app = express();
app.use(express.json());
app.use("/api/lost-found", lostFoundRouter);

const seedReport = (over = {}) => {
  const id = over._id || `id-${state.reports.size + 1}`.padStart(24, "0");
  const doc = {
    _id: id,
    status: "open",
    personName: "Asha Kumari",
    approxAge: 62,
    gender: "Female",
    description: "White saree",
    city: "Nashik",
    state: "Maharashtra",
    lastSeenLocationText: "Nashik, Maharashtra",
    lastSeenTime: new Date("2026-07-05T08:00:00.000Z"),
    photoUrl: "https://cdn.example/asha.jpg",
    reporterPhone: "9876543210",
    reporterEmail: "reporter@example.com",
    medicalNotes: "diabetes",
    identificationDetails: "scar",
    allowReporterContact: false,
    publicContactName: "Ravi",
    publicContactPhone: "9876543210",
    ...over,
  };
  state.reports.set(String(id), doc);
  return doc;
};

describe("lost & found search + detail", () => {
  beforeEach(() => {
    state.reports.clear();
    lostPersonReportMock.find.mockClear();
    lostPersonReportMock.findById.mockClear();
  });

  describe("GET /search", () => {
    it("requires authentication", async () => {
      const res = await request(app)
        .get("/api/lost-found/search?q=asha")
        .set("x-test-role", "anonymous");
      expect(res.status).toBe(401);
    });

    it("finds an open report by name and never leaks sensitive fields", async () => {
      seedReport();
      const res = await request(app)
        .get("/api/lost-found/search")
        .query({ q: "asha" })
        .set("x-test-role", "patient");

      expect(res.status).toBe(200);
      expect(res.body.data.results).toHaveLength(1);
      const r = res.body.data.results[0];
      expect(r.personName).toBe("Asha Kumari");
      expect(r.photoUrl).toBe("https://cdn.example/asha.jpg");
      // Sensitive fields must NOT be present.
      expect(r.reporterPhone).toBeUndefined();
      expect(r.reporterEmail).toBeUndefined();
      expect(r.medicalNotes).toBeUndefined();
      expect(r.identificationDetails).toBeUndefined();
      // Contact hidden because allowReporterContact is false.
      expect(r.contact).toBeNull();
    });

    it("only queries open reports", async () => {
      seedReport();
      await request(app)
        .get("/api/lost-found/search?q=asha")
        .set("x-test-role", "patient");
      const queryArg = lostPersonReportMock.find.mock.calls[0][0];
      expect(queryArg.status).toBe("open");
    });

    it("exposes masked contact only when the report allows it", async () => {
      seedReport({ allowReporterContact: true });
      const res = await request(app)
        .get("/api/lost-found/search?q=asha")
        .set("x-test-role", "patient");
      const r = res.body.data.results[0];
      expect(r.contact).not.toBeNull();
      expect(r.contact.name).toBe("Ravi");
      expect(r.contact.maskedPhone).toMatch(/\*+210$/);
      // Full phone is never included in search results.
      expect(r.contact.phone).toBeNull();
    });

    it("returns empty results when nothing matches", async () => {
      seedReport();
      const res = await request(app)
        .get("/api/lost-found/search?q=zzzznotfound")
        .set("x-test-role", "patient");
      expect(res.body.data.results).toHaveLength(0);
    });
  });

  describe("GET /lost/:id", () => {
    it("rejects an invalid id", async () => {
      const res = await request(app)
        .get("/api/lost-found/lost/not-an-objectid")
        .set("x-test-role", "patient");
      expect(res.status).toBe(400);
    });

    it("404s for a missing report", async () => {
      const res = await request(app)
        .get(`/api/lost-found/lost/${"a".repeat(24)}`)
        .set("x-test-role", "patient");
      expect(res.status).toBe(404);
    });

    it("returns safe detail with hidden contact by default", async () => {
      const doc = seedReport({ _id: "b".repeat(24) });
      const res = await request(app)
        .get(`/api/lost-found/lost/${doc._id}`)
        .set("x-test-role", "patient");
      expect(res.status).toBe(200);
      const r = res.body.data.report;
      expect(r.personName).toBe("Asha Kumari");
      expect(r.reporterPhone).toBeUndefined();
      expect(r.contact).toBeNull();
    });

    it("returns full contact when the report allows it", async () => {
      const doc = seedReport({ _id: "c".repeat(24), allowReporterContact: true });
      const res = await request(app)
        .get(`/api/lost-found/lost/${doc._id}`)
        .set("x-test-role", "patient");
      const r = res.body.data.report;
      expect(r.contact.phone).toBe("9876543210");
    });
  });
});
