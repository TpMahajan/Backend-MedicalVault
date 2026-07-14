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

const state = {
  profiles: new Map(),
  relationships: new Map(),
  idempotency: new Map(),
  sequence: 0,
  forceTransactionUnsupported: false,
  failRelationshipCreate: false,
  failProfileCleanup: false,
};

const nextId = (prefix) => `${prefix}-${++state.sequence}`;
const matches = (doc, filter = {}) => {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") continue;
    if (expected === null) {
      if (doc[key] != null) return false;
      continue;
    }
    if (expected && typeof expected === "object" && "$in" in expected) {
      if (!expected.$in.map(String).includes(String(doc[key]))) return false;
    } else if (expected && typeof expected === "object" && "$ne" in expected) {
      if (String(doc[key]) === String(expected.$ne)) return false;
    } else if (expected && typeof expected === "object" && "$gt" in expected) {
      if (!(new Date(doc[key]).getTime() > new Date(expected.$gt).getTime())) return false;
    } else if (String(doc[key]) !== String(expected)) {
      return false;
    }
  }
  if (filter.$or) {
    return filter.$or.some((entry) => matches(doc, entry));
  }
  return true;
};

const makeProfile = (payload) => {
  const doc = {
    _id: nextId("profile"),
    medicalSummary: { allergies: [], conditions: [], currentConcerns: [], lifestyleNotes: [] },
    emergencyContact: { name: "", relationship: "", phone: "" },
    ...payload,
    async save() {
      state.profiles.set(String(this._id), this);
      return this;
    },
    toObject() {
      return { ...this };
    },
  };
  state.profiles.set(String(doc._id), doc);
  return doc;
};

const makeRelationship = (payload) => {
  const doc = {
    _id: nextId("relationship"),
    expiresAt: null,
    ...payload,
    async save() {
      state.relationships.set(String(this._id), this);
      return this;
    },
  };
  state.relationships.set(String(doc._id), doc);
  return doc;
};

const patientProfileMock = {
  countDocuments: jest.fn(async (filter) => Array.from(state.profiles.values()).filter((doc) => matches(doc, filter)).length),
  create: jest.fn(async (payload) => {
    if (Array.isArray(payload)) return payload.map(makeProfile);
    return makeProfile(payload);
  }),
  findById: jest.fn(async (id) => state.profiles.get(String(id)) || null),
  findOne: jest.fn(async (filter) => Array.from(state.profiles.values()).find((doc) => matches(doc, filter)) || null),
  deleteOne: jest.fn(async (filter) => {
    if (state.failProfileCleanup) throw new Error("simulated profile cleanup failure");
    const doc = Array.from(state.profiles.values()).find((entry) => matches(entry, filter));
    if (!doc) return { deletedCount: 0 };
    state.profiles.delete(String(doc._id));
    return { deletedCount: 1 };
  }),
};

const relationshipQuery = (filter) => {
  const docs = Array.from(state.relationships.values())
    .filter((doc) => matches(doc, filter))
    .map((doc) => ({ ...doc, patientProfileId: state.profiles.get(String(doc.patientProfileId)) || doc.patientProfileId }));
  return {
    populate: async () => docs,
    sort: () => ({ populate: async () => docs }),
    then: (resolve, reject) => Promise.resolve(docs).then(resolve, reject),
  };
};

const careRelationshipMock = {
  create: jest.fn(async (payload) => {
    if (state.failRelationshipCreate) throw new Error("simulated relationship failure");
    if (Array.isArray(payload)) return payload.map(makeRelationship);
    return makeRelationship(payload);
  }),
  find: jest.fn((filter) => relationshipQuery(filter)),
  findOne: jest.fn(async (filter) => Array.from(state.relationships.values()).find((doc) => matches(doc, filter)) || null),
  findById: jest.fn(async (id) => state.relationships.get(String(id)) || null),
  updateMany: jest.fn(async (filter, update) => {
    let modifiedCount = 0;
    for (const doc of state.relationships.values()) {
      if (matches(doc, filter)) {
        Object.assign(doc, update.$set || {});
        modifiedCount += 1;
      }
    }
    return { modifiedCount };
  }),
  findOneAndUpdate: jest.fn(),
};

const idempotencyKey = (payload) => `${payload.actorUserId}:${payload.endpoint}:${payload.key}`;
const idempotencyMock = {
  create: jest.fn(async (payload) => {
    const key = idempotencyKey(payload);
    if (state.idempotency.has(key)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    const doc = {
      _id: nextId("idempotency"),
      ...payload,
      async save() {
        state.idempotency.set(key, this);
        return this;
      },
    };
    state.idempotency.set(key, doc);
    return doc;
  }),
  findOne: jest.fn(async (filter) => state.idempotency.get(`${filter.actorUserId}:${filter.endpoint}:${filter.key}`) || null),
  updateOne: jest.fn(async (filter, update) => {
    const doc = Array.from(state.idempotency.values()).find((entry) => String(entry._id) === String(filter._id));
    if (doc) Object.assign(doc, update.$set || {});
    return { modifiedCount: doc ? 1 : 0 };
  }),
};

const startSessionMock = jest.fn(async () => ({
  withTransaction: async (callback) => {
    if (state.forceTransactionUnsupported) {
      const error = new Error("Transaction numbers are only allowed on a replica set member or mongos");
      error.code = 20;
      throw error;
    }
    return callback();
  },
  endSession: jest.fn(async () => {}),
}));

const authMock = (req, res, next) => {
  const mode = String(req.headers["x-test-entitlement"] || "allowed");
  const id = String(req.headers["x-test-id"] || "owner-1");
  req.auth = { role: "patient", id };
  req.user = { _id: id, entitlementMode: mode };
  next();
};

await jest.unstable_mockModule("mongoose", () => ({
  default: { startSession: startSessionMock, isValidObjectId: () => true },
}));
await jest.unstable_mockModule("../middleware/auth.js", () => ({ auth: authMock }));
await jest.unstable_mockModule("../models/PatientProfile.js", () => ({ PatientProfile: patientProfileMock }));
await jest.unstable_mockModule("../models/CareRelationship.js", () => ({ CareRelationship: careRelationshipMock }));
await jest.unstable_mockModule("../models/FamilyCareIdempotencyKey.js", () => ({ FamilyCareIdempotencyKey: idempotencyMock }));
await jest.unstable_mockModule("../models/CareInvitation.js", () => ({ CareInvitation: {} }));
await jest.unstable_mockModule("../models/Appointment.js", () => ({ Appointment: { find: () => ({ sort: () => ({ lean: async () => [] }) }) } }));
await jest.unstable_mockModule("../models/File.js", () => ({ Document: { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) } }));
await jest.unstable_mockModule("../models/MedicationDoseEvent.js", () => ({ MedicationDoseEvent: { find: () => ({ lean: async () => [] }) } }));
await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({ writeAuditLog: jest.fn(async () => {}) }));
await jest.unstable_mockModule("../services/familyCareProfileService.js", () => ({ ensureSelfPatientProfile: jest.fn(async () => null) }));
await jest.unstable_mockModule("../services/familyCarePermissions.js", () => ({
  permissionsForRole: () => ({ profileRead: true, profileEdit: true, caregiverManagement: true, documentsView: true }),
  sanitizePermissions: (value) => value,
}));
await jest.unstable_mockModule("../services/familyCareEntitlementService.js", () => ({
  resolveFamilyCareEntitlement: async (user) => {
    const mode = user.entitlementMode;
    if (mode === "disabled") return { allowed: false, code: "FAMILY_CARE_DISABLED" };
    if (mode === "required") return { allowed: false, code: "FAMILY_CARE_ENTITLEMENT_REQUIRED" };
    if (mode === "expired") return { allowed: false, code: "FAMILY_CARE_ENTITLEMENT_EXPIRED" };
    if (mode === "suspended") return { allowed: false, code: "FAMILY_CARE_ENTITLEMENT_SUSPENDED" };
    return { allowed: true, limits: { maxManagedProfiles: 5, maxCaregiversPerProfile: 5 } };
  },
}));
await jest.unstable_mockModule("../middleware/familyCareRateLimit.js", () => ({
  familyCareInvitationLimiter: (_req, _res, next) => next(),
  familyCareUserSearchLimiter: (_req, _res, next) => next(),
}));
await jest.unstable_mockModule("../controllers/familyCareConnectionsController.js", () => ({
  searchExistingUsers: jest.fn(), listConnections: jest.fn(), listConnectionInvitations: jest.fn(),
  createConnectionInvitation: jest.fn(), acceptConnectionInvitation: jest.fn(), declineConnectionInvitation: jest.fn(),
  cancelConnectionInvitation: jest.fn(), updateConnection: jest.fn(), deleteConnection: jest.fn(),
  requestManagedProfileLink: jest.fn(), acceptManagedProfileLink: jest.fn(), declineManagedProfileLink: jest.fn(),
}));
await jest.unstable_mockModule("../controllers/familyCareMedicationController.js", () => ({
  listMedications: jest.fn(), createMedication: jest.fn(), updateMedication: jest.fn(), pauseMedication: jest.fn(),
  resumeMedication: jest.fn(), stopMedication: jest.fn(), listTodayDoses: jest.fn(), markDoseTaken: jest.fn(),
  markDoseSkipped: jest.fn(), snoozeDose: jest.fn(), correctDose: jest.fn(),
}));
await jest.unstable_mockModule("../controllers/familyCareAppointmentController.js", () => ({
  listFamilyDoctors: jest.fn(), listFamilyAppointments: jest.fn(), getFamilyAppointment: jest.fn(),
  createFamilyAppointment: jest.fn(), updateFamilyAppointment: jest.fn(), cancelFamilyAppointment: jest.fn(),
}));
await jest.unstable_mockModule("../controllers/familyCareNotificationPreferencesController.js", () => ({
  getGlobalFamilyCareNotificationPreferences: jest.fn(), updateGlobalFamilyCareNotificationPreferences: jest.fn(),
  getProfileFamilyCareNotificationPreferences: jest.fn(), updateProfileFamilyCareNotificationPreferences: jest.fn(),
}));

const { default: familyCareRouter } = await import("./familyCare.js");
const app = express();
app.use(express.json());
app.use("/api/v1/family-care", familyCareRouter);

const createPayload = (overrides = {}) => ({
  displayName: "Test dependent",
  relationship: "parent",
  dateOfBirth: "1960-05-12",
  gender: "female",
  timezone: "Asia/Kolkata",
  ...overrides,
});

const createProfile = (key = "family-care-test-key-0001", overrides = {}, userId = "owner-1") => request(app)
  .post("/api/v1/family-care/profiles")
  .set("x-test-id", userId)
  .set("Idempotency-Key", key)
  .send(createPayload(overrides));

describe("Family Care core route integration", () => {
  beforeEach(() => {
    state.profiles.clear();
    state.relationships.clear();
    state.idempotency.clear();
    state.sequence = 0;
    state.forceTransactionUnsupported = false;
    state.failRelationshipCreate = false;
    state.failProfileCleanup = false;
    jest.clearAllMocks();
  });

  afterEach(() => {
    state.forceTransactionUnsupported = false;
    state.failRelationshipCreate = false;
    state.failProfileCleanup = false;
  });

  it.each([
    ["disabled", "FAMILY_CARE_DISABLED"],
    ["required", "FAMILY_CARE_ENTITLEMENT_REQUIRED"],
    ["expired", "FAMILY_CARE_ENTITLEMENT_EXPIRED"],
    ["suspended", "FAMILY_CARE_ENTITLEMENT_SUSPENDED"],
  ])("returns a clear %s entitlement state", async (mode, code) => {
    const response = await request(app)
      .get("/api/v1/family-care/dashboard")
      .set("x-test-entitlement", mode);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe(code);
  });

  it("creates one managed profile, owner relationship, lists it, and returns controlled data", async () => {
    const created = await createProfile();
    expect(created.status).toBe(201);
    expect(created.body.data.profile).toEqual(expect.objectContaining({
      id: expect.any(String),
      displayName: "Test dependent",
      relationship: "parent",
      profileType: "managed",
      dateOfBirth: "1960-05-12",
    }));
    expect(created.body.data.profile._id).toBeUndefined();
    expect(created.body.data.profile.primaryOwnerUserId).toBeUndefined();
    expect(created.body.data.relationship).toEqual(expect.objectContaining({ role: "owner", status: "active" }));

    const listed = await request(app).get("/api/v1/family-care/profiles");
    expect(listed.status).toBe(200);
    expect(listed.body.data.profiles).toHaveLength(1);
    expect(listed.body.data.profiles[0].profile.id).toBe(created.body.data.profile.id);
  });

  it("replays the same idempotency key once and rejects a payload conflict", async () => {
    const first = await createProfile("family-care-test-key-0002");
    const replay = await createProfile("family-care-test-key-0002");
    const conflict = await createProfile("family-care-test-key-0002", { displayName: "Different dependent" });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data.profile.id).toBe(first.body.data.profile.id);
    expect(state.profiles.size).toBe(1);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("requires a valid idempotency key and returns field-level validation errors", async () => {
    const missingKey = await request(app)
      .post("/api/v1/family-care/profiles")
      .send(createPayload());
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const invalidDate = await createProfile("family-care-test-key-0006", { dateOfBirth: "2026-02-31" });
    expect(invalidDate.status).toBe(400);
    expect(invalidDate.body.error.code).toBe("VALIDATION_ERROR");
    expect(invalidDate.body.error.fields.dateOfBirth).toBeTruthy();
  });

  it("uses the hidden pending compensation path when transactions are unsupported", async () => {
    state.forceTransactionUnsupported = true;
    const created = await createProfile("family-care-test-key-0003");
    expect(created.status).toBe(201);
    const profile = state.profiles.get(created.body.data.profile.id);
    expect(profile.status).toBe("active");
    expect(state.relationships.size).toBe(1);
  });

  it("does not expose an orphan when relationship creation fails in fallback mode", async () => {
    state.forceTransactionUnsupported = true;
    state.failRelationshipCreate = true;
    const response = await createProfile("family-care-test-key-0004");
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("FAMILY_CARE_CREATE_FAILED");
    expect(state.profiles.size).toBe(0);
  });

  it("keeps a failed fallback profile non-active if compensation cleanup is unavailable", async () => {
    state.forceTransactionUnsupported = true;
    state.failRelationshipCreate = true;
    state.failProfileCleanup = true;
    const response = await createProfile("family-care-test-key-0007");
    expect(response.status).toBe(500);
    expect([...state.profiles.values()]).toHaveLength(1);
    expect([...state.profiles.values()][0].status).toBe("creation_failed");
  });

  it("supports read, edit, archive, repeat archive, and cross-user denial", async () => {
    const created = await createProfile("family-care-test-key-0005");
    const profileId = created.body.data.profile.id;
    const detail = await request(app).get(`/api/v1/family-care/profiles/${profileId}`);
    expect(detail.status).toBe(200);
    const updated = await request(app)
      .patch(`/api/v1/family-care/profiles/${profileId}`)
      .send({
        bloodGroup: "B+",
        medicalSummary: { allergies: ["pollen"], conditions: [] },
        emergencyContact: { name: "Emergency Contact", relationship: "Daughter", phone: "+91 98765 43210" },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.data.profile.bloodGroup).toBe("B+");
    expect(updated.body.data.profile.emergencyContact.phone).toBe("+91 98765 43210");

    const denied = await request(app)
      .get(`/api/v1/family-care/profiles/${profileId}`)
      .set("x-test-id", "unrelated-user");
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("PROFILE_ACCESS_DENIED");

    const archiveDenied = await request(app)
      .post(`/api/v1/family-care/profiles/${profileId}/archive`)
      .set("x-test-id", "unrelated-user");
    expect(archiveDenied.status).toBe(403);
    expect(archiveDenied.body.code).toBe("PROFILE_OWNER_REQUIRED");

    const archived = await request(app).post(`/api/v1/family-care/profiles/${profileId}/archive`);
    const repeated = await request(app).post(`/api/v1/family-care/profiles/${profileId}/archive`);
    expect(archived.status).toBe(200);
    expect(repeated.status).toBe(200);
    const listed = await request(app).get("/api/v1/family-care/profiles");
    expect(listed.body.data.profiles).toHaveLength(0);
  });
});
