import express from "express";
import request from "supertest";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

// This suite isolates the direct-chat send/reconciliation behavior added to
// routes/sessionRoutes.js (clientMessageId idempotency). Every model and
// side-effect dependency is mocked at the module boundary, following the
// established pattern in familyCare.integration.test.js and
// nearby.integration.test.js — this repo's tests never touch a real
// MongoDB instance (none is available in this environment).

const state = {
  messages: new Map(),
  sequence: 0,
};

const nextId = () => `msg-${++state.sequence}`;

const DUPLICATE_KEY_ERROR = () => {
  const error = new Error(
    "E11000 duplicate key error collection: direct_messages index: uniq_conversation_sender_clientMessageId"
  );
  error.code = 11000;
  return error;
};

const makeDirectMessageDoc = (payload) => ({
  _id: payload._id || nextId(),
  doctorId: payload.doctorId,
  patientId: payload.patientId,
  sessionId: payload.sessionId,
  senderRole: payload.senderRole,
  senderId: payload.senderId,
  clientMessageId: payload.clientMessageId,
  recipientRole: payload.recipientRole,
  recipientId: payload.recipientId,
  message: payload.message,
  readByRecipient: payload.readByRecipient ?? false,
  metadata: payload.metadata || {},
  createdAt: new Date(),
});

const directMessageCreateMock = jest.fn(async (payload) => {
  const key = [
    String(payload.doctorId),
    String(payload.patientId),
    String(payload.senderId),
    payload.clientMessageId,
  ].join("::");

  if (state.messages.has(key)) {
    throw DUPLICATE_KEY_ERROR();
  }

  const doc = makeDirectMessageDoc(payload);
  state.messages.set(key, doc);
  return doc;
});

const directMessageFindOneMock = jest.fn(async (filter) => {
  const key = [
    String(filter.doctorId),
    String(filter.patientId),
    String(filter.senderId),
    filter.clientMessageId,
  ].join("::");
  return state.messages.get(key) || null;
});

const sessionFindOneMock = jest.fn(() => ({
  sort: () => ({
    select: () => ({
      lean: async () => ({
        _id: "session-1",
        status: "accepted",
        createdAt: new Date(),
      }),
    }),
  }),
}));

const appointmentFindOneMock = jest.fn(() => ({
  sort: () => ({
    select: () => ({
      lean: async () => null,
    }),
  }),
}));

const userFindByIdMock = jest.fn(() => ({
  select: () => ({
    lean: async () => ({
      name: "Test Patient",
      email: "patient@example.com",
      profilePicture: "https://cdn.example.com/patient-avatar.jpg",
    }),
  }),
}));

const doctorFindByIdMock = jest.fn(() => ({
  select: () => ({
    lean: async () => ({
      name: "Test Doctor",
      email: "doctor@example.com",
      profilePicture: "https://cdn.example.com/doctor-avatar.jpg",
    }),
  }),
}));

const emitNewDirectMessageMock = jest.fn();
const sendNotificationMock = jest.fn(async () => true);
const sendNotificationToDoctorMock = jest.fn(async () => true);
const notificationCreateMock = jest.fn(async (payload) => ({
  _id: `notif-${++state.sequence}`,
  ...payload,
}));
const broadcastNotificationMock = jest.fn(async () => {});

const authMock = jest.fn((req, _res, next) => {
  req.auth = req.__testAuth || { role: "patient", id: "patient-1" };
  req.user = { _id: req.auth.id };
  next();
});

await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: authMock,
}));

await jest.unstable_mockModule("../models/Session.js", () => ({
  Session: { findOne: sessionFindOneMock },
}));

await jest.unstable_mockModule("../models/User.js", () => ({
  User: { findById: userFindByIdMock },
}));

await jest.unstable_mockModule("../models/DoctorUser.js", () => ({
  DoctorUser: { findById: doctorFindByIdMock },
}));

await jest.unstable_mockModule("../models/Appointment.js", () => ({
  Appointment: { findOne: appointmentFindOneMock },
}));

await jest.unstable_mockModule("../models/DirectMessage.js", () => ({
  DirectMessage: {
    create: directMessageCreateMock,
    findOne: directMessageFindOneMock,
    find: () => ({
      sort: () => ({
        limit: () => ({
          lean: async () => [],
        }),
      }),
    }),
    updateMany: jest.fn(async () => ({})),
  },
}));

await jest.unstable_mockModule("../models/Notification.js", () => ({
  Notification: { create: notificationCreateMock },
}));

await jest.unstable_mockModule("../controllers/notificationController.js", () => ({
  broadcastNotification: broadcastNotificationMock,
}));

await jest.unstable_mockModule("../utils/notifications.js", () => ({
  sendNotification: sendNotificationMock,
  sendNotificationToDoctor: sendNotificationToDoctorMock,
}));

await jest.unstable_mockModule("../services/chatPresenceRealtime.js", () => ({
  emitNewDirectMessage: emitNewDirectMessageMock,
  emitTypingEvent: jest.fn(),
}));

await jest.unstable_mockModule("../services/sessionHistoryPersistence.js", () => ({
  persistSessionHistory: jest.fn(async () => {}),
}));

await jest.unstable_mockModule("../config/s3.js", () => ({
  BUCKET_NAME: "test-bucket",
}));

await jest.unstable_mockModule("../utils/s3Utils.js", () => ({
  generateSignedUrl: jest.fn(async () => "https://example.com/signed"),
}));

await jest.unstable_mockModule("../models/RefreshToken.js", () => ({
  RefreshToken: {},
}));

const { default: sessionRouter } = await import("./sessionRoutes.js");

const app = express();
app.use(express.json());
app.use("/api/sessions", sessionRouter);

const PATIENT_ID = "507f1f77bcf86cd799439011";
const DOCTOR_ID = "507f1f77bcf86cd799439012";

describe("POST /api/sessions/chat/send — clientMessageId idempotency", () => {
  beforeEach(() => {
    state.messages.clear();
    state.sequence = 0;
    directMessageCreateMock.mockClear();
    directMessageFindOneMock.mockClear();
    emitNewDirectMessageMock.mockClear();
    notificationCreateMock.mockClear();
    broadcastNotificationMock.mockClear();
    sendNotificationToDoctorMock.mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const withAuth = (auth) => {
    authMock.mockImplementation((req, _res, next) => {
      req.auth = auth;
      req.user = { _id: auth.id };
      next();
    });
  };

  it("creates exactly one message for a fresh clientMessageId", async () => {
    withAuth({ role: "patient", id: PATIENT_ID });

    const res = await request(app).post("/api/sessions/chat/send").send({
      counterpartId: DOCTOR_ID,
      message: "Hello doctor",
      clientMessageId: "client-msg-1",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deduped).toBe(false);
    expect(res.body.chatMessage.clientMessageId).toBe("client-msg-1");
    expect(directMessageCreateMock).toHaveBeenCalledTimes(1);
    expect(emitNewDirectMessageMock).toHaveBeenCalledTimes(1);
    expect(notificationCreateMock).toHaveBeenCalledTimes(1);
  });

  it("returns the original message on retry with the same clientMessageId, without creating a duplicate", async () => {
    withAuth({ role: "patient", id: PATIENT_ID });

    const first = await request(app).post("/api/sessions/chat/send").send({
      counterpartId: DOCTOR_ID,
      message: "Hello doctor",
      clientMessageId: "client-msg-retry",
    });
    expect(first.status).toBe(200);
    const firstMessageId = first.body.chatMessage.id;

    const retry = await request(app).post("/api/sessions/chat/send").send({
      counterpartId: DOCTOR_ID,
      message: "Hello doctor",
      clientMessageId: "client-msg-retry",
    });

    expect(retry.status).toBe(200);
    expect(retry.body.success).toBe(true);
    expect(retry.body.deduped).toBe(true);
    expect(retry.body.chatMessage.id).toBe(firstMessageId);

    // Only one row was ever actually persisted.
    expect(state.messages.size).toBe(1);
    // The retry must not re-notify/re-emit — only the original send does.
    expect(emitNewDirectMessageMock).toHaveBeenCalledTimes(1);
    expect(notificationCreateMock).toHaveBeenCalledTimes(1);
  });

  it("creates a second distinct message when the clientMessageId differs", async () => {
    withAuth({ role: "patient", id: PATIENT_ID });

    await request(app).post("/api/sessions/chat/send").send({
      counterpartId: DOCTOR_ID,
      message: "First",
      clientMessageId: "client-msg-a",
    });
    const second = await request(app).post("/api/sessions/chat/send").send({
      counterpartId: DOCTOR_ID,
      message: "Second",
      clientMessageId: "client-msg-b",
    });

    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(false);
    expect(state.messages.size).toBe(2);
  });

  it("concurrent sends with the same clientMessageId resolve to a single stored message", async () => {
    withAuth({ role: "patient", id: PATIENT_ID });

    const body = {
      counterpartId: DOCTOR_ID,
      message: "Race condition test",
      clientMessageId: "client-msg-race",
    };

    const [a, b] = await Promise.all([
      request(app).post("/api/sessions/chat/send").send(body),
      request(app).post("/api/sessions/chat/send").send(body),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(state.messages.size).toBe(1);
    expect(a.body.chatMessage.id).toBe(b.body.chatMessage.id);
  });

  it("generates a server-side clientMessageId fallback when the client omits it (legacy caller)", async () => {
    withAuth({ role: "patient", id: PATIENT_ID });

    const res = await request(app).post("/api/sessions/chat/send").send({
      counterpartId: DOCTOR_ID,
      message: "No client id supplied",
    });

    expect(res.status).toBe(200);
    expect(res.body.chatMessage.clientMessageId).toMatch(/^server_/);
  });

  it("resolves the sender's avatar and forwards it as the push notification image (WhatsApp-style)", async () => {
    withAuth({ role: "patient", id: PATIENT_ID });

    await request(app).post("/api/sessions/chat/send").send({
      counterpartId: DOCTOR_ID,
      message: "Hello doctor",
      clientMessageId: "client-msg-avatar",
    });

    expect(sendNotificationToDoctorMock).toHaveBeenCalledTimes(1);
    const [, , , payload, options] = sendNotificationToDoctorMock.mock.calls[0];
    expect(payload.senderAvatar).toBe("https://cdn.example.com/patient-avatar.jpg");
    expect(options).toEqual({ image: "https://cdn.example.com/patient-avatar.jpg" });
  });

  it("resolves the doctor's avatar when the doctor is the sender", async () => {
    withAuth({ role: "doctor", id: DOCTOR_ID });

    await request(app).post("/api/sessions/chat/send").send({
      counterpartId: PATIENT_ID,
      message: "Hello patient",
      clientMessageId: "client-msg-avatar-doctor",
    });

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [, , , payload, options] = sendNotificationMock.mock.calls[0];
    expect(payload.senderAvatar).toBe("https://cdn.example.com/doctor-avatar.jpg");
    expect(options).toEqual({ image: "https://cdn.example.com/doctor-avatar.jpg" });
  });
});
