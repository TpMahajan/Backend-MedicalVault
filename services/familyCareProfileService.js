import { PatientProfile } from "../models/PatientProfile.js";
import { CareRelationship } from "../models/CareRelationship.js";
import { permissionsForRole } from "./familyCarePermissions.js";

export const ensureSelfPatientProfile = async (user) => {
  if (!user?._id) throw new Error("Patient user is required");

  let profile = user.selfPatientProfileId
    ? await PatientProfile.findById(user.selfPatientProfileId)
    : null;
  if (!profile) {
    profile = await PatientProfile.findOne({ identityUserId: user._id, profileType: "self" });
  }
  if (!profile) {
    profile = await PatientProfile.findOneAndUpdate(
      { migrationKey: `self:${user._id}` },
      {
        $setOnInsert: {
          identityUserId: user._id,
          primaryOwnerUserId: user._id,
          profileType: "self",
          displayName: user.name,
          profilePhotoKey: user.profilePicture || null,
          dateOfBirth: user.dateOfBirth || null,
          gender: user.gender || null,
          bloodGroup: user.bloodType || null,
          timezone: "Asia/Kolkata",
          medicalSummary: {
            allergies: user.allergies ? [String(user.allergies)] : [],
            conditions: (user.medicalHistory || []).map((item) => item.condition).filter(Boolean),
          },
          consent: {
            status: "not_required",
            capturedAt: new Date(),
            capturedBy: user._id,
            version: "1.0",
          },
          createdBy: user._id,
          updatedBy: user._id,
          migrationKey: `self:${user._id}`,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  await Promise.all([
    CareRelationship.findOneAndUpdate(
      { patientProfileId: profile._id, caregiverUserId: user._id },
      {
        $set: {
          relationship: "self",
          role: "owner",
          permissions: permissionsForRole("owner"),
          status: "active",
          acceptedAt: profile.createdAt || new Date(),
          revokedAt: null,
        },
        $setOnInsert: { migrationKey: `self:${user._id}` },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ),
    user.selfPatientProfileId?.toString() === profile._id.toString()
      ? Promise.resolve()
      : user.constructor.updateOne({ _id: user._id }, { $set: { selfPatientProfileId: profile._id } }),
  ]);

  return profile;
};

export const findSelfPatientProfileId = async (userId) => {
  if (!userId) return null;
  const profile = await PatientProfile.findOne({ identityUserId: userId, profileType: "self", status: "active" })
    .select("_id")
    .lean();
  return profile?._id || null;
};
