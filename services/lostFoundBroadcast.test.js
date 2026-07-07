import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const userFindMock = jest.fn();
const notificationInsertManyMock = jest.fn(async () => []);
const lostFindOneAndUpdateMock = jest.fn();
const lostFindByIdAndUpdateMock = jest.fn(async () => ({}));
const sendPushMock = jest.fn(async () => ({ success: true }));

jest.unstable_mockModule("../models/User.js", () => ({
  User: { find: userFindMock },
}));
jest.unstable_mockModule("../models/Notification.js", () => ({
  Notification: { insertMany: notificationInsertManyMock },
}));
jest.unstable_mockModule("../models/LostPersonReport.js", () => ({
  LostPersonReport: {
    findOneAndUpdate: lostFindOneAndUpdateMock,
    findByIdAndUpdate: lostFindByIdAndUpdateMock,
  },
}));
jest.unstable_mockModule("../config/firebase.js", () => ({
  sendPushNotification: sendPushMock,
  initializeFirebase: () => null,
}));

const { broadcastLostPersonAlert, buildNearbyUsersQuery } = await import(
  "./lostFoundBroadcast.js"
);

// User.find(...).select(...).limit(...).lean()
const mockRecipients = (recipients) => {
  const chain = {
    select: () => chain,
    limit: () => chain,
    lean: async () => recipients,
  };
  userFindMock.mockReturnValue(chain);
};

const baseReport = () => ({
  _id: "lost-1",
  status: "open",
  broadcastStatus: "pending",
  reportedByUserId: "reporter-1",
  personName: "Asha Kumari",
  city: "Nashik",
  photoUrl: "https://cdn.example/lost/asha.jpg",
  lastSeenLocation: { type: "Point", coordinates: [73.7898, 19.9975] },
});

describe("buildNearbyUsersQuery", () => {
  it("converts radius km to meters and excludes the reporter", () => {
    const q = buildNearbyUsersQuery({
      lng: 73.79,
      lat: 19.99,
      radiusKm: 100,
      reporterId: "reporter-1",
    });
    expect(q._id).toEqual({ $ne: "reporter-1" });
    expect(q.locationSharingEnabled).toBe(true);
    expect(q.lostPersonAlertsOptOut).toEqual({ $ne: true });
    expect(q.fcmToken).toEqual({ $exists: true, $nin: [null, ""] });
    expect(q.lastKnownLocation.$near.$maxDistance).toBe(100000);
    expect(q.lastKnownLocation.$near.$geometry.coordinates).toEqual([73.79, 19.99]);
  });
});

describe("broadcastLostPersonAlert", () => {
  beforeEach(() => {
    userFindMock.mockReset();
    notificationInsertManyMock.mockClear();
    lostFindOneAndUpdateMock.mockReset();
    lostFindByIdAndUpdateMock.mockClear();
    sendPushMock.mockReset();
    sendPushMock.mockResolvedValue({ success: true });
    // Default: claim succeeds.
    lostFindOneAndUpdateMock.mockResolvedValue({ _id: "lost-1" });
  });

  it("skips reports that are not open", async () => {
    const res = await broadcastLostPersonAlert({ ...baseReport(), status: "matched" });
    expect(res).toEqual({ status: "skipped", reason: "not_open" });
    expect(lostFindOneAndUpdateMock).not.toHaveBeenCalled();
  });

  it("skips reports without valid coordinates", async () => {
    const res = await broadcastLostPersonAlert({
      ...baseReport(),
      lastSeenLocation: { coordinates: [] },
    });
    expect(res).toEqual({ status: "skipped", reason: "no_coordinates" });
    expect(lostFindByIdAndUpdateMock).toHaveBeenCalledWith(
      "lost-1",
      expect.objectContaining({ $set: expect.objectContaining({ broadcastStatus: "skipped" }) }),
    );
  });

  it("is idempotent: skips when the atomic claim is already taken", async () => {
    lostFindOneAndUpdateMock.mockResolvedValue(null); // already claimed
    const res = await broadcastLostPersonAlert(baseReport());
    expect(res).toEqual({ status: "skipped", reason: "already_broadcast" });
    expect(userFindMock).not.toHaveBeenCalled();
  });

  it("sends image push + in-app notifications to nearby recipients", async () => {
    mockRecipients([
      { _id: "u1", fcmToken: "tok1" },
      { _id: "u2", fcmToken: "tok2" },
    ]);

    const res = await broadcastLostPersonAlert(baseReport());

    expect(res.status).toBe("sent");
    expect(res.recipientCount).toBe(2);
    expect(res.pushDelivered).toBe(2);

    // Reporter excluded via query.
    const queryArg = userFindMock.mock.calls[0][0];
    expect(queryArg._id).toEqual({ $ne: "reporter-1" });

    // Push carries the image + safe data only.
    expect(sendPushMock).toHaveBeenCalledTimes(2);
    const [, notif, data] = sendPushMock.mock.calls[0];
    expect(notif.image).toBe("https://cdn.example/lost/asha.jpg");
    expect(data).toMatchObject({
      type: "lost_person_alert",
      reportId: "lost-1",
      route: "/lost-found/report/lost-1",
    });
    expect(data.reporterPhone).toBeUndefined();

    // In-app notifications created for both recipients.
    const inserted = notificationInsertManyMock.mock.calls[0][0];
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      type: "lost_person_alert",
      recipientRole: "patient",
      senderRole: "system",
    });
    expect(inserted[0].data.imageUrl).toBe("https://cdn.example/lost/asha.jpg");

    // Broadcast marked sent with recipient count.
    expect(lostFindByIdAndUpdateMock).toHaveBeenCalledWith(
      "lost-1",
      expect.objectContaining({
        $set: expect.objectContaining({
          broadcastStatus: "sent",
          broadcastRecipientCount: 2,
        }),
      }),
    );
  });

  it("marks sent with zero recipients when nobody is nearby", async () => {
    mockRecipients([]);
    const res = await broadcastLostPersonAlert(baseReport());
    expect(res).toMatchObject({ status: "sent", recipientCount: 0 });
    expect(notificationInsertManyMock).not.toHaveBeenCalled();
  });

  it("omits the image when photo is not an http(s) URL", async () => {
    mockRecipients([{ _id: "u1", fcmToken: "tok1" }]);
    await broadcastLostPersonAlert({
      ...baseReport(),
      photoUrl: "lost-found/asha.jpg", // raw key, not a URL
      notificationImageUrl: undefined,
    });
    const [, notif, data] = sendPushMock.mock.calls[0];
    expect(notif.image).toBeUndefined();
    expect(data.image).toBeUndefined();
  });
});
