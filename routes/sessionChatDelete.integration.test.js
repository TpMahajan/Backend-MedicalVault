import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// Covers the new "delete chat" feature (long-press / 3-dot menu in the
// Flutter app): DELETE /api/sessions/chat/threads/:counterpartId with
// mode "me" (per-principal hide via ChatThreadHiddenState, keyed on the
// last message's _id rather than a wall-clock timestamp so it can never
// race with a message created "at the same instant" as the delete) or
// "everyone" (hard delete, affects both participants), plus the
// corresponding GET filtering.

const DOCTOR_ID = "507f1f77bcf86cd799439012";
const PATIENT_ID = "507f1f77bcf86cd799439011";

const state = {
  messages: [], // each has a monotonically increasing hex _id, like a real ObjectId
  hiddenStates: new Map(), // key: `${doctorId}:${patientId}:${role}` -> { hiddenBeforeMessageId }
  nextMessageSeq: 1,
};

const key = (doctorId, patientId, role) => `${doctorId}:${patientId}:${role}`;

// A fake but validly-shaped, monotonically increasing 24-char hex "ObjectId"
// so string comparison behaves the same way real ObjectId comparison does.
const nextMessageId = () => {
  const seq = state.nextMessageSeq++;
  return seq.toString(16).padStart(24, "0");
};

const sessionFindOneMock = jest.fn(() => ({
  sort: () => ({
    select: () => ({
      lean: async () => ({ _id: "session-1", status: "accepted", createdAt: new Date() }),
    }),
  }),
}));

const appointmentFindOneMock = jest.fn(() => ({
  sort: () => ({ select: () => ({ lean: async () => null }) }),
}));

const userFindMock = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));
const doctorFindMock = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));

const directMessageAggregateMock = jest.fn(async (pipeline) => {
  // Mirrors the real pipeline's shape closely enough for the route's
  // post-processing logic under test: first stage is always the requester
  // scope match ({ doctorId: authObjectId } or { patientId: authObjectId }).
  const matchStage = pipeline[0].$match;
  const isDoctorRequest = "doctorId" in matchStage;
  const requesterId = String(matchStage.doctorId || matchStage.patientId);

  const scoped = state.messages.filter((msg) =>
    isDoctorRequest ? msg.doctorId === requesterId : msg.patientId === requesterId
  );

  const byCounterpart = new Map();
  for (const msg of scoped) {
    const counterpartId = isDoctorRequest ? msg.patientId : msg.doctorId;
    const existing = byCounterpart.get(counterpartId);
    if (!existing || msg._id > existing.lastMessageId) {
      byCounterpart.set(counterpartId, {
        _id: counterpartId,
        doctorId: msg.doctorId,
        patientId: msg.patientId,
        lastMessage: msg.message,
        lastSenderRole: msg.senderRole,
        lastAt: msg.createdAt,
        lastMessageId: msg._id,
        unreadCount: 0,
      });
    }
  }
  return Array.from(byCounterpart.values());
});

const directMessageFindOneMock = jest.fn((filter) => ({
  sort: () => ({
    select: () => ({
      lean: async () => {
        const docs = state.messages.filter(
          (m) => m.doctorId === String(filter.doctorId) && m.patientId === String(filter.patientId)
        );
        if (!docs.length) return null;
        return [...docs].sort((a, b) => (a._id > b._id ? -1 : 1))[0];
      },
    }),
  }),
}));

const directMessageFindMock = jest.fn((filter) => ({
  sort: () => ({
    limit: () => ({
      lean: async () => {
        let docs = state.messages.filter(
          (m) => m.doctorId === String(filter.doctorId) && m.patientId === String(filter.patientId)
        );
        if (filter._id?.$gt) {
          docs = docs.filter((m) => m._id > String(filter._id.$gt));
        }
        return [...docs].sort((a, b) => (a._id > b._id ? -1 : 1));
      },
    }),
  }),
}));

const directMessageUpdateManyMock = jest.fn(async () => ({ modifiedCount: 0 }));
const directMessageDeleteManyMock = jest.fn(async (filter) => {
  const before = state.messages.length;
  state.messages = state.messages.filter(
    (m) => !(m.doctorId === String(filter.doctorId) && m.patientId === String(filter.patientId))
  );
  return { deletedCount: before - state.messages.length };
});

const hiddenStateFindOneMock = jest.fn((filter) => ({
  select: () => ({
    lean: async () => {
      const found = state.hiddenStates.get(
        key(String(filter.doctorId), String(filter.patientId), filter.hiddenForRole)
      );
      return found ? { hiddenBeforeMessageId: found.hiddenBeforeMessageId } : null;
    },
  }),
}));

const hiddenStateFindMock = jest.fn((filter) => ({
  select: () => ({
    lean: async () => {
      const results = [];
      for (const [k, value] of state.hiddenStates.entries()) {
        const [doctorId, patientId, hiddenForRole] = k.split(":");
        if (hiddenForRole !== filter.hiddenForRole) continue;
        if (filter.doctorId && String(filter.doctorId) !== doctorId) continue;
        if (filter.patientId && String(filter.patientId) !== patientId) continue;
        results.push({ doctorId, patientId, hiddenBeforeMessageId: value.hiddenBeforeMessageId });
      }
      return results;
    },
  }),
}));

const hiddenStateFindOneAndUpdateMock = jest.fn(async (filter, update) => {
  const k = key(String(filter.doctorId), String(filter.patientId), filter.hiddenForRole);
  const record = { hiddenBeforeMessageId: update.$set.hiddenBeforeMessageId };
  state.hiddenStates.set(k, record);
  return record;
});

const hiddenStateDeleteManyMock = jest.fn(async (filter) => {
  for (const k of Array.from(state.hiddenStates.keys())) {
    const [doctorId, patientId] = k.split(":");
    if (doctorId === String(filter.doctorId) && patientId === String(filter.patientId)) {
      state.hiddenStates.delete(k);
    }
  }
});

const authMock = jest.fn((req, _res, next) => {
  req.auth = req.__testAuth || { role: "patient", id: PATIENT_ID };
  req.user = { _id: req.auth.id };
  next();
});

await jest.unstable_mockModule("../middleware/auth.js", () => ({ auth: authMock }));
await jest.unstable_mockModule("../models/Session.js", () => ({ Session: { findOne: sessionFindOneMock } }));
await jest.unstable_mockModule("../models/Appointment.js", () => ({ Appointment: { findOne: appointmentFindOneMock } }));
await jest.unstable_mockModule("../models/User.js", () => ({ User: { find: userFindMock } }));
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({ DoctorUser: { find: doctorFindMock } }));
await jest.unstable_mockModule("../models/DirectMessage.js", () => ({
  DirectMessage: {
    aggregate: directMessageAggregateMock,
    findOne: directMessageFindOneMock,
    find: directMessageFindMock,
    updateMany: directMessageUpdateManyMock,
    deleteMany: directMessageDeleteManyMock,
  },
}));
await jest.unstable_mockModule("../models/ChatThreadHiddenState.js", () => ({
  ChatThreadHiddenState: {
    findOne: hiddenStateFindOneMock,
    find: hiddenStateFindMock,
    findOneAndUpdate: hiddenStateFindOneAndUpdateMock,
    deleteMany: hiddenStateDeleteManyMock,
  },
}));
await jest.unstable_mockModule("../models/Notification.js", () => ({ Notification: { create: jest.fn() } }));
await jest.unstable_mockModule("../controllers/notificationController.js", () => ({
  broadcastNotification: jest.fn(async () => {}),
}));
await jest.unstable_mockModule("../utils/notifications.js", () => ({
  sendNotification: jest.fn(async () => true),
  sendNotificationToDoctor: jest.fn(async () => true),
}));
await jest.unstable_mockModule("../services/chatPresenceRealtime.js", () => ({
  emitNewDirectMessage: jest.fn(),
  emitTypingEvent: jest.fn(),
}));
await jest.unstable_mockModule("../services/sessionHistoryPersistence.js", () => ({
  persistSessionHistory: jest.fn(async () => {}),
}));
await jest.unstable_mockModule("../config/s3.js", () => ({ BUCKET_NAME: "test-bucket" }));
await jest.unstable_mockModule("../utils/s3Utils.js", () => ({ generateSignedUrl: jest.fn(async () => "https://example.com/signed") }));
await jest.unstable_mockModule("../models/RefreshToken.js", () => ({ RefreshToken: {} }));

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

const seedMessage = ({ doctorId = DOCTOR_ID, patientId = PATIENT_ID, senderRole = "patient", message }) => {
  state.messages.push({
    _id: nextMessageId(),
    doctorId,
    patientId,
    senderRole,
    message,
    createdAt: new Date(),
  });
};

describe("DELETE /api/sessions/chat/threads/:counterpartId", () => {
  beforeEach(() => {
    state.messages = [];
    state.hiddenStates.clear();
    state.nextMessageSeq = 1;
    jest.clearAllMocks();
    withAuth({ role: "patient", id: PATIENT_ID });
  });

  it("'delete for me' hides the thread for the deleting patient without touching the doctor's view", async () => {
    seedMessage({ message: "Hello" });

    const del = await request(app)
      .delete(`/api/sessions/chat/threads/${DOCTOR_ID}`)
      .send({ mode: "me" });
    expect(del.status).toBe(200);
    expect(del.body.mode).toBe("me");

    // Patient's own thread list no longer shows it.
    const patientThreads = await request(app).get("/api/sessions/chat/threads");
    expect(patientThreads.body.threads).toHaveLength(0);

    // Doctor's thread list is completely unaffected - the shared rows were
    // never touched.
    withAuth({ role: "doctor", id: DOCTOR_ID });
    const doctorThreads = await request(app).get("/api/sessions/chat/threads");
    expect(doctorThreads.body.threads).toHaveLength(1);

    // The underlying message rows still exist (not a hard delete).
    expect(state.messages).toHaveLength(1);
  });

  it("a new message after 'delete for me' makes the thread reappear for the deleting side, even created immediately afterward", async () => {
    seedMessage({ message: "Old message" });

    await request(app).delete(`/api/sessions/chat/threads/${DOCTOR_ID}`).send({ mode: "me" });

    let threads = await request(app).get("/api/sessions/chat/threads");
    expect(threads.body.threads).toHaveLength(0);

    // Simulate a new message arriving right after the delete - the
    // _id-based watermark guarantees correct ordering even with no time gap.
    seedMessage({ message: "New message", senderRole: "doctor" });

    threads = await request(app).get("/api/sessions/chat/threads");
    expect(threads.body.threads).toHaveLength(1);
    expect(threads.body.threads[0].lastMessage).toBe("New message");
  });

  it("'delete for me' hides old messages but not ones sent after the watermark, in the message list", async () => {
    seedMessage({ message: "Old" });
    await request(app).delete(`/api/sessions/chat/threads/${DOCTOR_ID}`).send({ mode: "me" });
    seedMessage({ message: "New", senderRole: "doctor" });

    const res = await request(app).get(`/api/sessions/chat/messages/${DOCTOR_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m) => m.message)).toEqual(["New"]);
  });

  it("'delete for everyone' hard-deletes the shared messages for both sides", async () => {
    seedMessage({ message: "Hello" });

    const del = await request(app)
      .delete(`/api/sessions/chat/threads/${DOCTOR_ID}`)
      .send({ mode: "everyone" });
    expect(del.status).toBe(200);
    expect(del.body.mode).toBe("everyone");
    expect(del.body.deletedCount).toBe(1);
    expect(state.messages).toHaveLength(0);

    withAuth({ role: "doctor", id: DOCTOR_ID });
    const doctorThreads = await request(app).get("/api/sessions/chat/threads");
    expect(doctorThreads.body.threads).toHaveLength(0);
  });

  it("rejects an invalid mode", async () => {
    const res = await request(app)
      .delete(`/api/sessions/chat/threads/${DOCTOR_ID}`)
      .send({ mode: "invalid" });
    expect(res.status).toBe(400);
  });

  it("defaults to 'me' when mode is omitted", async () => {
    seedMessage({ message: "Hello" });
    const res = await request(app).delete(`/api/sessions/chat/threads/${DOCTOR_ID}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("me");
    expect(state.messages).toHaveLength(1); // not hard-deleted
  });

  it("rejects an invalid counterpart id", async () => {
    const res = await request(app)
      .delete("/api/sessions/chat/threads/not-a-valid-id")
      .send({ mode: "me" });
    expect(res.status).toBe(400);
  });
});
