import { jest } from "@jest/globals";

const notificationCreate = jest.fn();
const sendPushNotification = jest.fn();
const broadcastNotification = jest.fn();

await jest.unstable_mockModule("../models/Notification.js", () => ({
  Notification: { create: notificationCreate },
}));
await jest.unstable_mockModule("../models/User.js", () => ({
  User: { find: jest.fn() },
}));
await jest.unstable_mockModule("../models/CareRelationship.js", () => ({
  CareRelationship: { find: jest.fn() },
}));
await jest.unstable_mockModule("../models/MedicationOrder.js", () => ({
  MedicationOrder: { find: jest.fn() },
}));
await jest.unstable_mockModule("../models/MedicationSchedule.js", () => ({
  MedicationSchedule: { find: jest.fn() },
}));
await jest.unstable_mockModule("../models/MedicationDoseEvent.js", () => ({
  MedicationDoseEvent: { find: jest.fn(), findOneAndUpdate: jest.fn(), updateMany: jest.fn() },
}));
await jest.unstable_mockModule("../config/firebase.js", () => ({
  sendPushNotification,
}));
await jest.unstable_mockModule("../controllers/notificationController.js", () => ({
  broadcastNotification,
}));
await jest.unstable_mockModule("./medicationScheduleService.js", () => ({
  generateRollingDoseEvents: jest.fn(),
  localDateTimeParts: jest.fn(() => ({ hour: 12, minute: 0 })),
}));

const {
  defaultFamilyCareNotificationPreferences,
  deliverFamilyCareNotification,
  normalizeFamilyCareNotificationPreferences,
} = await import("./familyCareNotificationService.js");

describe("Family Care notification delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendPushNotification.mockResolvedValue({ success: true, messageId: "fcm-1" });
    notificationCreate.mockImplementation(async (payload) => ({
      ...payload,
      save: jest.fn(async function save() { return this; }),
    }));
    broadcastNotification.mockResolvedValue(undefined);
  });

  it("retains every Family Care preference and safe quiet-hours defaults", () => {
    const defaults = defaultFamilyCareNotificationPreferences();
    expect(defaults).toEqual(expect.objectContaining({
      medicineDue: true,
      repeatReminder: true,
      medicineMissed: true,
      caregiverMissedDoseAlert: true,
      takenConfirmation: false,
      skippedConfirmation: false,
      refillReminder: true,
      lowStockReminder: true,
    }));
    expect(normalizeFamilyCareNotificationPreferences({
      enabled: false,
      quietHours: { enabled: true, start: "21:30", end: "06:15", timezone: "Asia/Kolkata" },
    })).toEqual(expect.objectContaining({
      enabled: false,
      quietHours: expect.objectContaining({ enabled: true, start: "21:30", end: "06:15" }),
    }));
  });

  it("writes one durable in-app record and an FCM payload with the exact profile/order/dose context", async () => {
    await deliverFamilyCareNotification({
      recipient: { _id: "user-1", fcmToken: "token-1" },
      patientProfileId: "profile-1",
      doseEvent: { _id: "dose-1" },
      medicationOrder: { _id: "order-1" },
      kind: "dose_due",
      title: "Medicine due",
      body: "Test medicine is due.",
    });

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      type: "family_care_medication",
      recipientId: "user-1",
      patientProfileId: "profile-1",
      data: expect.objectContaining({
        module: "family_care",
        patientProfileId: "profile-1",
        medicationOrderId: "order-1",
        doseEventId: "dose-1",
        notificationActionId: "family-dose-dose-1-dose_due",
      }),
    }));
    expect(sendPushNotification).toHaveBeenCalledWith(
      "token-1",
      { title: "Medicine due", body: "Test medicine is due." },
      expect.objectContaining({ doseEventId: "dose-1" }),
    );
    expect(broadcastNotification).toHaveBeenCalledTimes(1);
  });
});
