import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

// Verifies the stale-FCM-token auto-clear behavior added to
// utils/notifications.js: a push failure caused by a dead/unregistered
// token must clear User.fcmToken / DoctorUser.fcmToken so it doesn't
// silently fail forever, while a transient failure (network, quota) must
// leave the token untouched.

const sendPushNotificationMock = jest.fn();
const initializeFirebaseMock = jest.fn(() => true);

await jest.unstable_mockModule("../config/firebase.js", () => ({
  sendPushNotification: sendPushNotificationMock,
  initializeFirebase: initializeFirebaseMock,
}));

const userUpdateOneMock = jest.fn(async () => ({ modifiedCount: 1 }));
const userFindByIdMock = jest.fn();
await jest.unstable_mockModule("../models/User.js", () => ({
  User: {
    modelName: "User",
    findById: userFindByIdMock,
    updateOne: userUpdateOneMock,
  },
}));

const doctorUpdateOneMock = jest.fn(async () => ({ modifiedCount: 1 }));
const doctorFindByIdMock = jest.fn();
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({
  DoctorUser: {
    modelName: "DoctorUser",
    findById: doctorFindByIdMock,
    updateOne: doctorUpdateOneMock,
  },
}));

const { sendNotification, sendNotificationToDoctor } = await import("./notifications.js");

describe("sendNotification — stale FCM token handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    userFindByIdMock.mockResolvedValue({
      _id: "patient-1",
      email: "patient@example.com",
      fcmToken: "old-token",
    });
    doctorFindByIdMock.mockResolvedValue({
      _id: "doctor-1",
      email: "doctor@example.com",
      fcmToken: "old-doctor-token",
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("clears the token when FCM reports it is no longer registered", async () => {
    sendPushNotificationMock.mockResolvedValue({
      success: false,
      error: "Requested entity was not found.",
      code: "messaging/registration-token-not-registered",
    });

    const result = await sendNotification("patient-1", "Title", "Body", { type: "DIRECT_MESSAGE" });

    expect(result).toBe(false);
    expect(userUpdateOneMock).toHaveBeenCalledWith(
      { _id: "patient-1", fcmToken: "old-token" },
      { $set: { fcmToken: null } }
    );
  });

  it("clears the doctor's token on an invalid-registration-token error", async () => {
    sendPushNotificationMock.mockResolvedValue({
      success: false,
      error: "The registration token is not valid",
      code: "messaging/invalid-registration-token",
    });

    const result = await sendNotificationToDoctor("doctor-1", "Title", "Body", { type: "DIRECT_MESSAGE" });

    expect(result).toBe(false);
    expect(doctorUpdateOneMock).toHaveBeenCalledWith(
      { _id: "doctor-1", fcmToken: "old-doctor-token" },
      { $set: { fcmToken: null } }
    );
  });

  it("does NOT clear the token on a transient failure (e.g. quota/network)", async () => {
    sendPushNotificationMock.mockResolvedValue({
      success: false,
      error: "Internal error encountered",
      code: "messaging/internal-error",
    });

    const result = await sendNotification("patient-1", "Title", "Body", { type: "DIRECT_MESSAGE" });

    expect(result).toBe(false);
    expect(userUpdateOneMock).not.toHaveBeenCalled();
  });

  it("returns true and does not touch the token on a successful send", async () => {
    sendPushNotificationMock.mockResolvedValue({ success: true, messageId: "abc123" });

    const result = await sendNotification("patient-1", "Title", "Body", { type: "DIRECT_MESSAGE" });

    expect(result).toBe(true);
    expect(userUpdateOneMock).not.toHaveBeenCalled();
  });

  it("returns false without attempting a push when the recipient has no fcmToken", async () => {
    userFindByIdMock.mockResolvedValue({ _id: "patient-2", email: "p2@example.com", fcmToken: null });

    const result = await sendNotification("patient-2", "Title", "Body", { type: "DIRECT_MESSAGE" });

    expect(result).toBe(false);
    expect(sendPushNotificationMock).not.toHaveBeenCalled();
  });
});
