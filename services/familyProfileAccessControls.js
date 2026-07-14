import mongoose from "mongoose";
import { CareRelationship, CARE_PERMISSION_KEYS } from "../models/CareRelationship.js";
import { PatientProfile } from "../models/PatientProfile.js";

export const FAMILY_PROFILE_REQUEST_POLICIES = Object.freeze([
  "anyone_with_medical_vault_id",
  "contacts_only",
  "existing_connections_only",
  "nobody",
]);

const bool = (value, fallback) => value === undefined ? fallback : value === true;

const safePermissions = (value = {}) => Object.fromEntries(
  CARE_PERMISSION_KEYS.map((key) => [key, value?.[key] === true]),
);

export const defaultFamilyProfileAccessControls = () => ({
  allowProfileAccessRequests: false,
  requestPolicy: "nobody",
  requireApprovalForEveryRequest: true,
  defaultRequestedPermissions: safePermissions({ profileRead: true, profileContextSwitch: true }),
});

export const normalizeFamilyProfileAccessControls = (source = {}) => {
  const defaults = defaultFamilyProfileAccessControls();
  const policy = FAMILY_PROFILE_REQUEST_POLICIES.includes(source.requestPolicy)
    ? source.requestPolicy
    : defaults.requestPolicy;
  return {
    allowProfileAccessRequests: bool(source.allowProfileAccessRequests, defaults.allowProfileAccessRequests),
    requestPolicy: policy,
    requireApprovalForEveryRequest: bool(source.requireApprovalForEveryRequest, defaults.requireApprovalForEveryRequest),
    defaultRequestedPermissions: safePermissions({
      ...defaults.defaultRequestedPermissions,
      ...(source.defaultRequestedPermissions || {}),
    }),
  };
};

export const patchFamilyProfileAccessControls = (current, patch = {}) => {
  const merged = {
    ...normalizeFamilyProfileAccessControls(current),
    ...(patch.allowProfileAccessRequests === undefined ? {} : { allowProfileAccessRequests: patch.allowProfileAccessRequests }),
    ...(patch.requestPolicy === undefined ? {} : { requestPolicy: patch.requestPolicy }),
    ...(patch.requireApprovalForEveryRequest === undefined ? {} : { requireApprovalForEveryRequest: patch.requireApprovalForEveryRequest }),
    ...(patch.defaultRequestedPermissions === undefined
      ? {}
      : { defaultRequestedPermissions: patch.defaultRequestedPermissions }),
  };
  return normalizeFamilyProfileAccessControls(merged);
};

const isLegacyContact = (target, requesterId) => (target.linkedProfiles || [])
  .some((id) => String(id) === String(requesterId));

const hasExistingConnection = async ({ targetUserId, requesterUserId }) => {
  const profiles = await PatientProfile.find({ identityUserId: targetUserId, status: "active" }).select("_id").lean();
  if (!profiles.length) return false;
  return Boolean(await CareRelationship.exists({
    patientProfileId: { $in: profiles.map((profile) => profile._id) },
    caregiverUserId: new mongoose.Types.ObjectId(requesterUserId),
    status: "active",
  }));
};

export const enforceFamilyProfileRequestPolicy = async ({ targetUser, requesterUserId }) => {
  const controls = normalizeFamilyProfileAccessControls(targetUser.familyProfileAccessControls || {});
  if (!controls.allowProfileAccessRequests || controls.requestPolicy === "nobody") {
    return { allowed: false, code: "PROFILE_ACCESS_REQUESTS_DISABLED", controls };
  }
  if (controls.requestPolicy === "contacts_only" && !isLegacyContact(targetUser, requesterUserId)) {
    return { allowed: false, code: "PROFILE_ACCESS_CONTACTS_ONLY", controls };
  }
  if (controls.requestPolicy === "existing_connections_only"
    && !await hasExistingConnection({ targetUserId: targetUser._id, requesterUserId })) {
    return { allowed: false, code: "PROFILE_ACCESS_EXISTING_CONNECTIONS_ONLY", controls };
  }
  return { allowed: true, controls };
};
