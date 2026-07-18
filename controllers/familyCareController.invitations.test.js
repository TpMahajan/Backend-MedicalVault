import crypto from "crypto";
import { jest } from "@jest/globals";

const ids = {
  caregiver: "507f1f77bcf86cd799439021",
  profile: "507f1f77bcf86cd799439022",
  invitation: "507f1f77bcf86cd799439023",
  relationship: "507f1f77bcf86cd799439024",
};

const relationshipFindOne = jest.fn();
const relationshipFindOneAndUpdate = jest.fn();
const invitationFindById = jest.fn();

await jest.unstable_mockModule("../models/PatientProfile.js", () => ({ PatientProfile: { find: jest.fn(), findById: jest.fn() } }));
await jest.unstable_mockModule("../models/CareRelationship.js", () => ({
  CARE_PERMISSION_KEYS: ["profileRead", "profileEdit", "medicationsView", "profileContextSwitch", "caregiversManage", "caregiverManagement"],
  CareRelationship: { findOne: relationshipFindOne, findOneAndUpdate: relationshipFindOneAndUpdate, find: jest.fn(), findById: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
}));
await jest.unstable_mockModule("../models/CareInvitation.js", () => ({ CareInvitation: { findById: invitationFindById, find: jest.fn(), create: jest.fn(), updateMany: jest.fn() } }));
await jest.unstable_mockModule("../models/FamilyCareIdempotencyKey.js", () => ({ FamilyCareIdempotencyKey: { findOne: jest.fn(), create: jest.fn() } }));
await jest.unstable_mockModule("../models/Appointment.js", () => ({ Appointment: { find: jest.fn(async () => []), countDocuments: jest.fn(async () => 0) } }));
await jest.unstable_mockModule("../models/File.js", () => ({ Document: { find: jest.fn(async () => []), countDocuments: jest.fn(async () => 0) } }));
await jest.unstable_mockModule("../models/MedicationDoseEvent.js", () => ({ MedicationDoseEvent: { find: jest.fn(async () => []) } }));
await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({ writeAuditLog: jest.fn(async () => {}) }));
await jest.unstable_mockModule("../services/familyCareProfileService.js", () => ({ ensureSelfPatientProfile: jest.fn(async () => ({ _id: ids.profile })) }));
await jest.unstable_mockModule("../services/familyCarePermissions.js", () => ({
  permissionsForRole: jest.fn(() => ({})),
  sanitizePermissions: jest.fn((permissions) => permissions),
}));

const { acceptInvitation, declineInvitation } = await import("./familyCareController.js");

const response = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((status) => { res.statusCode = status; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
};

const TOKEN = "correct-horse-battery-staple";
const tokenHash = crypto.createHash("sha256").update(TOKEN).digest("hex");

const makeInvitation = (overrides = {}) => ({
  _id: ids.invitation,
  kind: "caregiver",
  patientProfileId: ids.profile,
  invitedByUserId: "507f1f77bcf86cd799439099",
  invitedEmail: "",
  tokenHash,
  intendedRelationship: "daughter",
  intendedRole: "secondaryCaregiver",
  intendedPermissions: { profileRead: true },
  status: "pending",
  expiresAt: new Date(Date.now() + 3600000),
  acceptedAt: null,
  revokedAt: null,
  save: jest.fn(async function save() { return this; }),
  ...overrides,
});

const baseReq = (overrides = {}) => ({
  auth: { id: ids.caregiver },
  user: { email: "caregiver@example.test" },
  params: { invitationId: ids.invitation },
  body: { token: TOKEN },
  ...overrides,
});

describe("legacy caregiver invitation accept/decline (familyCareController)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects when no token is supplied", async () => {
    const res = response();
    await acceptInvitation(baseReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("INVITATION_TOKEN_REQUIRED");
    expect(invitationFindById).not.toHaveBeenCalled();
  });

  it("returns a 404 when the invitation truly does not exist", async () => {
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const res = response();
    await acceptInvitation(baseReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe("INVITATION_NOT_FOUND");
  });

  it("accepts a pending invitation and activates the relationship exactly once", async () => {
    const invitation = makeInvitation();
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    relationshipFindOneAndUpdate.mockResolvedValue({
      _id: ids.relationship,
      patientProfileId: ids.profile,
      caregiverUserId: ids.caregiver,
      relationship: "daughter",
      role: "secondaryCaregiver",
      permissions: { profileRead: true },
      status: "active",
    });

    const res = response();
    await acceptInvitation(baseReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(invitation.status).toBe("accepted");
    expect(res.body.data.relationship.status).toBe("active");
    expect(relationshipFindOneAndUpdate).toHaveBeenCalledWith(
      { patientProfileId: ids.profile, caregiverUserId: ids.caregiver },
      expect.objectContaining({ $set: expect.objectContaining({ status: "active" }) }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it("rejects an invalid token without leaking whether the invitation exists", async () => {
    const invitation = makeInvitation();
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    const res = response();
    await acceptInvitation(baseReq({ body: { token: "wrong-token" } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INVITATION_TOKEN_INVALID");
    expect(relationshipFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("expires an invitation past its expiry instead of accepting it", async () => {
    const invitation = makeInvitation({ expiresAt: new Date(Date.now() - 1000) });
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    const res = response();
    await acceptInvitation(baseReq(), res);
    expect(res.statusCode).toBe(410);
    expect(res.body.code).toBe("INVITATION_EXPIRED");
    expect(invitation.status).toBe("expired");
  });

  it("is idempotent: re-accepting an already-accepted invitation replays success instead of 404", async () => {
    // Regression test: the original handler filtered on status !== "pending"
    // and returned a generic 404 "Invitation not found" for an
    // already-accepted invitation, which is indistinguishable from a
    // genuinely missing one and breaks double-tap / retry safety.
    const invitation = makeInvitation({ status: "accepted", acceptedAt: new Date() });
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    relationshipFindOne.mockResolvedValue({
      _id: ids.relationship,
      patientProfileId: ids.profile,
      caregiverUserId: ids.caregiver,
      relationship: "daughter",
      role: "secondaryCaregiver",
      permissions: { profileRead: true },
      status: "active",
    });

    const res = response();
    await acceptInvitation(baseReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.replayed).toBe(true);
    expect(res.body.data.relationship.status).toBe("active");
    expect(relationshipFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("recovers from a concurrent duplicate-key conflict (E11000) instead of a raw 500", async () => {
    // Regression test for the exact production bug: a stale unconditional
    // unique index on CareRelationship.migrationKey (since removed via
    // migrate-care-relationship-migration-key-index.js) made this upsert
    // throw E11000 whenever two concurrent accepts raced, and this handler
    // previously had no try/catch, so the error fell through to the
    // application's generic top-level error handler ("The request could not
    // be completed") with no actionable code for the client.
    const invitation = makeInvitation();
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    const duplicateKeyError = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    relationshipFindOneAndUpdate.mockRejectedValue(duplicateKeyError);
    relationshipFindOne.mockResolvedValue({
      _id: ids.relationship,
      patientProfileId: ids.profile,
      caregiverUserId: ids.caregiver,
      relationship: "daughter",
      role: "secondaryCaregiver",
      permissions: { profileRead: true },
      status: "active",
    });

    const res = response();
    await acceptInvitation(baseReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.replayed).toBe(true);
  });

  it("returns a conflict (not a crash) when a concurrent accept has not yet committed a relationship", async () => {
    const invitation = makeInvitation();
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    const duplicateKeyError = Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
    relationshipFindOneAndUpdate.mockRejectedValue(duplicateKeyError);
    relationshipFindOne.mockResolvedValue(null);

    const res = response();
    await acceptInvitation(baseReq(), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("CAREGIVER_ACCEPT_CONFLICT");
  });

  it("rejects acceptance when the invitation was issued to a different account", async () => {
    const invitation = makeInvitation({ invitedEmail: "someone-else@example.test" });
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    const res = response();
    await acceptInvitation(baseReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INVITATION_NOT_AUTHORIZED");
    expect(relationshipFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("declines a pending invitation", async () => {
    const invitation = makeInvitation();
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    const res = response();
    await declineInvitation(baseReq(), res);
    expect(res.statusCode).toBe(200);
    expect(invitation.status).toBe("declined");
    expect(relationshipFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("treats declining an already-declined invitation as a conflict, not a generic 404", async () => {
    const invitation = makeInvitation({ status: "declined" });
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    const res = response();
    await declineInvitation(baseReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("INVITATION_ALREADY_DECLINED");
  });

  it("rejects a decline attempt against an already-accepted invitation", async () => {
    const invitation = makeInvitation({ status: "accepted" });
    invitationFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(invitation) });
    const res = response();
    await declineInvitation(baseReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("INVITATION_ALREADY_ACCEPTED");
  });
});
