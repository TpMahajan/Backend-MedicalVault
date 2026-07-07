import express from "express";
import fs from "fs";
import path from "path";
import request from "supertest";
import { fileURLToPath } from "url";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsRoot = path.resolve(__dirname, "../uploads/lost-found");

const mockState = {
  lostReports: new Map(),
  foundReports: new Map(),
  matches: new Map(),
};

// ---------- auth mock (drives both user auth and admin middleware) ----------
const authMock = jest.fn((req, res, next) => {
  const role = String(req.headers["x-test-role"] || "").toLowerCase();
  if (!role || role === "anonymous") {
    return res
      .status(401)
      .json({ success: false, message: "Authentication required" });
  }

  const id = String(req.headers["x-test-id"] || `${role}-1`);
  req.auth = { role, id, email: `${role}@example.com` };
  if (role === "patient") req.user = { _id: id, name: "Patient Mock" };
  if (role === "admin") {
    req.admin = {
      _id: id,
      name: "Admin Mock",
      role: "ADMIN",
      permissions: String(req.headers["x-test-permissions"] || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  }
  return next();
});

// ---------- model mocks ----------
const makeLeanChain = (result) => {
  const chain = {
    sort: () => chain,
    limit: () => chain,
    populate: () => chain,
    lean: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
};

const lostPersonReportMock = {
  create: jest.fn(async (payload) => {
    const doc = { _id: `lost-${mockState.lostReports.size + 1}`, ...payload };
    mockState.lostReports.set(doc._id, doc);
    return doc;
  }),
  find: jest.fn((filter = {}) => {
    const docs = Array.from(mockState.lostReports.values())
      .filter(
        (doc) =>
          !filter.reportedByUserId ||
          String(doc.reportedByUserId) === String(filter.reportedByUserId),
      )
      .map((doc) => ({ ...doc, toObject: () => ({ ...doc }) }));
    const chain = {
      sort: () => chain,
      populate: () => chain,
      then: (resolve, reject) => Promise.resolve(docs).then(resolve, reject),
    };
    return chain;
  }),
  findById: jest.fn(async (id) => mockState.lostReports.get(String(id)) || null),
  findByIdAndUpdate: jest.fn(async (id, update) => {
    const doc = mockState.lostReports.get(String(id));
    if (doc && update?.status) doc.status = update.status;
    return doc || null;
  }),
};

const foundPersonReportMock = {
  create: jest.fn(async (payload) => {
    const doc = { _id: `found-${mockState.foundReports.size + 1}`, ...payload };
    mockState.foundReports.set(doc._id, doc);
    return doc;
  }),
  find: jest.fn(() =>
    makeLeanChain(Array.from(mockState.foundReports.values())),
  ),
  findByIdAndUpdate: jest.fn(async (id, update) => {
    const doc = mockState.foundReports.get(String(id));
    if (doc && update?.status) doc.status = update.status;
    return doc || null;
  }),
};

const lostFoundMatchMock = {
  find: jest.fn(() => makeLeanChain(Array.from(mockState.matches.values()))),
  findById: jest.fn(async (id) => mockState.matches.get(String(id)) || null),
  updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
};

const matchLostToFoundMock = jest.fn(async () => []);
const matchFoundToLostMock = jest.fn(async () => []);
const broadcastLostPersonAlertMock = jest.fn(async () => ({ status: "sent" }));

await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: authMock,
}));
await jest.unstable_mockModule("../config/s3.js", () => ({
  // No resolvable credentials -> uploadStoragePolicy decides local vs 503.
  default: { config: { credentials: null } },
  BUCKET_NAME: "test-bucket",
  REGION: "test-region",
}));
await jest.unstable_mockModule("../utils/s3Utils.js", () => ({
  generateSignedUrl: jest.fn(async (key) => `https://signed.example/${key}`),
  generatePreviewUrl: jest.fn(async (key) => `https://signed.example/${key}`),
  generateDownloadUrl: jest.fn(async (key) => `https://signed.example/${key}`),
}));
await jest.unstable_mockModule("../config/firebase.js", () => ({
  sendPushNotification: jest.fn(async () => ({ success: true })),
}));
await jest.unstable_mockModule("../models/LostPersonReport.js", () => ({
  LostPersonReport: lostPersonReportMock,
}));
await jest.unstable_mockModule("../models/FoundPersonReport.js", () => ({
  FoundPersonReport: foundPersonReportMock,
}));
await jest.unstable_mockModule("../models/LostFoundMatch.js", () => ({
  LostFoundMatch: lostFoundMatchMock,
}));
await jest.unstable_mockModule("../models/User.js", () => ({
  User: { findById: jest.fn(() => ({ select: async () => null })) },
}));
await jest.unstable_mockModule("../models/Notification.js", () => ({
  Notification: class {
    async save() {
      return this;
    }
  },
}));
await jest.unstable_mockModule("../services/lostFoundMatcher.js", () => ({
  matchLostToFound: matchLostToFoundMock,
  matchFoundToLost: matchFoundToLostMock,
}));
await jest.unstable_mockModule("../services/lostFoundBroadcast.js", () => ({
  broadcastLostPersonAlert: broadcastLostPersonAlertMock,
}));
await jest.unstable_mockModule("../middleware/rateLimit.js", () => ({
  lostReportLimiter: (req, res, next) => next(),
}));

const { default: lostFoundRouter } = await import("./lostFound.js");
const { default: adminLostFoundRouter } = await import("./adminLostFound.js");

const app = express();
app.use(express.json());
app.use("/api/lost-found", lostFoundRouter);
app.use("/api/admin/lost-found", adminLostFoundRouter);

const JPG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("fake-jpg-body"),
]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-png-body"),
]);

const preexistingUploads = new Set(
  fs.existsSync(uploadsRoot) ? fs.readdirSync(uploadsRoot) : [],
);

const flushMatcherQueue = () =>
  new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

const originalNodeEnv = process.env.NODE_ENV;
const originalFallbackFlag = process.env.ALLOW_LOCAL_UPLOAD_FALLBACK;

describe("lost & found API integration", () => {
  beforeEach(() => {
    mockState.lostReports.clear();
    mockState.foundReports.clear();
    mockState.matches.clear();
    matchLostToFoundMock.mockClear();
    matchFoundToLostMock.mockClear();
    broadcastLostPersonAlertMock.mockClear();
    lostFoundMatchMock.updateMany.mockClear();
    process.env.NODE_ENV = "development";
    delete process.env.ALLOW_LOCAL_UPLOAD_FALLBACK;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalFallbackFlag === undefined) {
      delete process.env.ALLOW_LOCAL_UPLOAD_FALLBACK;
    } else {
      process.env.ALLOW_LOCAL_UPLOAD_FALLBACK = originalFallbackFlag;
    }
  });

  afterAll(() => {
    if (!fs.existsSync(uploadsRoot)) return;
    for (const entry of fs.readdirSync(uploadsRoot)) {
      if (!preexistingUploads.has(entry)) {
        fs.rmSync(path.join(uploadsRoot, entry), { force: true });
      }
    }
  });

  describe("photo upload", () => {
    it("accepts a JPG photo and returns a photoUrl (local dev fallback)", async () => {
      const res = await request(app)
        .post("/api/lost-found/upload-photo")
        .set("x-test-role", "patient")
        .attach("photo", JPG_BYTES, {
          filename: "person.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.photoUrl).toContain("/uploads/lost-found/");
      expect(res.body.data.storage).toBe("local");
    });

    it("accepts a PNG photo", async () => {
      const res = await request(app)
        .post("/api/lost-found/upload-photo")
        .set("x-test-role", "patient")
        .attach("photo", PNG_BYTES, {
          filename: "person.png",
          contentType: "image/png",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.photoUrl).toContain("/uploads/lost-found/");
    });

    it("rejects an unsupported file type", async () => {
      const res = await request(app)
        .post("/api/lost-found/upload-photo")
        .set("x-test-role", "patient")
        .attach("photo", Buffer.from("not an image"), {
          filename: "notes.txt",
          contentType: "text/plain",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("requires authentication", async () => {
      const res = await request(app)
        .post("/api/lost-found/upload-photo")
        .set("x-test-role", "anonymous")
        .attach("photo", JPG_BYTES, {
          filename: "person.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(401);
    });

    it("returns 503 in production when S3 is missing (no public local fallback)", async () => {
      process.env.NODE_ENV = "production";

      const res = await request(app)
        .post("/api/lost-found/upload-photo")
        .set("x-test-role", "patient")
        .attach("photo", JPG_BYTES, {
          filename: "person.jpg",
          contentType: "image/jpeg",
        });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
    });
  });

  describe("report submission", () => {
    it("creates a lost report with photoUrl and queues matching", async () => {
      const res = await request(app)
        .post("/api/lost-found/lost")
        .set("x-test-role", "patient")
        .send({
          personName: "Asha Kumari",
          approxAge: 62,
          gender: "female",
          photoUrl: "https://example.com/uploads/lost-found/asha.jpg",
          photoSource: "uploaded_family",
          lastSeenLat: 28.6139,
          lastSeenLng: 77.209,
          lastSeenTime: "2026-07-07T08:00:00.000Z",
          description: "White saree, walks with a stick",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.lostReport.photoUrl).toBe(
        "https://example.com/uploads/lost-found/asha.jpg",
      );
      expect(res.body.data.matchingQueued).toBe(true);

      await flushMatcherQueue();
      expect(matchLostToFoundMock).toHaveBeenCalledTimes(1);
      // Creating a lost report triggers the nearby-alert broadcast.
      expect(broadcastLostPersonAlertMock).toHaveBeenCalledTimes(1);
    });

    it("rejects an uploaded-photo lost report without photoUrl", async () => {
      const res = await request(app)
        .post("/api/lost-found/lost")
        .set("x-test-role", "patient")
        .send({ personName: "Asha", photoSource: "uploaded_family" });

      expect(res.status).toBe(400);
    });

    it("creates a found report and queues matching", async () => {
      const res = await request(app)
        .post("/api/lost-found/found")
        .set("x-test-role", "patient")
        .send({
          approxAge: 60,
          gender: "female",
          description: "Elderly woman in white saree",
          currentLat: 28.61,
          currentLng: 77.21,
          photoUrl: "https://example.com/uploads/lost-found/found.jpg",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.matchingQueued).toBe(true);

      await flushMatcherQueue();
      expect(matchFoundToLostMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a found report without coordinates", async () => {
      const res = await request(app)
        .post("/api/lost-found/found")
        .set("x-test-role", "patient")
        .send({ photoUrl: "https://example.com/x.jpg" });

      expect(res.status).toBe(400);
    });

    it("rejects a found report without photoUrl", async () => {
      const res = await request(app)
        .post("/api/lost-found/found")
        .set("x-test-role", "patient")
        .send({ currentLat: 28.61, currentLng: 77.21 });

      expect(res.status).toBe(400);
    });

    it("lists only the requester's lost reports", async () => {
      mockState.lostReports.set("lost-a", {
        _id: "lost-a",
        reportedByUserId: "patient-1",
        personName: "Mine",
      });
      mockState.lostReports.set("lost-b", {
        _id: "lost-b",
        reportedByUserId: "someone-else",
        personName: "Not mine",
      });

      const res = await request(app)
        .get("/api/lost-found/my-lost-reports")
        .set("x-test-role", "patient")
        .set("x-test-id", "patient-1");

      expect(res.status).toBe(200);
      expect(res.body.data.reports).toHaveLength(1);
      expect(res.body.data.reports[0].personName).toBe("Mine");
    });
  });

  describe("admin moderation", () => {
    const adminHeaders = {
      "x-test-role": "admin",
      "x-test-permissions": "VIEW_SOS,HANDLE_SOS",
    };

    it("denies anonymous access", async () => {
      const res = await request(app)
        .get("/api/admin/lost-found/matches")
        .set("x-test-role", "anonymous");
      expect(res.status).toBe(401);
    });

    it("denies non-admin roles", async () => {
      const res = await request(app)
        .get("/api/admin/lost-found/matches")
        .set("x-test-role", "patient");
      expect(res.status).toBe(403);
    });

    it("denies admins missing the required permission", async () => {
      const res = await request(app)
        .post("/api/admin/lost-found/matches/match-1/confirm")
        .set("x-test-role", "admin")
        .set("x-test-permissions", "VIEW_SOS");
      expect(res.status).toBe(403);
    });

    it("lists suggested matches for a permitted admin", async () => {
      mockState.matches.set("match-1", {
        _id: "match-1",
        lostReportId: { _id: "lost-a" },
        foundReportId: { _id: "found-a" },
        score: 72,
        status: "suggested",
      });

      const res = await request(app)
        .get("/api/admin/lost-found/matches")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.data.matches).toHaveLength(1);
      expect(res.body.data.matches[0].score).toBe(72);
    });

    it("lists found reports for a permitted admin", async () => {
      mockState.foundReports.set("found-a", {
        _id: "found-a",
        status: "unmatched",
        gender: "Female",
      });

      const res = await request(app)
        .get("/api/admin/lost-found/found-reports")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.data.reports).toHaveLength(1);
    });

    it("confirms a match, updates both reports, and rejects competing matches", async () => {
      const saveSpy = jest.fn(async function save() {
        return this;
      });
      mockState.lostReports.set("lost-a", { _id: "lost-a", status: "open" });
      mockState.foundReports.set("found-a", {
        _id: "found-a",
        status: "unmatched",
      });
      mockState.matches.set("match-1", {
        _id: "match-1",
        lostReportId: "lost-a",
        foundReportId: "found-a",
        score: 72,
        status: "suggested",
        save: saveSpy,
      });

      const res = await request(app)
        .post("/api/admin/lost-found/matches/match-1/confirm")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(mockState.matches.get("match-1").status).toBe("confirmed");
      expect(saveSpy).toHaveBeenCalled();
      expect(lostPersonReportMock.findByIdAndUpdate).toHaveBeenCalledWith(
        "lost-a",
        expect.objectContaining({ status: "matched" }),
        expect.anything(),
      );
      expect(foundPersonReportMock.findByIdAndUpdate).toHaveBeenCalledWith(
        "found-a",
        expect.objectContaining({ status: "matched" }),
      );
      expect(lostFoundMatchMock.updateMany).toHaveBeenCalled();
    });

    it("rejects a match", async () => {
      mockState.matches.set("match-2", {
        _id: "match-2",
        lostReportId: "lost-a",
        foundReportId: "found-a",
        score: 65,
        status: "suggested",
        save: jest.fn(async function save() {
          return this;
        }),
      });

      const res = await request(app)
        .post("/api/admin/lost-found/matches/match-2/reject")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(mockState.matches.get("match-2").status).toBe("rejected");
    });

    it("returns 404 for an unknown match id", async () => {
      const res = await request(app)
        .post("/api/admin/lost-found/matches/does-not-exist/confirm")
        .set(adminHeaders);
      expect(res.status).toBe(404);
    });
  });
});
