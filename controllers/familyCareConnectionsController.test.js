import { jest } from "@jest/globals";

const ids = {
  requester: "507f1f77bcf86cd799439011",
  target: "507f1f77bcf86cd799439012",
  profile: "507f1f77bcf86cd799439013",
  invitation: "507f1f77bcf86cd799439014",
  relationship: "507f1f77bcf86cd799439015",
};
const state = { policy: { allowed: true, controls: { defaultRequestedPermissions: { profileRead: true, profileContextSwitch: true } } } };
const userFindOne = jest.fn();
const relationshipFindOne = jest.fn();
const relationshipFindOneAndUpdate = jest.fn();
const invitationFindOne = jest.fn();
const invitationCreate = jest.fn();

await jest.unstable_mockModule("../models/User.js", () => ({ User: { findOne: userFindOne, find: jest.fn() } }));
await jest.unstable_mockModule("../models/PatientProfile.js", () => ({ PatientProfile: { find: jest.fn(), findById: jest.fn() } }));
await jest.unstable_mockModule("../models/CareRelationship.js", () => ({
  CARE_PERMISSION_KEYS: ["profileRead", "profileEdit", "medicationsView", "profileContextSwitch", "caregiversManage", "caregiverManagement"],
  CareRelationship: { findOne: relationshipFindOne, findOneAndUpdate: relationshipFindOneAndUpdate, find: jest.fn(), findById: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
}));
await jest.unstable_mockModule("../models/CareInvitation.js", () => ({ CareInvitation: { findOne: invitationFindOne, create: invitationCreate, find: jest.fn(), updateMany: jest.fn() } }));
await jest.unstable_mockModule("../models/Appointment.js", () => ({ Appointment: { countDocuments: jest.fn(async () => 0) } }));
await jest.unstable_mockModule("../models/File.js", () => ({ Document: { countDocuments: jest.fn(async () => 0) } }));
await jest.unstable_mockModule("../models/MedicationOrder.js", () => ({ MedicationOrder: { countDocuments: jest.fn(async () => 0) } }));
await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({ writeAuditLog: jest.fn(async () => {}) }));
await jest.unstable_mockModule("../services/familyCareProfileService.js", () => ({ ensureSelfPatientProfile: jest.fn(async () => ({ _id: ids.profile, displayName: "Target", profileType: "self", timezone: "Asia/Kolkata", status: "active" })) }));
await jest.unstable_mockModule("../services/familyProfileAccessControls.js", () => ({
  enforceFamilyProfileRequestPolicy: jest.fn(async () => state.policy),
  normalizeFamilyProfileAccessControls: (value) => value,
}));

const { acceptConnectionInvitation, createConnectionInvitation } = await import("./familyCareConnectionsController.js");

const response = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((status) => { res.statusCode = status; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
};

const target = {
  _id: ids.target,
  email: "target@example.test",
  name: "Target Person",
  isActive: true,
  familyProfileAccessControls: {},
};

describe("existing-account Family Care connections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    state.policy = { allowed: true, controls: { defaultRequestedPermissions: { profileRead: true, profileContextSwitch: true } } };
    userFindOne.mockResolvedValue(target);
    relationshipFindOne.mockResolvedValue(null);
    invitationFindOne.mockResolvedValue(null);
    invitationCreate.mockImplementation(async (payload) => ({ _id: ids.invitation, createdAt: new Date(), status: "pending", ...payload }));
  });

  it("refuses a connection request when the target has disabled requests", async () => {
    state.policy = { allowed: false, code: "PROFILE_ACCESS_REQUESTS_DISABLED", controls: {} };
    const res = response();
    await createConnectionInvitation({ auth: { id: ids.requester }, body: { targetUserId: ids.target }, user: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("PROFILE_ACCESS_REQUESTS_DISABLED");
    expect(invitationCreate).not.toHaveBeenCalled();
  });

  it("creates an account-targeted pending consent request without exposing a token", async () => {
    const res = response();
    await createConnectionInvitation({
      auth: { id: ids.requester },
      user: {},
      body: {
        targetUserId: ids.target,
        relationship: "daughter",
        role: "secondaryCaregiver",
        permissions: { profileRead: true, profileContextSwitch: true, medicationsView: true },
      },
    }, res);
    expect(res.statusCode).toBe(201);
    expect(invitationCreate).toHaveBeenCalledWith(expect.objectContaining({
      kind: "connection",
      invitedUserId: ids.target,
      patientProfileId: ids.profile,
      invitedByUserId: ids.requester,
      tokenHash: expect.any(String),
      intendedPermissions: expect.objectContaining({
        profileRead: true,
        profileContextSwitch: true,
        medicationsView: false,
      }),
    }));
    expect(res.body.data.invitation.invitationToken).toBeUndefined();
  });

  it("accepts idempotently into one canonical CareRelationship", async () => {
    const invitation = {
      _id: ids.invitation,
      kind: "connection",
      invitedUserId: ids.target,
      invitedByUserId: ids.requester,
      patientProfileId: ids.profile,
      intendedRelationship: "daughter",
      intendedRole: "secondaryCaregiver",
      intendedPermissions: { profileRead: true, profileContextSwitch: true },
      status: "pending",
      expiresAt: new Date(Date.now() + 3600000),
      save: jest.fn(async function save() { return this; }),
    };
    invitationFindOne.mockResolvedValue(invitation);
    relationshipFindOneAndUpdate.mockResolvedValue({
      _id: ids.relationship,
      patientProfileId: ids.profile,
      caregiverUserId: ids.requester,
      relationship: "daughter",
      role: "secondaryCaregiver",
      permissions: { profileRead: true },
      status: "active",
    });
    const res = response();
    await acceptConnectionInvitation({ auth: { id: ids.target }, user: {} , params: { invitationId: ids.invitation } }, res);
    expect(res.statusCode).toBe(200);
    expect(invitation.status).toBe("accepted");
    expect(relationshipFindOneAndUpdate).toHaveBeenCalledWith(
      { patientProfileId: ids.profile, caregiverUserId: ids.requester },
      expect.objectContaining({ $set: expect.objectContaining({ status: "active" }) }),
      expect.objectContaining({ upsert: true }),
    );
  });
});
