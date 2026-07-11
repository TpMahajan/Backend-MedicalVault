import { CARE_PERMISSION_KEYS } from "../models/CareRelationship.js";
import { permissionsForRole, sanitizePermissions } from "./familyCarePermissions.js";

describe("Family Care permission matrix", () => {
  it("gives owners every defined permission", () => {
    const permissions = permissionsForRole("owner");
    expect(Object.keys(permissions)).toEqual(expect.arrayContaining(CARE_PERMISSION_KEYS));
    expect(CARE_PERMISSION_KEYS.every((key) => permissions[key] === true)).toBe(true);
  });

  it("never lets a viewer elevate supplied mutation permissions", () => {
    const permissions = sanitizePermissions({ profileRead: true, profileEdit: true, documentsDelete: true, dosesConfirm: true }, "viewer");
    expect(permissions.profileRead).toBe(true);
    expect(permissions.profileEdit).toBe(false);
    expect(permissions.documentsDelete).toBe(false);
    expect(permissions.dosesConfirm).toBe(false);
  });

  it("keeps emergency contacts out of documents", () => {
    const permissions = permissionsForRole("emergencyContact");
    expect(permissions.emergencyView).toBe(true);
    expect(permissions.documentsView).toBe(false);
    expect(permissions.medicationsView).toBe(false);
  });
});
