import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// Covers the individual-message deletion feature (long-press in the
// Flutter/web chat UI): DELETE /api/sessions/chat/messages/:messageId/for-me
// (hide for the requesting participant only) and .../for-everyone (sender
// only, within the configured recall window, tombstones the message),
// plus reverse-cursor pagination and hiddenForUsers/isDeletedForEveryone
// filtering on GET /chat/messages/:counterpartId and GET /chat/threads.
//
// A faithful in-memory model of DirectMessage is used (rather than the
// simplified fixture in sessionChatDelete.integration.test.js) since this
// suite specifically needs to verify hiddenForUsers/$lt/$gt/limit/sort
// semantics, not just high-level route behavior.

process.env.CHAT_DELETE_FOR_EVERYONE_WINDOW_HOURS = "60";

const DOCTOR_ID = "507f1f77bcf86cd799439012";
const PATIENT_ID = "507f1f77bcf86cd799439011";

const state = {
  messages: [], // full docs, as stored
  nextSeq: 1,
};

// Validly-shaped, monotonically increasing 24-char hex "ObjectId" so string
// comparison behaves like real ObjectId comparison.
const nextMessageId = () => {
  const seq = state.nextSeq++;
  return seq.toString(16).padStart(24, "0");
};

const toObjectIdText = (value) => (value == null ? "" : String(value.toString ? value.toString() : value));

const matchesQuery = (doc, query) => {
  if (toObjectIdText(doc.doctorId) !== toObjectIdText(query.doctorId)) return false;
  if (toObjectIdText(doc.patientId) !== toObjectIdText(query.patientId)) return false;
  if (query.hiddenForUsers?.$ne !== undefined) {
    const excluded = toObjectIdText(query.hiddenForUsers.$ne);
    if (doc.hiddenForUsers.map(toObjectIdText).includes(excluded)) return false;
  }
  if (query._id?.$gt !== undefined && !(doc._id > toObjectIdText(query._id.$gt))) return false;
  if (query._id?.$lt !== undefined && !(doc._id < toObjectIdText(query._id.$lt))) return false;
  return true;
};

const findQuery = (query) => {
  let results = state.messages.filter((doc) => matchesQuery(doc, query));
  const builder = {
    sort: () => builder,
    limit: (n) => {
      results = [...results].sort((a, b) => (a._id > b._id ? -1 : 1)).slice(0, n);
      return builder;
    },
    lean: async () => results.map((doc) => ({ ...doc })),
  };
  return builder;
};

const directMessageFindMock = jest.fn((query) => findQuery(query));

const directMessageFindByIdMock = jest.fn(async (id) => {
  const doc = state.messages.find((m) => m._id === toObjectIdText(id));
  return doc ? { ...doc } : null;
});

const directMessageUpdateOneMock = jest.fn(async (filter, update) => {
  const doc = state.messages.find((m) => m._id === toObjectIdText(filter._id));
  if (!doc) return { matchedCount: 0, modifiedCount: 0 };
  if (filter.isDeletedForEveryone === false && doc.isDeletedForEveryone) {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  if (update.$addToSet?.hiddenForUsers !== undefined) {
    const id = toObjectIdText(update.$addToSet.hiddenForUsers);
    if (!doc.hiddenForUsers.map(toObjectIdText).includes(id)) doc.hiddenForUsers.push(id);
  }
  if (update.$set) Object.assign(doc, update.$set);
  return { matchedCount: 1, modifiedCount: 1 };
});

const directMessageUpdateManyMock = jest.fn(async () => ({ modifiedCount: 0 }));
const directMessageAggregateMock = jest.fn(async (pipeline) => {
  const matchStage = pipeline[0].$match;
  const isDoctorRequest = "doctorId" in matchStage;
  const requesterId = toObjectIdText(matchStage.doctorId || matchStage.patientId);
  const excludedForUser = toObjectIdText(matchStage.hiddenForUsers?.$ne);

  const scoped = state.messages.filter((msg) => {
    const belongsToRequester = isDoctorRequest
      ? msg.doctorId === requesterId
      : msg.patientId === requesterId;
    if (!belongsToRequester) return false;
    if (excludedForUser && msg.hiddenForUsers.map(toObjectIdText).includes(excludedForUser)) return false;
    return true;
  });

  const byCounterpart = new Map();
  for (const msg of [...scoped].sort((a, b) => (a._id > b._id ? -1 : 1))) {
    const counterpartId = isDoctorRequest ? msg.patientId : msg.doctorId;
    if (byCounterpart.has(counterpartId)) continue;
    byCounterpart.set(counterpartId, {
      _id: counterpartId,
      doctorId: msg.doctorId,
      patientId: msg.patientId,
      lastMessage: msg.isDeletedForEveryone ? "" : msg.message,
      lastMessageDeleted: msg.isDeletedForEveryone === true,
      lastSenderRole: msg.senderRole,
      lastAt: msg.createdAt,
      lastMessageId: msg._id,
      unreadCount: 0,
    });
  }
  return Array.from(byCounterpart.values());
});

const hiddenStateFindMock = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));
const hiddenStateFindOneMock = jest.fn(() => ({ select: () => ({ lean: async () => null }) }));

const sessionFindOneMock = jest.fn(() => ({
  sort: () => ({
    select: () => ({
      lean: async () => ({ _id: "session-1", status: "accepted", createdAt: new Date() }),
    }),
  }),
}));
const appointmentFindOneMock = jest.fn(() => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) }));
const userFindMock = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));
const doctorFindMock = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));
const emitMessageDeletedMock = jest.fn();

const authMock = jest.fn((req, _res, next) => {
  req.auth = req.__testAuth || { role: "patient", id: PATIENT_ID };
  req.user = { _id: req.auth.id };
  next();
});

await jest.unstable_mockModule("../middleware/auth.js", () => ({ auth: authMock }));
await jest.unstable_mockModule("../models/Session.js", () => ({ Session: { findOne: sessionFindOneMock } }));
await jest.unstable_mockModule("../models/Appointment.js", () => ({ Appointment: { findOne: appointmentFindOneMock } }));
await jest.unstable_mockModule("../models/User.js", () => ({ User: { find: userFindMock, findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })) } }));
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({ DoctorUser: { find: doctorFindMock, findById: jest.fn(() => ({ select: () => ({ lean: async () => null }) })) } }));
await jest.unstable_mockModule("../models/DirectMessage.js", () => ({
  DirectMessage: {
    aggregate: directMessageAggregateMock,
    find: directMessageFindMock,
    findById: directMessageFindByIdMock,
    findOne: jest.fn(() => ({ sort: () => ({ select: () => ({ lean: async () => null }) }) })),
    updateOne: directMessageUpdateOneMock,
    updateMany: directMessageUpdateManyMock,
    deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
  },
}));
await jest.unstable_mockModule("../models/ChatThreadHiddenState.js", () => ({
  ChatThreadHiddenState: {
    findOne: hiddenStateFindOneMock,
    find: hiddenStateFindMock,
    findOneAndUpdate: jest.fn(),
    deleteMany: jest.fn(),
  },
}));
await jest.unstable_mockModule("../models/Notification.js", () => ({ Notification: { create: jest.fn() } }));
await jest.unstable_mockModule("../controllers/notificationController.js", () => ({ broadcastNotification: jest.fn(async () => {}) }));
await jest.unstable_mockModule("../utils/notifications.js", () => ({
  sendNotification: jest.fn(async () => true),
  sendNotificationToDoctor: jest.fn(async () => true),
}));
await jest.unstable_mockModule("../services/chatPresenceRealtime.js", () => ({
  emitNewDirectMessage: jest.fn(),
  emitTypingEvent: jest.fn(),
  emitMessageDeleted: emitMessageDeletedMock,
  emitSessionPermissionsUpdated: jest.fn(),
}));
await jest.unstable_mockModule("../services/sessionHistoryPersistence.js", () => ({ persistSessionHistory: jest.fn(async () => {}) }));
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

const seedMessage = ({
  doctorId = DOCTOR_ID,
  patientId = PATIENT_ID,
  senderRole = "patient",
  message,
  createdAt = new Date(),
  isDeletedForEveryone = false,
}) => {
  const senderId = senderRole === "doctor" ? doctorId : patientId;
  const recipientRole = senderRole === "doctor" ? "patient" : "doctor";
  const recipientId = senderRole === "doctor" ? patientId : doctorId;
  const doc = {
    _id: nextMessageId(),
    doctorId,
    patientId,
    senderRole,
    senderId,
    recipientRole,
    recipientId,
    message,
    clientMessageId: `seed-${state.nextSeq}`,
    createdAt,
    readByRecipient: false,
    hiddenForUsers: [],
    isDeletedForEveryone,
    deletedForEveryoneAt: null,
    deletedForEveryoneBy: null,
  };
  state.messages.push(doc);
  return doc;
};

describe("Individual chat message deletion", () => {
  beforeEach(() => {
    state.messages = [];
    state.nextSeq = 1;
    jest.clearAllMocks();
    withAuth({ role: "patient", id: PATIENT_ID });
  });

  describe("DELETE /api/sessions/chat/messages/:messageId/for-me", () => {
    it("hides the message from the requester only, leaving the recipient's view untouched", async () => {
      const msg = seedMessage({ message: "Hello", senderRole: "patient" });

      const res = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-me`);
      expect(res.status).toBe(200);
      expect(res.body.deletionType).toBe("for-me");

      // Patient (the deleter) no longer sees it.
      const patientView = await request(app).get(`/api/sessions/chat/messages/${DOCTOR_ID}`);
      expect(patientView.body.messages).toHaveLength(0);

      // Doctor's view is completely unaffected.
      withAuth({ role: "doctor", id: DOCTOR_ID });
      const doctorView = await request(app).get(`/api/sessions/chat/messages/${PATIENT_ID}`);
      expect(doctorView.body.messages).toHaveLength(1);
      expect(doctorView.body.messages[0].message).toBe("Hello");
    });

    it("is idempotent: deleting an already-hidden message twice succeeds both times", async () => {
      const msg = seedMessage({ message: "Hello" });
      const first = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-me`);
      const second = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-me`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(state.messages[0].hiddenForUsers).toHaveLength(1);
    });

    it("works for a message the requester received, not just sent", async () => {
      const msg = seedMessage({ message: "From doctor", senderRole: "doctor" });
      const res = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-me`);
      expect(res.status).toBe(200);
    });

    it("rejects a non-participant", async () => {
      const msg = seedMessage({ message: "Hello" });
      withAuth({ role: "doctor", id: "507f1f77bcf86cd799439099" });
      const res = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-me`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("NOT_CONVERSATION_MEMBER");
    });

    it("returns MESSAGE_NOT_FOUND for a nonexistent message", async () => {
      const res = await request(app).delete(
        `/api/sessions/chat/messages/507f1f77bcf86cd799439000/for-me`
      );
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("MESSAGE_NOT_FOUND");
    });
  });

  describe("DELETE /api/sessions/chat/messages/:messageId/for-everyone", () => {
    it("allows the sender to delete within the recall window and scrubs the content", async () => {
      const msg = seedMessage({ message: "Secret", senderRole: "patient" });

      const res = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-everyone`);
      expect(res.status).toBe(200);
      expect(res.body.deletionType).toBe("for-everyone");
      expect(emitMessageDeletedMock).toHaveBeenCalledWith(
        expect.objectContaining({ deletionType: "for-everyone", messageId: msg._id })
      );

      expect(state.messages[0].isDeletedForEveryone).toBe(true);
      expect(state.messages[0].message).toBe("");

      // Recipient's read path shows no content.
      withAuth({ role: "doctor", id: DOCTOR_ID });
      const doctorView = await request(app).get(`/api/sessions/chat/messages/${PATIENT_ID}`);
      expect(doctorView.body.messages[0].message).toBe("");
      expect(doctorView.body.messages[0].isDeletedForEveryone).toBe(true);
    });

    it("rejects the recipient attempting to delete-for-everyone (only the sender may)", async () => {
      const msg = seedMessage({ message: "Secret", senderRole: "patient" });
      withAuth({ role: "doctor", id: DOCTOR_ID });
      const res = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-everyone`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("DELETE_FOR_EVERYONE_NOT_ALLOWED");
      expect(state.messages[0].isDeletedForEveryone).toBe(false);
    });

    it("rejects deletion after the recall window has expired (server clock, not client-supplied)", async () => {
      const sixtyOneHoursAgo = new Date(Date.now() - 61 * 60 * 60 * 1000);
      const msg = seedMessage({ message: "Old message", senderRole: "patient", createdAt: sixtyOneHoursAgo });

      const res = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-everyone`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("DELETE_WINDOW_EXPIRED");
      expect(state.messages[0].isDeletedForEveryone).toBe(false);
    });

    it("allows deletion just inside the window boundary", async () => {
      const fiftyNineHoursAgo = new Date(Date.now() - 59 * 60 * 60 * 1000);
      const msg = seedMessage({ message: "Recent enough", senderRole: "patient", createdAt: fiftyNineHoursAgo });
      const res = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-everyone`);
      expect(res.status).toBe(200);
    });

    it("is idempotent: deleting an already-deleted-for-everyone message replays success", async () => {
      const msg = seedMessage({ message: "Secret", senderRole: "patient" });
      const first = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-everyone`);
      const second = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-everyone`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.alreadyDeleted).toBe(true);
      // Only one real deletion side-effect (WS emit) occurred.
      expect(emitMessageDeletedMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-participant entirely (not just non-sender)", async () => {
      const msg = seedMessage({ message: "Hello" });
      withAuth({ role: "doctor", id: "507f1f77bcf86cd799439099" });
      const res = await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-everyone`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("NOT_CONVERSATION_MEMBER");
    });
  });

  describe("Thread list preview respects deletion state", () => {
    it("shows an empty lastMessage and lastMessageDeleted=true when the last message was deleted for everyone", async () => {
      seedMessage({ message: "Visible" });
      const last = seedMessage({ message: "Deleted", isDeletedForEveryone: true });
      // Reflect the tombstone write's content-scrub, as the real update does.
      last.message = "";

      const res = await request(app).get("/api/sessions/chat/threads");
      expect(res.status).toBe(200);
      expect(res.body.threads[0].lastMessage).toBe("");
      expect(res.body.threads[0].lastMessageDeleted).toBe(true);
    });

    it("excludes a thread's messages that are hidden-for-me from that user's thread preview data", async () => {
      const msg = seedMessage({ message: "Hello" });
      await request(app).delete(`/api/sessions/chat/messages/${msg._id}/for-me`);

      const res = await request(app).get("/api/sessions/chat/threads");
      expect(res.status).toBe(200);
      // No other message exists, so the thread disappears entirely once its
      // only message is hidden for this user.
      expect(res.body.threads).toHaveLength(0);
    });
  });

  describe("Reverse-cursor pagination on GET /chat/messages/:counterpartId", () => {
    it("returns the newest page first with hasMore when older messages exist", async () => {
      for (let i = 0; i < 5; i += 1) {
        seedMessage({ message: `msg-${i}` });
      }
      const res = await request(app).get(`/api/sessions/chat/messages/${DOCTOR_ID}?limit=2`);
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(2);
      expect(res.body.messages.map((m) => m.message)).toEqual(["msg-3", "msg-4"]);
      expect(res.body.hasMore).toBe(true);
      expect(res.body.nextBefore).toBe(res.body.messages[0].id);
    });

    it("fetches the next older page using the previous page's nextBefore cursor", async () => {
      for (let i = 0; i < 5; i += 1) {
        seedMessage({ message: `msg-${i}` });
      }
      const firstPage = await request(app).get(`/api/sessions/chat/messages/${DOCTOR_ID}?limit=2`);
      const cursor = firstPage.body.nextBefore;

      const secondPage = await request(app).get(
        `/api/sessions/chat/messages/${DOCTOR_ID}?limit=2&before=${cursor}`
      );
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.messages.map((m) => m.message)).toEqual(["msg-1", "msg-2"]);
      expect(secondPage.body.hasMore).toBe(true);
    });

    it("reports hasMore=false once the oldest message has been reached", async () => {
      for (let i = 0; i < 3; i += 1) {
        seedMessage({ message: `msg-${i}` });
      }
      const res = await request(app).get(`/api/sessions/chat/messages/${DOCTOR_ID}?limit=10`);
      expect(res.body.messages).toHaveLength(3);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.nextBefore).toBeNull();
    });

    it("excludes messages hidden-for-me from paginated results", async () => {
      const hidden = seedMessage({ message: "hide me" });
      seedMessage({ message: "keep me" });
      await request(app).delete(`/api/sessions/chat/messages/${hidden._id}/for-me`);

      const res = await request(app).get(`/api/sessions/chat/messages/${DOCTOR_ID}?limit=10`);
      expect(res.body.messages.map((m) => m.message)).toEqual(["keep me"]);
    });

    it("rejects an invalid pagination cursor", async () => {
      const res = await request(app).get(
        `/api/sessions/chat/messages/${DOCTOR_ID}?before=not-a-valid-id`
      );
      expect(res.status).toBe(400);
    });
  });
});
