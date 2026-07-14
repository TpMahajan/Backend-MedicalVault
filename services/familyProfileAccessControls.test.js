import { jest } from "@jest/globals";

await jest.unstable_mockModule("../models/CareRelationship.js", () => ({
  CARE_PERMISSION_KEYS: ["profileRead", "profileEdit", "medicationsView", "profileContextSwitch"],
  CareRelationship: { exists: jest.fn(async () => null) },
}));
await jest.unstable_mockModule("../models/PatientProfile.js", () => ({
  PatientProfile: { find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) },
}));

const {
  defaultFamilyProfileAccessControls,
  enforceFamilyProfileRequestPolicy,
  patchFamilyProfileAccessControls,
} = await import("./familyProfileAccessControls.js");

describe("Family Profile Access controls", () => {
  it("defaults to a fail-closed request policy", async () => {
    const controls = defaultFamilyProfileAccessControls();
    expect(controls.allowProfileAccessRequests).toBe(false);
    expect(controls.requestPolicy).toBe("nobody");
    const decision = await enforceFamilyProfileRequestPolicy({
      targetUser: { _id: "507f1f77bcf86cd799439011", familyProfileAccessControls: controls },
      requesterUserId: "507f1f77bcf86cd799439012",
    });
    expect(decision).toEqual(expect.objectContaining({ allowed: false, code: "PROFILE_ACCESS_REQUESTS_DISABLED" }));
  });

  it("retains only declared, backend-controlled default permissions", () => {
    const controls = patchFamilyProfileAccessControls(defaultFamilyProfileAccessControls(), {
      allowProfileAccessRequests: true,
      requestPolicy: "anyone_with_medical_vault_id",
      defaultRequestedPermissions: { profileRead: true, unknown: true },
    });
    expect(controls.defaultRequestedPermissions.profileRead).toBe(true);
    expect(controls.defaultRequestedPermissions.unknown).toBeUndefined();
  });
});
