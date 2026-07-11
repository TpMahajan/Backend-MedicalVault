import crypto from "crypto";
import mongoose from "mongoose";
import { PatientProfile } from "../models/PatientProfile.js";
import { CareRelationship } from "../models/CareRelationship.js";
import { CareInvitation } from "../models/CareInvitation.js";
import { Appointment } from "../models/Appointment.js";
import { Document } from "../models/File.js";
import { writeAuditLog } from "../middleware/auditLogger.js";
import { ensureSelfPatientProfile } from "../services/familyCareProfileService.js";
import { permissionsForRole, sanitizePermissions } from "../services/familyCarePermissions.js";

const asText = (value, max = 240) => String(value ?? "").trim().slice(0, max);
const normalizeEmail = (value) => asText(value, 254).toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const hashPhone = (phone) => crypto
  .createHmac("sha256", process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET)
  .update(asText(phone, 32).replace(/\s+/g, ""))
  .digest("hex");

const isValidTimezone = (timezone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
};

const parseDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const stringList = (value, maxItems = 30, maxLength = 500) => Array.isArray(value)
  ? value.slice(0, maxItems).map((item) => asText(item, maxLength)).filter(Boolean)
  : [];

const profilePatch = (body, { create = false } = {}) => {
  const patch = {};
  if (create || body.displayName !== undefined) patch.displayName = asText(body.displayName, 120);
  if (body.profilePhotoKey !== undefined) patch.profilePhotoKey = asText(body.profilePhotoKey, 500) || null;
  if (body.dateOfBirth !== undefined) patch.dateOfBirth = parseDate(body.dateOfBirth);
  if (body.gender !== undefined) patch.gender = asText(body.gender, 40) || null;
  if (body.bloodGroup !== undefined) patch.bloodGroup = asText(body.bloodGroup, 12) || null;
  if (body.height !== undefined) patch.height = body.height === null ? null : Number(body.height);
  if (body.weight !== undefined) patch.weight = body.weight === null ? null : Number(body.weight);
  if (body.timezone !== undefined) patch.timezone = asText(body.timezone, 80);
  if (body.preferredLanguage !== undefined) patch.preferredLanguage = asText(body.preferredLanguage, 20) || "en";
  if (body.medicalSummary && typeof body.medicalSummary === "object") {
    patch.medicalSummary = {
      allergies: stringList(body.medicalSummary.allergies, 30, 240),
      conditions: stringList(body.medicalSummary.conditions, 30, 240),
      currentConcerns: stringList(body.medicalSummary.currentConcerns),
      lifestyleNotes: stringList(body.medicalSummary.lifestyleNotes),
    };
  }
  return patch;
};

const validateProfilePatch = (patch) => {
  if (!patch.displayName) return "Display name is required";
  if (Object.hasOwn(patch, "dateOfBirth") && patch.dateOfBirth === undefined) return "Invalid date of birth";
  if (patch.dateOfBirth && patch.dateOfBirth > new Date()) return "Date of birth cannot be in the future";
  if (patch.timezone && !isValidTimezone(patch.timezone)) return "Invalid timezone";
  if (patch.height !== undefined && patch.height !== null && (!Number.isFinite(patch.height) || patch.height < 0 || patch.height > 300)) return "Invalid height";
  if (patch.weight !== undefined && patch.weight !== null && (!Number.isFinite(patch.weight) || patch.weight < 0 || patch.weight > 1000)) return "Invalid weight";
  return "";
};

const relationshipView = (relationship) => ({
  id: relationship._id,
  patientProfileId: relationship.patientProfileId?._id || relationship.patientProfileId,
  caregiver: relationship.caregiverUserId,
  relationship: relationship.relationship,
  role: relationship.role,
  permissions: relationship.permissions,
  status: relationship.status,
  acceptedAt: relationship.acceptedAt,
  expiresAt: relationship.expiresAt,
});

export const listProfiles = async (req, res) => {
  try {
    await ensureSelfPatientProfile(req.user);
    const relationships = await CareRelationship.find({
      caregiverUserId: req.auth.id,
      status: "active",
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    }).populate("patientProfileId");
    const profiles = relationships
      .filter((entry) => entry.patientProfileId?.status === "active")
      .map((entry) => ({ profile: entry.patientProfileId, relationship: relationshipView(entry) }));
    return res.json({ success: true, data: { profiles, entitlement: req.familyCareEntitlement } });
  } catch (error) {
    console.error("Family Care list profiles failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load Family Care profiles" });
  }
};

export const createProfile = async (req, res) => {
  try {
    const patch = profilePatch(req.body || {}, { create: true });
    const validationError = validateProfilePatch(patch);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    const maxProfiles = Math.max(0, req.familyCareEntitlement.limits.maxManagedProfiles);
    const existing = await PatientProfile.countDocuments({ primaryOwnerUserId: req.auth.id, profileType: "managed", status: "active" });
    if (existing >= maxProfiles) {
      return res.status(403).json({ success: false, code: "MANAGED_PROFILE_LIMIT_REACHED", message: "Your Family Care profile limit has been reached" });
    }

    const session = await mongoose.startSession();
    let profile;
    try {
      await session.withTransaction(async () => {
        [profile] = await PatientProfile.create([{
          ...patch,
          primaryOwnerUserId: req.auth.id,
          profileType: "managed",
          consent: { status: "not_required", capturedAt: new Date(), capturedBy: req.auth.id, version: asText(req.body?.consentVersion, 40) || "1.0" },
          createdBy: req.auth.id,
          updatedBy: req.auth.id,
        }], { session });
        await CareRelationship.create([{
          patientProfileId: profile._id,
          caregiverUserId: req.auth.id,
          relationship: asText(req.body?.relationship, 60) || "guardian",
          role: "owner",
          permissions: permissionsForRole("owner"),
          status: "active",
          acceptedAt: new Date(),
        }], { session });
      });
    } finally {
      await session.endSession();
    }
    await writeAuditLog({ req, action: "family_profile_created", resourceType: "PatientProfile", resourceId: profile._id, patientProfileId: profile._id, statusCode: 201 });
    return res.status(201).json({ success: true, message: "Family member added", data: { profile } });
  } catch (error) {
    console.error("Family Care create profile failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to create patient profile" });
  }
};

export const getProfile = async (req, res) => {
  await writeAuditLog({ req, action: "family_profile_viewed", resourceType: "PatientProfile", resourceId: req.patientProfile._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, data: { profile: req.patientProfile, relationship: relationshipView(req.careRelationship) } });
};

export const updateProfile = async (req, res) => {
  try {
    const patch = profilePatch(req.body || {});
    if (!Object.keys(patch).length) return res.status(400).json({ success: false, message: "No supported profile fields supplied" });
    const validationError = validateProfilePatch({ displayName: patch.displayName || req.patientProfile.displayName, ...patch });
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    Object.assign(req.patientProfile, patch, { updatedBy: req.auth.id });
    await req.patientProfile.save();
    await writeAuditLog({ req, action: "family_profile_updated", resourceType: "PatientProfile", resourceId: req.patientProfile._id, patientProfileId: req.patientProfile._id });
    return res.json({ success: true, message: "Profile updated", data: { profile: req.patientProfile } });
  } catch (error) {
    console.error("Family Care update profile failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to update patient profile" });
  }
};

export const archiveProfile = async (req, res) => {
  if (req.patientProfile.profileType === "self") return res.status(409).json({ success: false, code: "SELF_PROFILE_ARCHIVE_FORBIDDEN", message: "Your self profile cannot be archived" });
  req.patientProfile.status = "archived";
  req.patientProfile.updatedBy = req.auth.id;
  await req.patientProfile.save();
  await CareRelationship.updateMany({ patientProfileId: req.patientProfile._id, status: { $ne: "revoked" } }, { $set: { status: "revoked", revokedAt: new Date() } });
  await writeAuditLog({ req, action: "family_profile_archived", resourceType: "PatientProfile", resourceId: req.patientProfile._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, message: "Profile archived" });
};

export const listCaregivers = async (req, res) => {
  const caregivers = await CareRelationship.find({ patientProfileId: req.patientProfile._id, status: { $ne: "revoked" } })
    .populate("caregiverUserId", "name email profilePicture").sort({ createdAt: 1 });
  return res.json({ success: true, data: { caregivers: caregivers.map(relationshipView) } });
};

export const createInvitation = async (req, res) => {
  try {
    const invitedEmail = normalizeEmail(req.body?.email);
    const invitedPhone = asText(req.body?.phone, 32);
    if (!validEmail(invitedEmail) && !invitedPhone) return res.status(400).json({ success: false, message: "A valid email or phone number is required" });
    if (invitedEmail && invitedEmail === normalizeEmail(req.user.email)) return res.status(400).json({ success: false, message: "You already manage this profile" });
    const role = asText(req.body?.role, 40) || "viewer";
    if (!["primaryCaregiver", "secondaryCaregiver", "viewer", "emergencyContact"].includes(role)) return res.status(400).json({ success: false, message: "Invalid caregiver role" });
    const activeCount = await CareRelationship.countDocuments({ patientProfileId: req.patientProfile._id, status: { $in: ["active", "invited"] } });
    if (activeCount - 1 >= req.familyCareEntitlement.limits.maxCaregiversPerProfile) return res.status(403).json({ success: false, code: "CAREGIVER_LIMIT_REACHED", message: "The caregiver limit for this profile has been reached" });
    const token = crypto.randomBytes(32).toString("base64url");
    const intendedPermissions = sanitizePermissions(req.body?.permissions || permissionsForRole(role), role);
    const requestedHours = Number(req.body?.expiresInHours || 72);
    const expiresAt = new Date(Date.now() + Math.max(1, Math.min(Number.isFinite(requestedHours) ? requestedHours : 72, 168)) * 60 * 60 * 1000);
    const invitation = await CareInvitation.create({
      patientProfileId: req.patientProfile._id,
      invitedByUserId: req.auth.id,
      invitedEmail: validEmail(invitedEmail) ? invitedEmail : "",
      invitedPhoneHash: invitedPhone ? hashPhone(invitedPhone) : "",
      intendedRelationship: asText(req.body?.relationship, 60) || "caregiver",
      intendedRole: role,
      intendedPermissions,
      tokenHash: hashToken(token),
      expiresAt,
    });
    await writeAuditLog({ req, action: "caregiver_invited", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: req.patientProfile._id });
    return res.status(201).json({ success: true, message: "Caregiver invitation created", data: { invitation: { id: invitation._id, expiresAt, status: invitation.status }, invitationToken: token } });
  } catch (error) {
    console.error("Family Care invitation failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to create caregiver invitation" });
  }
};

export const listInvitations = async (req, res) => {
  const invitations = await CareInvitation.find({ invitedEmail: normalizeEmail(req.user.email), status: "pending", expiresAt: { $gt: new Date() } })
    .populate("patientProfileId", "displayName profilePhotoKey profileType").sort({ createdAt: -1 });
  return res.json({ success: true, data: { invitations } });
};

const respondToInvitation = async (req, res, accept) => {
  const token = asText(req.body?.token, 200);
  if (!token) return res.status(400).json({ success: false, message: "Invitation token is required" });
  const invitation = await CareInvitation.findById(req.params.invitationId).select("+tokenHash");
  if (!invitation || invitation.status !== "pending") return res.status(404).json({ success: false, message: "Invitation not found" });
  if (invitation.expiresAt <= new Date()) {
    invitation.status = "expired";
    await invitation.save();
    return res.status(410).json({ success: false, code: "INVITATION_EXPIRED", message: "Invitation has expired" });
  }
  const suppliedHash = Buffer.from(hashToken(token));
  const storedHash = Buffer.from(invitation.tokenHash);
  if (suppliedHash.length !== storedHash.length || !crypto.timingSafeEqual(suppliedHash, storedHash)) return res.status(403).json({ success: false, message: "Invalid invitation token" });
  if (invitation.invitedEmail && invitation.invitedEmail !== normalizeEmail(req.user.email)) return res.status(403).json({ success: false, message: "This invitation was issued to another account" });
  if (!accept) {
    invitation.status = "declined";
    await invitation.save();
    return res.json({ success: true, message: "Invitation declined" });
  }
  await CareRelationship.findOneAndUpdate(
    { patientProfileId: invitation.patientProfileId, caregiverUserId: req.auth.id },
    { $set: { relationship: invitation.intendedRelationship, role: invitation.intendedRole, permissions: invitation.intendedPermissions, status: "active", invitationId: invitation._id, invitedBy: invitation.invitedByUserId, acceptedAt: new Date(), revokedAt: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  invitation.status = "accepted";
  invitation.acceptedAt = new Date();
  await invitation.save();
  await writeAuditLog({ req, action: "caregiver_accepted", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: invitation.patientProfileId });
  return res.json({ success: true, message: "Caregiver access accepted" });
};

export const acceptInvitation = (req, res) => respondToInvitation(req, res, true);
export const declineInvitation = (req, res) => respondToInvitation(req, res, false);

export const updateCaregiver = async (req, res) => {
  const relationship = await CareRelationship.findOne({ _id: req.params.relationshipId, patientProfileId: req.patientProfile._id });
  if (!relationship || relationship.status === "revoked") return res.status(404).json({ success: false, message: "Caregiver relationship not found" });
  if (relationship.role === "owner") return res.status(409).json({ success: false, message: "Owner permissions cannot be changed" });
  const role = asText(req.body?.role, 40) || relationship.role;
  if (!["primaryCaregiver", "secondaryCaregiver", "viewer", "emergencyContact"].includes(role)) return res.status(400).json({ success: false, message: "Invalid caregiver role" });
  relationship.role = role;
  relationship.permissions = sanitizePermissions(req.body?.permissions || relationship.permissions.toObject(), role);
  if (["active", "suspended"].includes(req.body?.status)) relationship.status = req.body.status;
  await relationship.save();
  await writeAuditLog({ req, action: "caregiver_permission_changed", resourceType: "CareRelationship", resourceId: relationship._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, message: "Caregiver updated", data: { caregiver: relationshipView(relationship) } });
};

export const revokeCaregiver = async (req, res) => {
  const relationship = await CareRelationship.findOne({ _id: req.params.relationshipId, patientProfileId: req.patientProfile._id });
  if (!relationship || relationship.status === "revoked") return res.status(404).json({ success: false, message: "Caregiver relationship not found" });
  if (relationship.role === "owner") return res.status(409).json({ success: false, message: "Profile owner cannot be revoked" });
  relationship.status = "revoked";
  relationship.revokedAt = new Date();
  await relationship.save();
  await writeAuditLog({ req, action: "caregiver_revoked", resourceType: "CareRelationship", resourceId: relationship._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, message: "Caregiver access revoked" });
};

export const dashboard = async (req, res) => {
  try {
    await ensureSelfPatientProfile(req.user);
    const relationships = await CareRelationship.find({ caregiverUserId: req.auth.id, status: "active" }).populate("patientProfileId");
    const active = relationships.filter((entry) => entry.patientProfileId?.status === "active");
    const profileIds = active.map((entry) => entry.patientProfileId._id);
    const identityIds = active.map((entry) => entry.patientProfileId.identityUserId).filter(Boolean).map(String);
    const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    const start = new Date(`${requestedDate}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const [appointments, documents] = await Promise.all([
      Appointment.find({ $or: [{ patientProfileId: { $in: profileIds } }, { patientProfileId: null, patientId: { $in: identityIds } }], appointmentDate: { $gte: start }, status: { $in: ["scheduled", "confirmed", "rescheduled"] } }).sort({ appointmentDate: 1 }).lean(),
      Document.find({ $or: [{ patientProfileId: { $in: profileIds } }, { patientProfileId: null, userId: { $in: identityIds } }] }).sort({ uploadedAt: -1 }).limit(Math.max(profileIds.length * 5, 5)).lean(),
    ]);
    const entries = active.map((entry) => {
      const profile = entry.patientProfileId;
      const id = String(profile._id);
      const legacyId = profile.identityUserId ? String(profile.identityUserId) : "";
      const owns = (item) => String(item.patientProfileId || "") === id || (!item.patientProfileId && legacyId && String(item.patientId || item.userId || "") === legacyId);
      const profileAppointments = appointments.filter(owns);
      const today = profileAppointments.filter((item) => item.appointmentDate >= start && item.appointmentDate < end);
      return {
        profile,
        permissions: entry.permissions,
        medicationStatus: { state: "no_data", scheduled: 0, taken: 0, missed: 0, nextDose: null },
        appointments: { today, upcoming: profileAppointments.filter((item) => item.appointmentDate >= end).slice(0, 5) },
        alerts: [], vaccinationsDue: [], insuranceExpiring: [],
        recentDocuments: entry.permissions.documentsView ? documents.filter(owns).slice(0, 5) : [],
      };
    });
    return res.json({ success: true, data: { date: requestedDate, timezone: asText(req.query.timezone, 80) || "Asia/Kolkata", profiles: entries, familyAlerts: [], summary: { profiles: entries.length, appointmentsToday: entries.reduce((sum, item) => sum + item.appointments.today.length, 0), medicationState: "no_data" } } });
  } catch (error) {
    console.error("Family Care dashboard failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load Family Care dashboard" });
  }
};
