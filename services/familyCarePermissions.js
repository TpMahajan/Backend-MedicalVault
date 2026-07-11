import { CARE_PERMISSION_KEYS } from "../models/CareRelationship.js";

const all = (value) => Object.fromEntries(CARE_PERMISSION_KEYS.map((key) => [key, value]));

export const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(all(true)),
  primaryCaregiver: Object.freeze({
    ...all(true),
    caregiverManagement: false,
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
