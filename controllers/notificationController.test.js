import { jest } from "@jest/globals";

const ids = {
  userA: "507f1f77bcf86cd799439031",
  userB: "507f1f77bcf86cd799439032",
};

const notificationFind = jest.fn();
const notificationCountDocuments = jest.fn();
const notificationDeleteMany = jest.fn();
const writeAuditLogMock = jest.fn(async () => {});
const sendPushNotificationMock = jest.fn();

// Notification.find() in the real controller is chained
// (.sort().limit().skip().select()) and ultimately awaited. Model a minimal
// thenable query-builder so tests can control the resolved rows without
// reimplementing Mongoose's chainable API.
const makeQuery = (rows) => {
  const query = {
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    skip: jest.fn(() => query),
    select: jest.fn(() => query),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
};

await jest.unstable_mockModule("../config/firebase.js", () => ({ sendPushNotification: sendPushNotificationMock }));
await jest.unstable_mockModule("../models/User.js", () => ({ User: { findById: jest.fn(), findByIdAndUpdate: jest.fn(), find: jest.fn() } }));
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({ DoctorUser: { findByIdAndUpdate: jest.fn() } }));
await jest.unstable_mockModule("../models/DeviceToken.js", () => ({ DeviceToken: { findOneAndUpdate: jest.fn() } }));
await jest.unstable_mockModule("../services/notificationDeliveryService.js", () => ({ deliverNotifications: jest.fn() }));
await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({ writeAuditLog: writeAuditLogMock }));
await jest.unstable_mockModule("../models/Notification.js", () => ({
  Notification: {
    find: notificationFind,
    countDocuments: notificationCountDocuments,
    deleteMany: notificationDeleteMany,
    findOneAndUpdate: jest.fn(),
    findOneAndDelete: jest.fn(),
  },
}));

const { getNotifications, deleteAllNotifications } = await import("./notificationController.js");

const response = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((status) => { res.statusCode = status; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
};

const baseReq = (overrides = {}) => ({
  auth: { id: ids.userA, role: "patient" },
  query: {},
  ...overrides,
});

describe("notificationController scope isolation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    notificationFind.mockReturnValue(makeQuery([]));
    notificationCountDocuments.mockResolvedValue(0);
    notificationDeleteMany.mockResolvedValue({ deletedCount: 0 });
  });

  it("scopes GET /api/notifications to recipientId only, never recipientRole", async () => {
    // Regression test: buildNotificationScopeFilter previously used
    // { $or: [{ recipientId }, { recipientRole }] }, which let any patient
    // see every other patient's notifications because the role clause alone
    // matches everyone sharing that role. The query passed to
    // Notification.find must contain only recipientId.
    const res = response();
    await getNotifications(baseReq(), res);
    expect(notificationFind).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: ids.userA })
    );
    const [calledQuery] = notificationFind.mock.calls[0];
    expect(calledQuery).not.toHaveProperty("$or");
    expect(calledQuery).not.toHaveProperty("recipientRole");
  });

  it("scopes DELETE /api/notifications (Clear All) to recipientId only", async () => {
    const res = response();
    await deleteAllNotifications(baseReq(), res);
    expect(notificationDeleteMany).toHaveBeenCalledWith({ recipientId: ids.userA });
  });

  it("never lets one user's Clear All delete another user's notifications", async () => {
    const res = response();
    await deleteAllNotifications(baseReq({ auth: { id: ids.userB, role: "patient" } }), res);
    const [calledFilter] = notificationDeleteMany.mock.calls[0];
    expect(calledFilter.recipientId).toBe(ids.userB);
    expect(calledFilter.recipientId).not.toBe(ids.userA);
  });
});

describe("notificationController cursor pagination", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    notificationCountDocuments.mockResolvedValue(0);
  });

  const makeNotification = (id, createdAt) => ({
    _id: id,
    title: "t",
    body: "b",
    createdAt,
    read: false,
  });

  it("defaults to a page size of 20 and sorts by createdAt desc, _id desc", async () => {
    const query = makeQuery([]);
    notificationFind.mockReturnValue(query);
    const res = response();
    await getNotifications(baseReq(), res);
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(query.limit).toHaveBeenCalledWith(21); // limit + 1 lookahead row
  });

  it("clamps an oversized limit to the maximum of 50", async () => {
    const query = makeQuery([]);
    notificationFind.mockReturnValue(query);
    const res = response();
    await getNotifications(baseReq({ query: { limit: "500" } }), res);
    expect(query.limit).toHaveBeenCalledWith(51);
  });

  it("returns hasMore=false and no nextCursor when fewer rows than the limit exist", async () => {
    const rows = [makeNotification("n1", new Date("2026-07-17T10:00:00.000Z"))];
    notificationFind.mockReturnValue(makeQuery(rows));
    const res = response();
    await getNotifications(baseReq({ query: { limit: "20" } }), res);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.items).toHaveLength(1);
  });

  it("returns hasMore=true and a usable nextCursor when a lookahead row exists", async () => {
    const rows = [
      makeNotification("n1", new Date("2026-07-17T10:02:00.000Z")),
      makeNotification("n2", new Date("2026-07-17T10:01:00.000Z")),
      makeNotification("n3", new Date("2026-07-17T10:00:00.000Z")), // lookahead row beyond limit=2
    ];
    notificationFind.mockReturnValue(makeQuery(rows));
    const res = response();
    await getNotifications(baseReq({ query: { limit: "2" } }), res);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items.map((n) => n._id)).toEqual(["n1", "n2"]);
    expect(typeof res.body.data.nextCursor).toBe("string");
  });

  it("advances strictly past the cursor position using the compound (createdAt, _id) comparison", async () => {
    notificationFind.mockReturnValue(makeQuery([]));
    const cursorCreatedAt = new Date("2026-07-17T10:00:00.000Z");
    const cursorNotificationId = "507f1f77bcf86cd799439999";
    const cursor = Buffer.from(
      JSON.stringify({ t: cursorCreatedAt.toISOString(), id: cursorNotificationId }),
      "utf8"
    ).toString("base64url");

    const res = response();
    await getNotifications(baseReq({ query: { cursor, limit: "20" } }), res);

    expect(notificationFind).toHaveBeenCalledTimes(1);
    const [calledQuery] = notificationFind.mock.calls[0];
    expect(calledQuery.$or).toEqual([
      { createdAt: { $lt: cursorCreatedAt } },
      { createdAt: cursorCreatedAt, _id: { $lt: cursorNotificationId } },
    ]);
  });

  it("fails safe to an empty page for a malformed cursor instead of silently restarting from the top", async () => {
    // Restarting from the top on a bad cursor would look like duplicate
    // notifications reappearing mid-scroll to the client.
    const res = response();
    await getNotifications(baseReq({ query: { cursor: "not-a-real-cursor" } }), res);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.hasMore).toBe(false);
    expect(notificationFind).not.toHaveBeenCalled();
  });

  it("still supports legacy page/limit clients without a cursor", async () => {
    const rows = [makeNotification("n1", new Date())];
    notificationCountDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const query = makeQuery(rows);
    notificationFind.mockReturnValue(query);
    const res = response();
    await getNotifications(baseReq({ query: { page: "1", limit: "20" } }), res);
    expect(query.skip).toHaveBeenCalledWith(0);
    expect(res.body.data.pagination).toEqual(expect.objectContaining({ current: 1, total: 1 }));
    expect(res.body.data.items).toHaveLength(1);
  });
});

describe("notificationController Clear All", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the number of deleted records and resets unreadCount", async () => {
    notificationDeleteMany.mockResolvedValue({ deletedCount: 7 });
    const res = response();
    await deleteAllNotifications(baseReq(), res);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deletedCount).toBe(7);
    expect(res.body.data.unreadCount).toBe(0);
  });

  it("is idempotent: clearing an already-empty inbox succeeds with deletedCount 0", async () => {
    notificationDeleteMany.mockResolvedValue({ deletedCount: 0 });
    const res = response();
    await deleteAllNotifications(baseReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deletedCount).toBe(0);
  });

  it("writes an audit log entry without any notification content", async () => {
    notificationDeleteMany.mockResolvedValue({ deletedCount: 3 });
    const res = response();
    await deleteAllNotifications(baseReq(), res);
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notifications_cleared_all",
        resourceType: "Notification",
        metadata: { deletedCount: 3 },
      })
    );
    const [[call]] = writeAuditLogMock.mock.calls;
    expect(JSON.stringify(call)).not.toMatch(/title|body/);
  });
});
