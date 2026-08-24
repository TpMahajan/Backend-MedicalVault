import crypto from "crypto";
import mongoose from "mongoose";
import { PatientProfile } from "../models/PatientProfile.js";
import { CareRelationship } from "../models/CareRelationship.js";
import { FamilyCareIdempotencyKey } from "../models/FamilyCareIdempotencyKey.js";
import { CareInvitation } from "../models/CareInvitation.js";
import { Appointment } from "../models/Appointment.js";
import { Document } from "../models/File.js";
import { MedicationDoseEvent } from "../models/MedicationDoseEvent.js";
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
const FAMILY_PROFILE_CREATE_ENDPOINT = "POST:/api/v1/family-care/profiles";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const GENDERS = new Set(["female", "male", "non_binary", "other", "prefer_not_to_say"]);
const BLOOD_GROUPS = new Set(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);

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
  const raw = asText(value, 16);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)) return undefined;
  return date;
};

const stringList = (value, maxItems = 30, maxLength = 500) => Array.isArray(value)
  ? value.slice(0, maxItems).map((item) => asText(item, maxLength)).filter(Boolean)
  : [];

const mapObject = (value) => value && typeof value === "object" && !Array.isArray(value)
  ? value
  : {};

const dateOnly = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const asPlain = (value) => value && typeof value.toObject === "function"
  ? value.toObject({ getters: true })
  : value || {};

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const profileFingerprint = (patch, relationship) => crypto
  .createHash("sha256")
  .update(stableJson({
    ...patch,
    dateOfBirth: patch.dateOfBirth instanceof Date ? patch.dateOfBirth.toISOString() : patch.dateOfBirth,
    relationship,
  }))
  .digest("hex");

const idempotencyKeyFromRequest = (req) => asText(req.get("Idempotency-Key"), 128);
const validIdempotencyKey = (value) => /^[A-Za-z0-9._:-]{8,128}$/.test(value);

const sendError = (res, status, code, message, fields = {}) => res.status(status).json({
  success: false,
  code,
  message,
  error: { code, message, fields },
});

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
  if (body.emergencyContact && typeof body.emergencyContact === "object") {
    const contact = mapObject(body.emergencyContact);
    patch.emergencyContact = {
      name: asText(contact.name, 120),
      relationship: asText(contact.relationship, 60),
      phone: asText(contact.phone, 32),
    };
  }
  return patch;
};

const validateProfilePatch = (patch, { create = false, relationship = "" } = {}) => {
  const fields = {};
  if (!patch.displayName) fields.displayName = "Full name is required.";
  if (create && !relationship) fields.relationship = "Relationship is required.";
  if (create && !patch.dateOfBirth) fields.dateOfBirth = "Date of birth is required.";
  if (Object.hasOwn(patch, "dateOfBirth") && patch.dateOfBirth === undefined) fields.dateOfBirth = "Enter a valid date of birth.";
  if (patch.dateOfBirth && patch.dateOfBirth > new Date()) fields.dateOfBirth = "Date of birth cannot be in the future.";
  if (patch.timezone && !isValidTimezone(patch.timezone)) fields.timezone = "Choose a valid IANA timezone.";
  if (patch.gender && !GENDERS.has(patch.gender)) fields.gender = "Choose a supported gender value.";
  if (patch.bloodGroup && !BLOOD_GROUPS.has(patch.bloodGroup)) fields.bloodGroup = "Choose a supported blood group.";
  if (patch.preferredLanguage && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(patch.preferredLanguage)) fields.preferredLanguage = "Use a language tag such as en or en-IN.";
  if (patch.height !== undefined && patch.height !== null && (!Number.isFinite(patch.height) || patch.height < 0 || patch.height > 300)) fields.height = "Enter a valid height.";
  if (patch.weight !== undefined && patch.weight !== null && (!Number.isFinite(patch.weight) || patch.weight < 0 || patch.weight > 1000)) fields.weight = "Enter a valid weight.";
  if (patch.emergencyContact?.phone && !/^[+0-9()\-\s]{6,32}$/.test(patch.emergencyContact.phone)) fields.emergencyContact = "Enter a valid emergency contact phone number.";
  return fields;
};

const relationshipView = (relationship) => ({
  id: String(relationship._id),
  patientProfileId: String(relationship.patientProfileId?._id || relationship.patientProfileId || ""),
  relationship: relationship.relationship,
  role: relationship.role,
  permissions: mapObject(relationship.permissions),
  status: relationship.status,
  acceptedAt: relationship.acceptedAt || null,
  expiresAt: relationship.expiresAt || null,
});

const invitationView = (invitation) => ({
  id: String(invitation._id),
  patientProfileId: String(invitation.patientProfileId?._id || invitation.patientProfileId || ""),
  intendedRelationship: invitation.intendedRelationship,
  intendedRole: invitation.intendedRole,
  status: invitation.status,
  acceptedAt: invitation.acceptedAt || null,
  revokedAt: invitation.revokedAt || null,
  expiresAt: invitation.expiresAt || null,
});

const profileView = (profile, relationship) => {
  const source = asPlain(profile);
  const summary = mapObject(source.medicalSummary);
  const emergencyContact = mapObject(source.emergencyContact);
  return {
    id: String(source._id || source.id || ""),
    displayName: asText(source.displayName, 120),
    relationship: relationship?.relationship || null,
    profileType: source.profileType,
    dateOfBirth: dateOnly(source.dateOfBirth),
    gender: source.gender || null,
    bloodGroup: source.bloodGroup || null,
    height: source.height ?? null,
    weight: source.weight ?? null,
    timezone: source.timezone || "Asia/Kolkata",
    preferredLanguage: source.preferredLanguage || "en",
    profilePhotoKey: source.profilePhotoKey || null,
    status: source.status,
    medicalSummary: {
      allergies: stringList(summary.allergies, 30, 240),
      conditions: stringList(summary.conditions, 30, 240),
      currentConcerns: stringList(summary.currentConcerns),
      lifestyleNotes: stringList(summary.lifestyleNotes),
    },
    emergencyContact: {
      name: asText(emergencyContact.name, 120),
      relationship: asText(emergencyContact.relationship, 60),
      phone: asText(emergencyContact.phone, 32),
    },
    role: relationship?.role || null,
    permissions: mapObject(relationship?.permissions),
  };
};

const profileResponse = (profile, relationship) => ({
  profile: profileView(profile, relationship),
  relationship: relationshipView(relationship),
});

const isTransactionUnsupported = (error) => error?.code === 20 || /transaction numbers are only allowed|transactions are not supported|replica set member or mongos/i.test(String(error?.message || ""));

const completeIdempotency = async (record, profile, relationship, { session } = {}) => {
  const update = {
    $set: {
      status: "completed",
      patientProfileId: profile._id,
      careRelationshipId: relationship._id,
      failureCode: "",
    },
  };
  await FamilyCareIdempotencyKey.updateOne({ _id: record._id }, update, session ? { session } : undefined);
};

const findIdempotentReplay = async (record) => {
  if (!record?.patientProfileId) return null;
  const [profile, relationship] = await Promise.all([
    PatientProfile.findById(record.patientProfileId),
    record.careRelationshipId
      ? CareRelationship.findById(record.careRelationshipId)
      : CareRelationship.findOne({ patientProfileId: record.patientProfileId, caregiverUserId: record.actorUserId, role: "owner" }),
  ]);
  if (!profile || !relationship) return null;
  if (profile.status === "pending" && relationship.status === "active") {
    profile.status = "active";
    await profile.save();
  }
  if (profile.status !== "active" || relationship.status !== "active") return null;
  if (record.status !== "completed") await completeIdempotency(record, profile, relationship);
  return { profile, relationship };
};

const claimIdempotencyKey = async ({ actorUserId, key, fingerprint }) => {
  const attributes = { actorUserId, endpoint: FAMILY_PROFILE_CREATE_ENDPOINT, key };
  try {
    const record = await FamilyCareIdempotencyKey.create({
      ...attributes,
      requestFingerprint: fingerprint,
      status: "in_progress",
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    });
    return { record };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await FamilyCareIdempotencyKey.findOne(attributes);
    if (!existing) throw error;
    if (existing.requestFingerprint !== fingerprint) return { error: "conflict" };
    const replay = await findIdempotentReplay(existing);
    if (replay) return { replay };
    return { error: existing.status === "failed" ? "failed" : "in_progress" };
  }
};

const createProfilePayload = ({ patch, actorId, relationship }) => ({
  ...patch,
  primaryOwnerUserId: actorId,
  profileType: "managed",
  consent: { status: "not_required", capturedAt: new Date(), capturedBy: actorId, version: "1.0" },
  createdBy: actorId,
  updatedBy: actorId,
  status: "active",
});

const relationshipPayload = ({ profileId, actorId, relationship }) => ({
  patientProfileId: profileId,
  caregiverUserId: actorId,
  relationship,
  role: "owner",
  permissions: permissionsForRole("owner"),
  status: "active",
  acceptedAt: new Date(),
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
      .map((entry) => profileResponse(entry.patientProfileId, entry));
    return res.json({ success: true, data: { profiles } });
  } catch (error) {
    console.error("Family Care list profiles failed:", error.message);
    return sendError(res, 500, "FAMILY_CARE_LIST_FAILED", "Unable to load Family Care profiles");
  }
};

export const createProfile = async (req, res) => {
  let idempotencyRecord;
  try {
    const patch = profilePatch(req.body || {}, { create: true });
    const relationship = asText(req.body?.relationship, 60);
    const validationFields = validateProfilePatch(patch, { create: true, relationship });
    if (Object.keys(validationFields).length) {
      return sendError(res, 400, "VALIDATION_ERROR", "Please correct the highlighted fields.", validationFields);
    }
    const idempotencyKey = idempotencyKeyFromRequest(req);
    if (!validIdempotencyKey(idempotencyKey)) {
      return sendError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key is required to add a family member.", {
        idempotencyKey: "Use an opaque key between 8 and 128 characters.",
      });
    }
    const fingerprint = profileFingerprint(patch, relationship);
    const idempotencyClaim = await claimIdempotencyKey({
      actorUserId: req.auth.id,
      key: idempotencyKey,
      fingerprint,
    });
    if (idempotencyClaim.replay) {
      return res.status(201).json({
        success: true,
        message: "Family member added",
        data: profileResponse(idempotencyClaim.replay.profile, idempotencyClaim.replay.relationship),
      });
    }
    if (idempotencyClaim.error === "conflict") {
      return sendError(res, 409, "IDEMPOTENCY_KEY_CONFLICT", "This Idempotency-Key was already used for a different request.");
    }
    if (idempotencyClaim.error === "failed") {
      return sendError(res, 409, "IDEMPOTENCY_REQUEST_FAILED", "The previous request with this key did not complete. Retry with a new Idempotency-Key.");
    }
    if (idempotencyClaim.error === "in_progress") {
      return sendError(res, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "This request is still being processed. Please retry shortly with the same Idempotency-Key.");
    }
    idempotencyRecord = idempotencyClaim.record;
    const maxProfiles = Math.max(0, req.familyCareEntitlement.limits.maxManagedProfiles);
    const existing = await PatientProfile.countDocuments({ primaryOwnerUserId: req.auth.id, profileType: "managed", status: "active" });
    if (existing >= maxProfiles) {
      idempotencyRecord.status = "failed";
      idempotencyRecord.failureCode = "MANAGED_PROFILE_LIMIT_REACHED";
      await idempotencyRecord.save();
      return sendError(
        res,
        403,
        "MANAGED_PROFILE_LIMIT_REACHED",
        `You are using ${existing} of ${maxProfiles} managed Family Care profiles.`,
        { managedProfiles: String(existing), managedProfileLimit: String(maxProfiles) },
      );
    }

    const payload = createProfilePayload({ patch, actorId: req.auth.id, relationship });
    let profile;
    let ownerRelationship;
    let transactionUnsupported = false;
    let session;
    try {
      session = await mongoose.startSession();
      await session.withTransaction(async () => {
        [profile] = await PatientProfile.create([payload], { session });
        [ownerRelationship] = await CareRelationship.create([
          relationshipPayload({ profileId: profile._id, actorId: req.auth.id, relationship }),
        ], { session });
        await completeIdempotency(idempotencyRecord, profile, ownerRelationship, { session });
      });
    } catch (error) {
      if (!isTransactionUnsupported(error)) throw error;
      transactionUnsupported = true;
    } finally {
      if (session) await session.endSession();
    }

    if (transactionUnsupported) {
      profile = await PatientProfile.create({ ...payload, status: "pending" });
      await FamilyCareIdempotencyKey.updateOne(
        { _id: idempotencyRecord._id },
        { $set: { patientProfileId: profile._id } },
      );
      try {
        ownerRelationship = await CareRelationship.create(
          relationshipPayload({ profileId: profile._id, actorId: req.auth.id, relationship }),
        );
        profile.status = "active";
        await profile.save();
        await completeIdempotency(idempotencyRecord, profile, ownerRelationship);
      } catch (relationshipError) {
        const recoveredRelationship = await CareRelationship.findOne({
          patientProfileId: profile._id,
          caregiverUserId: req.auth.id,
          role: "owner",
          status: "active",
        });
        if (recoveredRelationship) {
          ownerRelationship = recoveredRelationship;
          profile.status = "active";
          await profile.save();
          await completeIdempotency(idempotencyRecord, profile, ownerRelationship);
        } else {
          let deletedPendingProfile = false;
          try {
            const cleanup = await PatientProfile.deleteOne({ _id: profile._id, status: "pending" });
            deletedPendingProfile = Boolean(cleanup?.deletedCount);
          } catch (_) {
            // Preserve a non-active record for follow-up if cleanup itself is unavailable.
          }
          if (!deletedPendingProfile) {
            profile.status = "creation_failed";
            await profile.save().catch(() => undefined);
          }
          idempotencyRecord.status = "failed";
          idempotencyRecord.failureCode = "FAMILY_CARE_RELATIONSHIP_CREATE_FAILED";
          await idempotencyRecord.save();
          throw relationshipError;
        }
      }
    }
    await writeAuditLog({ req, action: "family_profile_created", resourceType: "PatientProfile", resourceId: profile._id, patientProfileId: profile._id, statusCode: 201 });
    return res.status(201).json({
      success: true,
      message: "Family member added",
      data: profileResponse(profile, ownerRelationship),
    });
  } catch (error) {
    console.error("Family Care create profile failed:", error.message);
    if (idempotencyRecord && idempotencyRecord.status === "in_progress") {
      idempotencyRecord.status = "failed";
      idempotencyRecord.failureCode = "FAMILY_CARE_CREATE_FAILED";
      await idempotencyRecord.save().catch(() => {});
    }
    return sendError(res, 500, "FAMILY_CARE_CREATE_FAILED", "Unable to create patient profile");
  }
};

export const getProfile = async (req, res) => {
  await writeAuditLog({ req, action: "family_profile_viewed", resourceType: "PatientProfile", resourceId: req.patientProfile._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, data: profileResponse(req.patientProfile, req.careRelationship) });
};

export const updateProfile = async (req, res) => {
  try {
    const patch = profilePatch(req.body || {});
    const hasRelationshipUpdate = req.body?.relationship !== undefined;
    if (!Object.keys(patch).length && !hasRelationshipUpdate) {
      return sendError(res, 400, "VALIDATION_ERROR", "No supported profile fields supplied.");
    }
    const validationFields = validateProfilePatch({ ...asPlain(req.patientProfile), ...patch }, {
      relationship: hasRelationshipUpdate ? asText(req.body.relationship, 60) : req.careRelationship.relationship,
    });
    if (Object.keys(validationFields).length) {
      return sendError(res, 400, "VALIDATION_ERROR", "Please correct the highlighted fields.", validationFields);
    }
    if (hasRelationshipUpdate && req.careRelationship.role !== "owner") {
      return sendError(res, 403, "PROFILE_OWNER_REQUIRED", "Only the profile owner can change the relationship label.");
    }
    Object.assign(req.patientProfile, patch, { updatedBy: req.auth.id });
    await req.patientProfile.save();
    if (hasRelationshipUpdate) {
      req.careRelationship.relationship = asText(req.body.relationship, 60);
      await req.careRelationship.save();
    }
    await writeAuditLog({ req, action: "family_profile_updated", resourceType: "PatientProfile", resourceId: req.patientProfile._id, patientProfileId: req.patientProfile._id });
    return res.json({ success: true, message: "Profile updated", data: profileResponse(req.patientProfile, req.careRelationship) });
  } catch (error) {
    console.error("Family Care update profile failed:", error.message);
    return sendError(res, 500, "FAMILY_CARE_UPDATE_FAILED", "Unable to update patient profile");
  }
};

export const archiveProfile = async (req, res) => {
  if (req.patientProfile.profileType === "self") return sendError(res, 409, "SELF_PROFILE_ARCHIVE_FORBIDDEN", "Your self profile cannot be archived");
  if (req.patientProfile.status === "archived") {
    return res.json({ success: true, message: "Profile already archived", data: { profile: profileView(req.patientProfile, req.careRelationship) } });
  }
  if (req.patientProfile.status !== "active") return sendError(res, 409, "PROFILE_NOT_ACTIVE", "Only active profiles can be archived.");
  req.patientProfile.status = "archived";
  req.patientProfile.updatedBy = req.auth.id;
  await req.patientProfile.save();
  await CareRelationship.updateMany({ patientProfileId: req.patientProfile._id, status: { $ne: "revoked" } }, { $set: { status: "revoked", revokedAt: new Date() } });
  await writeAuditLog({ req, action: "family_profile_archived", resourceType: "PatientProfile", resourceId: req.patientProfile._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, message: "Profile archived", data: { profile: profileView(req.patientProfile, req.careRelationship) } });
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
  if (!token) return res.status(400).json({ success: false, code: "INVITATION_TOKEN_REQUIRED", message: "Invitation token is required" });

  const invitation = await CareInvitation.findById(req.params.invitationId).select("+tokenHash");
  if (!invitation) {
    return res.status(404).json({ success: false, code: "INVITATION_NOT_FOUND", message: "This invitation could not be found." });
  }

  // Idempotent replay: a double-tap, a retried request after a dropped
  // response, or a stale client re-submitting must not surface as an error
  // once the invitation has already been resolved.
  if (invitation.status === "accepted") {
    if (!accept) {
      return res.status(409).json({ success: false, code: "INVITATION_ALREADY_ACCEPTED", message: "This invitation has already been accepted." });
    }
    const relationship = await CareRelationship.findOne({ patientProfileId: invitation.patientProfileId, caregiverUserId: req.auth.id });
    return res.json({
      success: true,
      message: "Caregiver access already accepted",
      data: { request: invitationView(invitation), relationship: relationship ? relationshipView(relationship) : null, replayed: true },
    });
  }
  if (invitation.status === "declined") {
    return res.status(409).json({ success: false, code: "INVITATION_ALREADY_DECLINED", message: "This invitation has already been declined." });
  }
  if (invitation.status !== "pending") {
    return res.status(409).json({ success: false, code: "INVITATION_NOT_PENDING", message: "This invitation can no longer be actioned." });
  }
  if (invitation.expiresAt <= new Date()) {
    invitation.status = "expired";
    await invitation.save();
    return res.status(410).json({ success: false, code: "INVITATION_EXPIRED", message: "This invitation has expired." });
  }

  const suppliedHash = Buffer.from(hashToken(token));
  const storedHash = Buffer.from(invitation.tokenHash);
  if (suppliedHash.length !== storedHash.length || !crypto.timingSafeEqual(suppliedHash, storedHash)) {
    return res.status(403).json({ success: false, code: "INVITATION_TOKEN_INVALID", message: "This invitation token is invalid." });
  }
  if (invitation.invitedEmail && invitation.invitedEmail !== normalizeEmail(req.user.email)) {
    return res.status(403).json({ success: false, code: "INVITATION_NOT_AUTHORIZED", message: "This invitation was issued to another account." });
  }

  if (!accept) {
    invitation.status = "declined";
    await invitation.save();
    await writeAuditLog({ req, action: "caregiver_declined", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: invitation.patientProfileId });
    return res.json({ success: true, message: "Invitation declined", data: { request: invitationView(invitation) } });
  }

  try {
    const relationship = await CareRelationship.findOneAndUpdate(
      { patientProfileId: invitation.patientProfileId, caregiverUserId: req.auth.id },
      { $set: { relationship: invitation.intendedRelationship, role: invitation.intendedRole, permissions: invitation.intendedPermissions, status: "active", invitationId: invitation._id, invitedBy: invitation.invitedByUserId, acceptedAt: new Date(), revokedAt: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    await invitation.save();
    await writeAuditLog({ req, action: "caregiver_accepted", resourceType: "CareInvitation", resourceId: invitation._id, patientProfileId: invitation.patientProfileId });
    return res.json({
      success: true,
      message: "Caregiver access accepted",
      data: { request: invitationView(invitation), relationship: relationshipView(relationship) },
    });
  } catch (error) {
    // A concurrent accept (double-tap, two tabs, retried request) can race
    // this upsert under the compound unique index. That is expected and
    // safe to resolve by replaying the now-committed state rather than
    // surfacing a raw duplicate-key error to the client.
    if (error?.code === 11000) {
      console.warn(`[family-care] caregiver accept conflict user=${String(req.auth?.id || "unknown")} code=11000`);
      const [refreshedInvitation, relationship] = await Promise.all([
        CareInvitation.findById(invitation._id),
        CareRelationship.findOne({ patientProfileId: invitation.patientProfileId, caregiverUserId: req.auth.id }),
      ]);
      if (relationship?.status === "active") {
        return res.json({
          success: true,
          message: "Caregiver access already accepted",
          data: { request: invitationView(refreshedInvitation || invitation), relationship: relationshipView(relationship), replayed: true },
        });
      }
      return res.status(409).json({ success: false, code: "CAREGIVER_ACCEPT_CONFLICT", message: "This request was updated concurrently. Please refresh and try again." });
    }
    console.error(`[family-care] caregiver accept failed user=${String(req.auth?.id || "unknown")} code=${error?.code || "unknown"}`);
    return res.status(500).json({ success: false, code: "FAMILY_CARE_ACCEPT_FAILED", message: "Unable to accept this request right now. Please try again." });
  }
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
    const [appointments, documents, doseEvents, managedProfiles] = await Promise.all([
      Appointment.find({ $or: [{ patientProfileId: { $in: profileIds } }, { patientProfileId: null, patientId: { $in: identityIds } }], appointmentDate: { $gte: start }, status: { $in: ["scheduled", "confirmed", "rescheduled"] } }).sort({ appointmentDate: 1 }).lean(),
      Document.find({ $or: [{ patientProfileId: { $in: profileIds } }, { patientProfileId: null, userId: { $in: identityIds } }] }).sort({ uploadedAt: -1 }).limit(Math.max(profileIds.length * 5, 5)).lean(),
      MedicationDoseEvent.find({ patientProfileId: { $in: profileIds }, originalLocalDate: requestedDate }).lean(),
      PatientProfile.countDocuments({ primaryOwnerUserId: req.auth.id, profileType: "managed", status: "active" }),
    ]);
    const entries = active.map((entry) => {
      const profile = entry.patientProfileId;
      const id = String(profile._id);
      const legacyId = profile.identityUserId ? String(profile.identityUserId) : "";
      const owns = (item) => String(item.patientProfileId || "") === id || (!item.patientProfileId && legacyId && String(item.patientId || item.userId || "") === legacyId);
      const profileAppointments = appointments.filter(owns);
      const today = profileAppointments.filter((item) => item.appointmentDate >= start && item.appointmentDate < end);
      const profileDoses = doseEvents.filter((item) => String(item.patientProfileId) === id);
      const nextDose = profileDoses
        .filter((item) => ["pending", "due", "snoozed"].includes(item.status))
        .sort((left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt))[0] || null;
      const medicationStatus = {
        state: profileDoses.some((item) => item.status === "missed") ? "attention" : (nextDose ? "scheduled" : "no_data"),
        scheduled: profileDoses.length,
        taken: profileDoses.filter((item) => item.status === "taken").length,
        missed: profileDoses.filter((item) => item.status === "missed").length,
        nextDose: nextDose ? {
          id: String(nextDose._id),
          scheduledAt: nextDose.scheduledAt,
          status: nextDose.status,
        } : null,
      };
      return {
        profile: profileView(profile, entry),
        permissions: entry.permissions,
        medicationStatus,
        appointments: { today, upcoming: profileAppointments.filter((item) => item.appointmentDate >= end).slice(0, 5) },
        alerts: [], vaccinationsDue: [], insuranceExpiring: [],
        recentDocuments: entry.permissions.documentsView ? documents.filter(owns).slice(0, 5) : [],
      };
    });
    const summaryMedicationState = entries.some((item) => item.medicationStatus.state === "attention")
      ? "attention"
      : entries.some((item) => item.medicationStatus.state === "scheduled") ? "scheduled" : "no_data";
    return res.json({ success: true, data: { date: requestedDate, timezone: asText(req.query.timezone, 80) || "Asia/Kolkata", profiles: entries, managedProfiles: { used: managedProfiles, limit: Math.max(0, Number(req.familyCareEntitlement.limits.maxManagedProfiles) || 0) }, familyAlerts: [], summary: { profiles: entries.length, appointmentsToday: entries.reduce((sum, item) => sum + item.appointments.today.length, 0), medicationState: summaryMedicationState } } });
  } catch (error) {
    console.error("Family Care dashboard failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load Family Care dashboard" });
  }
};
