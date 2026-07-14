import { CARE_PERMISSION_KEYS } from "../models/CareRelationship.js";

const all = (value) => Object.fromEntries(CARE_PERMISSION_KEYS.map((key) => [key, value]));

export const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(all(true)),
  primaryCaregiver: Object.freeze({
    ...all(true),
    caregiverManagement: false,
    caregiversManage: false,
  }),
  secondaryCaregiver: Object.freeze({
    ...all(false),
    profileRead: true,
    documentsView: true,
    documentsUpload: true,
    medicationsView: true,
    medicationsManage: true,
    dosesConfirm: true,
    appointmentsView: true,
    appointmentsManage: true,
    timelineView: true,
    emergencyView: true,
    vaccinationView: true,
    insuranceView: true,
    insightsView: true,
    profileContextSwitch: true,
  }),
  viewer: Object.freeze({
    ...all(false),
    profileRead: true,
    documentsView: true,
    medicationsView: true,
    appointmentsView: true,
    timelineView: true,
    vaccinationView: true,
    insuranceView: true,
    insightsView: true,
    profileContextSwitch: true,
  }),
  emergencyContact: Object.freeze({
    ...all(false),
    profileRead: true,
    emergencyView: true,
  }),
});

export const sanitizePermissions = (input = {}, role = "viewer") => {
  const allowed = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer;
  return Object.fromEntries(
    CARE_PERMISSION_KEYS.map((key) => [key, allowed[key] === true && input[key] === true]),
  );
};

export const permissionsForRole = (role) => ({ ...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer) });

// Permissions are always the intersection of the role ceiling, the requested
// set, and (when supplied) the actor's currently granted permissions. This
// prevents a caregiver from delegating access they do not possess.
export const restrictPermissionsToActor = (input = {}, role = "viewer", actorPermissions = null) => {
  const rolePermissions = sanitizePermissions(input, role);
  if (!actorPermissions) return rolePermissions;
  return Object.fromEntries(
    CARE_PERMISSION_KEYS.map((key) => [
      key,
      rolePermissions[key] === true && actorPermissions[key] === true,
    ]),
  );
};
