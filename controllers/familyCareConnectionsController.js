import crypto from "crypto";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { PatientProfile } from "../models/PatientProfile.js";
import { CareRelationship } from "../models/CareRelationship.js";
import { CareInvitation } from "../models/CareInvitation.js";
import { Appointment } from "../models/Appointment.js";
import { Document } from "../models/File.js";
import { MedicationOrder } from "../models/MedicationOrder.js";
import { writeAuditLog } from "../middleware/auditLogger.js";
import { ensureSelfPatientProfile } from "../services/familyCareProfileService.js";
import {
  enforceFamilyProfileRequestPolicy,
  normalizeFamilyProfileAccessControls,
} from "../services/familyProfileAccessControls.js";
import {
  permissionsForRole,
  restrictPermissionsToActor,
  sanitizePermissions,
} from "../services/familyCarePermissions.js";

const ROLES = new Set(["primaryCaregiver", "secondaryCaregiver", "viewer", "emergencyContact"]);
const asText = (value, max = 240) => String(value ?? "").trim().slice(0, max);
const asId = (value) => String(value || "").trim();
const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const safeDate = (hours) => new Date(Date.now() + Math.max(1, Math.min(Number(hours) || 72, 168)) * 60 * 60 * 1000);
const objectId = (value) => mongoose.isValidObjectId(value) ? value : null;

const mask = (value, visible = 2) => {
  const text = asText(value);
  if (!text) return "";
  if (text.length <= visible) return "•".repeat(text.length);
  return `${text.slice(0, visible)}${"•".repeat(Math.max(2, text.length - visible))}`;
};

const userSearchView = (user) => ({
  id: String(user._id),
  displayName: mask(user.name, 1),
  maskedEmail: user.email ? `${user.email.slice(0, 1)}•••@${user.email.split("@")[1] || "•••"}` : "",
  maskedPhone: user.mobile ? mask(user.mobile.replace(/\s/g, ""), 3) : "",
});

const profileView = (profile) => ({
  id: String(profile._id),
  displayName: asText(profile.displayName, 120),
  profileType: profile.profileType,
  timezone: profile.timezone || "Asia/Kolkata",
  status: profile.status,
});

const relationshipView = (relationship, profile = null, user = null) => ({
  id: String(relationship._id),
  patientProfileId: String(relationship.patientProfileId?._id || relationship.patientProfileId),
  relationship: relationship.relationship,
  role: relationship.role,
  permissions: relationship.permissions?.toObject?.() || relationship.permissions || {},
  status: relationship.status,
  profile: profile || (relationship.patientProfileId?.displayName ? profileView(relationship.patientProfileId) : null),
  connectedUser: user ? { id: String(user._id), displayName: asText(user.name, 120), profilePicture: user.profilePicture || null } : null,
  acceptedAt: relationship.acceptedAt || null,
  revokedAt: relationship.revokedAt || null,
});

const invitationView = (invitation) => ({
  id: String(invitation._id),
  kind: invitation.kind || "caregiver",
  status: invitation.status,
  intendedRelationship: invitation.intendedRelationship,
  intendedRole: invitation.intendedRole,
  intendedPermissions: invitation.intendedPermissions?.toObject?.() || invitation.intendedPermissions || {},
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
  profile: invitation.patientProfileId?.displayName ? profileView(invitation.patientProfileId) : null,
  requester: invitation.invitedByUserId?.name
    ? { id: String(invitation.invitedByUserId._id), displayName: asText(invitation.invitedByUserId.name, 120) }
    : null,
});

const roleForRequest = (value) => ROLES.has(asText(value, 40)) ? asText(value, 40) : "secondaryCaregiver";

const relationshipForActor = async ({ patientProfileId, actorUserId }) => CareRelationship.findOne({
  patientProfileId,
  caregiverUserId: actorUserId,
  status: "active",
});

const actorCanManageConnection = async ({ relationship, actorUserId }) => {
  if (String(relationship.caregiverUserId) === String(actorUserId)) return true;
  const actorRelationship = await relationshipForActor({
    patientProfileId: relationship.patientProfileId,
    actorUserId,
  });
  return actorRelationship?.role === "owner"
    || actorRelationship?.permissions?.caregiverManagement === true
    || actorRelationship?.permissions?.caregiversManage === true;
};

export const searchExistingUsers = async (req, res) => {
  const query = asText(req.query.q || req.query.query || req.query.medicalVaultId, 254);
  const normalizedEmail = query.toLowerCase();
  const normalizedPhone = query.replace(/[\s()\-]/g, "");
  const clauses = [];
  if (mongoose.isValidObjectId(query)) clauses.push({ _id: query });
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) clauses.push({ email: normalizedEmail });
  if (/^\+?\d{8,20}$/.test(normalizedPhone)) clauses.push({ mobile: { $in: [query, normalizedPhone] } });
  if (!clauses.length) {
    return res.status(400).json({ success: false, code: "EXACT_PROFILE_SEARCH_REQUIRED", message: "Enter a complete Medical Vault ID, registered email, or phone number." });
  }
  const users = await User.find({ _id: { $ne: req.auth.id }, isActive: true, $or: clauses })
    .select("name email mobile profilePicture")
    .limit(3)
    .lean();
  return res.json({ success: true, data: { results: users.map(userSearchView) } });
};

export const createConnectionInvitation = async (req, res) => {
  const targetUserId = asId(req.body?.targetUserId);
  if (!objectId(targetUserId)) return res.status(400).json({ success: false, code: "INVALID_TARGET_USER", message: "Choose a valid Medical Vault account." });
  if (targetUserId === String(req.auth.id)) return res.status(400).json({ success: false, code: "SELF_CONNECTION_FORBIDDEN", message: "You cannot request access to your own profile." });
  const target = await User.findOne({ _id: targetUserId, isActive: true });
  if (!target) return res.status(404).json({ success: false, code: "USER_NOT_FOUND", message: "Medical Vault account not found." });
  const policy = await enforceFamilyProfileRequestPolicy({ targetUser: target, requesterUserId: req.auth.id });
  if (!policy.allowed) {
    return res.status(403).json({ success: false, code: policy.code, message: "This account is not accepting profile access requests." });
  }
  const targetProfile = await ensureSelfPatientProfile(target);
  const active = await CareRelationship.findOne({ patientProfileId: targetProfile._id, caregiverUserId: req.auth.id, status: "active" });
  if (active) return res.status(409).json({ success: false, code: "CONNECTION_ALREADY_ACTIVE", message: "This Family Care connection is already active." });
  const existing = await CareInvitation.findOne({
    kind: "connection",
    patientProfileId: targetProfile._id,
    invitedByUserId: req.auth.id,
    invitedUserId: target._id,
    status: "pending",
    expiresAt: { $gt: new Date() },
  });
  if (existing) return res.status(200).json({ success: true, data: { invitation: invitationView(existing), replayed: true } });
  const role = roleForRequest(req.body?.role);
  const requested = req.body?.permissions || policy.controls.defaultRequestedPermissions;
  const invitation = await CareInvitation.create({
    kind: "connection",
    patientProfileId: targetProfile._id,
    invitedByUserId: req.auth.id,
    invitedUserId: target._id,
    invitedEmail: target.email,
    intendedRelationship: asText(req.body?.relationship, 60) || "family",
    intendedRole: role,
    // The target's persisted defaults are the share ceiling. A requester can
    // ask for a smaller subset, never a capability the target did not allow.
    intendedPermissions: restrictPermissionsToActor(
      requested,
      role,
      policy.controls.defaultRequestedPermissions,
    ),
    // Account-targeted consent is authenticated; preserve the legacy schema's
    // token constraint without exposing a bearer token to clients.
    tokenHash: tokenHash(crypto.randomBytes(32).toString("base64url")),
    expiresAt: safeDate(req.body?.expiresInHours),
  });
  await writeAuditLog({ req, action: "family_connection_requested", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: targetProfile._id });
  return res.status(201).json({ success: true, data: { invitation: invitationView(invitation) } });
};

export const listConnectionInvitations = async (req, res) => {
  const now = new Date();
  await CareInvitation.updateMany({ status: "pending", expiresAt: { $lte: now } }, { $set: { status: "expired" } });
  const invitations = await CareInvitation.find({
    $or: [{ invitedUserId: req.auth.id }, { invitedByUserId: req.auth.id }, { invitedEmail: String(req.user.email || "").toLowerCase() }],
  })
    .populate("patientProfileId", "displayName profileType timezone status")
    .populate("invitedByUserId", "name profilePicture")
    .sort({ createdAt: -1 })
    .limit(100);
  const visible = invitations.filter((item) => ["connection", "profile_link", "caregiver"].includes(item.kind || "caregiver"));
  return res.json({
    success: true,
    data: {
      incoming: visible.filter((item) => String(item.invitedUserId || "") === String(req.auth.id) || (!item.invitedUserId && item.invitedEmail === String(req.user.email || "").toLowerCase())).map(invitationView),
      outgoing: visible.filter((item) => String(item.invitedByUserId?._id || item.invitedByUserId) === String(req.auth.id)).map(invitationView),
    },
  });
};

export const acceptConnectionInvitation = async (req, res) => {
  const invitation = await CareInvitation.findOne({ _id: req.params.invitationId, kind: "connection" });
  if (!invitation || String(invitation.invitedUserId) !== String(req.auth.id)) return res.status(404).json({ success: false, code: "INVITATION_NOT_FOUND", message: "Connection request not found." });
  if (invitation.status === "accepted") {
    const relationship = await CareRelationship.findOne({ patientProfileId: invitation.patientProfileId, caregiverUserId: invitation.invitedByUserId });
    return res.json({ success: true, data: { connection: relationship ? relationshipView(relationship) : null, replayed: true } });
  }
  if (invitation.status !== "pending") return res.status(409).json({ success: false, code: "INVITATION_NOT_PENDING", message: "This request can no longer be accepted." });
  if (invitation.expiresAt <= new Date()) {
    invitation.status = "expired";
    await invitation.save();
    return res.status(410).json({ success: false, code: "INVITATION_EXPIRED", message: "This request has expired." });
  }
  const relationship = await CareRelationship.findOneAndUpdate(
    { patientProfileId: invitation.patientProfileId, caregiverUserId: invitation.invitedByUserId },
    { $set: { relationship: invitation.intendedRelationship, role: invitation.intendedRole, permissions: sanitizePermissions(invitation.intendedPermissions?.toObject?.() || invitation.intendedPermissions, invitation.intendedRole), status: "active", invitationId: invitation._id, invitedBy: invitation.invitedByUserId, acceptedAt: new Date(), revokedAt: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  invitation.status = "accepted";
  invitation.acceptedAt = new Date();
  await invitation.save();
  await writeAuditLog({ req, action: "family_connection_accepted", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: invitation.patientProfileId });
  return res.json({ success: true, data: { connection: relationshipView(relationship) } });
};

export const declineConnectionInvitation = async (req, res) => {
  const invitation = await CareInvitation.findOne({ _id: req.params.invitationId, kind: "connection", invitedUserId: req.auth.id, status: "pending" });
  if (!invitation) return res.status(404).json({ success: false, code: "INVITATION_NOT_FOUND", message: "Connection request not found." });
  invitation.status = "declined";
  await invitation.save();
  await writeAuditLog({ req, action: "family_connection_declined", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: invitation.patientProfileId });
  return res.json({ success: true, message: "Connection request declined" });
};

export const cancelConnectionInvitation = async (req, res) => {
  const invitation = await CareInvitation.findOne({ _id: req.params.invitationId, invitedByUserId: req.auth.id, status: "pending", kind: { $in: ["connection", "profile_link"] } });
  if (!invitation) return res.status(404).json({ success: false, code: "INVITATION_NOT_FOUND", message: "Pending request not found." });
  invitation.status = "cancelled";
  await invitation.save();
  await writeAuditLog({ req, action: "family_connection_cancelled", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: invitation.patientProfileId });
  return res.json({ success: true, message: "Connection request cancelled" });
};

export const listConnections = async (req, res) => {
  await ensureSelfPatientProfile(req.user);
  const outgoing = await CareRelationship.find({ caregiverUserId: req.auth.id, status: { $in: ["active", "suspended"] } })
    .populate({ path: "patientProfileId", select: "displayName profileType timezone status identityUserId" })
    .sort({ acceptedAt: -1 });
  const actorProfiles = await PatientProfile.find({ identityUserId: req.auth.id, status: "active" }).select("_id");
  const incoming = actorProfiles.length
    ? await CareRelationship.find({ patientProfileId: { $in: actorProfiles.map((item) => item._id) }, caregiverUserId: { $ne: req.auth.id }, status: { $in: ["active", "suspended"] } })
      .populate("caregiverUserId", "name profilePicture")
      .populate({ path: "patientProfileId", select: "displayName profileType timezone status" })
      .sort({ acceptedAt: -1 })
    : [];
  return res.json({
    success: true,
    data: {
      familyMembers: outgoing.map((entry) => relationshipView(entry, null, entry.patientProfileId?.identityUserId ? null : null)),
      caregivers: incoming.map((entry) => relationshipView(entry, null, entry.caregiverUserId)),
    },
  });
};

export const updateConnection = async (req, res) => {
  const relationship = await CareRelationship.findById(req.params.connectionId);
  if (!relationship || relationship.status === "revoked") return res.status(404).json({ success: false, code: "CONNECTION_NOT_FOUND", message: "Connection not found." });
  if (!await actorCanManageConnection({ relationship, actorUserId: req.auth.id })) return res.status(403).json({ success: false, code: "PROFILE_ACCESS_DENIED", message: "You cannot change this connection." });
  if (relationship.role === "owner") return res.status(409).json({ success: false, code: "OWNER_CONNECTION_IMMUTABLE", message: "The profile owner relationship cannot be changed." });
  const role = req.body?.role === undefined ? relationship.role : roleForRequest(req.body.role);
  if (req.body?.role !== undefined && !ROLES.has(role)) return res.status(400).json({ success: false, code: "INVALID_CARE_ROLE", message: "Use a supported caregiver role." });
  const actorRelationship = await relationshipForActor({ patientProfileId: relationship.patientProfileId, actorUserId: req.auth.id });
  const actorPermissions = actorRelationship?.role === "owner" ? permissionsForRole("owner") : actorRelationship?.permissions;
  relationship.role = role;
  relationship.permissions = restrictPermissionsToActor(req.body?.permissions || relationship.permissions?.toObject?.() || relationship.permissions, role, actorPermissions);
  if (["active", "suspended"].includes(req.body?.status)) relationship.status = req.body.status;
  await relationship.save();
  await writeAuditLog({ req, action: "family_connection_updated", resourceType: "CareRelationship", resourceId: relationship._id, patientProfileId: relationship.patientProfileId });
  return res.json({ success: true, data: { connection: relationshipView(relationship) } });
};

export const deleteConnection = async (req, res) => {
  const relationship = await CareRelationship.findById(req.params.connectionId);
  if (!relationship || relationship.status === "revoked") return res.status(404).json({ success: false, code: "CONNECTION_NOT_FOUND", message: "Connection not found." });
  if (!await actorCanManageConnection({ relationship, actorUserId: req.auth.id })) return res.status(403).json({ success: false, code: "PROFILE_ACCESS_DENIED", message: "You cannot revoke this connection." });
  if (relationship.role === "owner") return res.status(409).json({ success: false, code: "OWNER_CONNECTION_IMMUTABLE", message: "The profile owner relationship cannot be revoked." });
  relationship.status = "revoked";
  relationship.revokedAt = new Date();
  await relationship.save();
  await writeAuditLog({ req, action: "family_connection_revoked", resourceType: "CareRelationship", resourceId: relationship._id, patientProfileId: relationship.patientProfileId });
  return res.json({ success: true, message: "Connection revoked" });
};

const countProfileData = async ({ profile, identityUser = null }) => {
  const [documents, appointments, medications] = await Promise.all([
    Document.countDocuments({ $or: [{ patientProfileId: profile._id }, ...(identityUser ? [{ patientProfileId: null, userId: String(identityUser._id) }] : [])] }),
    Appointment.countDocuments({ $or: [{ patientProfileId: profile._id }, ...(identityUser ? [{ patientProfileId: null, patientId: String(identityUser._id) }] : [])] }),
    MedicationOrder.countDocuments({ patientProfileId: profile._id }),
  ]);
  const legacy = identityUser
    ? (identityUser.medications?.length || 0) + (identityUser.medicalRecords?.length || 0) + (identityUser.medicalHistory?.length || 0)
    : 0;
  return documents + appointments + medications + legacy;
};

export const requestManagedProfileLink = async (req, res) => {
  const targetUserId = asId(req.body?.targetUserId);
  if (!objectId(targetUserId)) return res.status(400).json({ success: false, code: "INVALID_TARGET_USER", message: "Choose a valid Medical Vault account." });
  const profile = req.patientProfile;
  if (profile.identityUserId) return res.status(409).json({ success: false, code: "PROFILE_ALREADY_LINKED", message: "This profile is already linked to a Medical Vault account." });
  const target = await User.findOne({ _id: targetUserId, isActive: true });
  if (!target) return res.status(404).json({ success: false, code: "USER_NOT_FOUND", message: "Medical Vault account not found." });
  const policy = await enforceFamilyProfileRequestPolicy({ targetUser: target, requesterUserId: req.auth.id });
  if (!policy.allowed) return res.status(403).json({ success: false, code: policy.code, message: "This account is not accepting profile link requests." });
  const existing = await CareInvitation.findOne({ kind: "profile_link", patientProfileId: profile._id, invitedUserId: target._id, status: "pending", expiresAt: { $gt: new Date() } });
  if (existing) return res.status(200).json({ success: true, data: { invitation: invitationView(existing), replayed: true } });
  const invitation = await CareInvitation.create({
    kind: "profile_link",
    patientProfileId: profile._id,
    invitedByUserId: req.auth.id,
    invitedUserId: target._id,
    invitedEmail: target.email,
    intendedRelationship: asText(req.body?.relationship, 60) || req.careRelationship.relationship || "family",
    intendedRole: roleForRequest(req.body?.role || "primaryCaregiver"),
    intendedPermissions: restrictPermissionsToActor(
      req.body?.permissions || policy.controls.defaultRequestedPermissions,
      roleForRequest(req.body?.role || "primaryCaregiver"),
      policy.controls.defaultRequestedPermissions,
    ),
    tokenHash: tokenHash(crypto.randomBytes(32).toString("base64url")),
    expiresAt: safeDate(req.body?.expiresInHours),
  });
  await writeAuditLog({ req, action: "managed_profile_link_requested", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: profile._id });
  return res.status(201).json({ success: true, data: { invitation: invitationView(invitation) } });
};

export const acceptManagedProfileLink = async (req, res) => {
  const invitation = await CareInvitation.findOne({ _id: req.params.linkId, kind: "profile_link", invitedUserId: req.auth.id });
  if (!invitation) return res.status(404).json({ success: false, code: "PROFILE_LINK_NOT_FOUND", message: "Profile link request not found." });
  if (invitation.status === "accepted") return res.json({ success: true, data: { profileId: String(invitation.patientProfileId), replayed: true } });
  if (invitation.status !== "pending") return res.status(409).json({ success: false, code: "PROFILE_LINK_NOT_PENDING", message: "This profile link can no longer be accepted." });
  const [profile, target] = await Promise.all([
    PatientProfile.findById(invitation.patientProfileId),
    User.findById(req.auth.id),
  ]);
  if (!profile || !target || profile.identityUserId) return res.status(409).json({ success: false, code: "PROFILE_LINK_UNAVAILABLE", message: "This profile can no longer be linked." });
  const targetSelf = await ensureSelfPatientProfile(target);
  const [managedData, targetData] = await Promise.all([
    countProfileData({ profile }),
    countProfileData({ profile: targetSelf, identityUser: target }),
  ]);
  if (managedData > 0 && targetData > 0) {
    invitation.status = "merge_review_required";
    await invitation.save();
    await writeAuditLog({ req, action: "managed_profile_link_merge_review_required", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: profile._id });
    return res.status(409).json({ success: false, code: "MERGE_REVIEW_REQUIRED", message: "Both profiles contain health data and require an approved merge review." });
  }
  if (targetData > 0) {
    invitation.status = "merge_review_required";
    await invitation.save();
    return res.status(409).json({ success: false, code: "MERGE_REVIEW_REQUIRED", message: "The existing account profile contains health data and requires an approved merge review." });
  }
  // The synthetic lazy self profile is empty, so archive it rather than creating
  // a second healthcare subject. Its audit history remains intact.
  if (String(targetSelf._id) !== String(profile._id)) {
    targetSelf.status = "archived";
    targetSelf.updatedBy = req.auth.id;
    await targetSelf.save();
    await CareRelationship.updateMany({ patientProfileId: targetSelf._id, caregiverUserId: target._id, status: { $ne: "revoked" } }, { $set: { status: "revoked", revokedAt: new Date() } });
  }
  profile.identityUserId = target._id;
  profile.primaryOwnerUserId = target._id;
  profile.profileType = "linked";
  profile.consent = { status: "granted", capturedAt: new Date(), capturedBy: target._id, version: "1.0" };
  profile.updatedBy = target._id;
  await profile.save();
  await User.updateOne({ _id: target._id }, { $set: { selfPatientProfileId: profile._id } });
  const requester = await CareRelationship.findOne({ patientProfileId: profile._id, caregiverUserId: invitation.invitedByUserId });
  if (requester) {
    requester.relationship = invitation.intendedRelationship;
    requester.role = invitation.intendedRole;
    requester.permissions = sanitizePermissions(invitation.intendedPermissions?.toObject?.() || invitation.intendedPermissions, invitation.intendedRole);
    requester.status = "active";
    requester.acceptedAt = new Date();
    requester.revokedAt = null;
    requester.invitationId = invitation._id;
    await requester.save();
  } else {
    await CareRelationship.create({ patientProfileId: profile._id, caregiverUserId: invitation.invitedByUserId, relationship: invitation.intendedRelationship, role: invitation.intendedRole, permissions: sanitizePermissions(invitation.intendedPermissions?.toObject?.() || invitation.intendedPermissions, invitation.intendedRole), status: "active", invitedBy: invitation.invitedByUserId, invitationId: invitation._id, acceptedAt: new Date() });
  }
  await CareRelationship.findOneAndUpdate(
    { patientProfileId: profile._id, caregiverUserId: target._id },
    { $set: { relationship: "self", role: "owner", permissions: permissionsForRole("owner"), status: "active", acceptedAt: new Date(), revokedAt: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  invitation.status = "accepted";
  invitation.acceptedAt = new Date();
  await invitation.save();
  await writeAuditLog({ req, action: "managed_profile_link_accepted", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: profile._id });
  return res.json({ success: true, data: { profile: profileView(profile) } });
};

export const declineManagedProfileLink = async (req, res) => {
  const invitation = await CareInvitation.findOne({ _id: req.params.linkId, kind: "profile_link", invitedUserId: req.auth.id, status: "pending" });
  if (!invitation) return res.status(404).json({ success: false, code: "PROFILE_LINK_NOT_FOUND", message: "Profile link request not found." });
  invitation.status = "declined";
  await invitation.save();
  await writeAuditLog({ req, action: "managed_profile_link_declined", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: invitation.patientProfileId });
  return res.json({ success: true, message: "Profile link request declined" });
};
