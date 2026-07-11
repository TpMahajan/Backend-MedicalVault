/**
 * Idempotent, restartable Family Care backfill.
 * Usage:
 *   node scripts/family-care/backfill-patient-profiles.js --dry-run
 *   node scripts/family-care/backfill-patient-profiles.js --batch-size=250
 *   node scripts/family-care/backfill-patient-profiles.js --restart
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../../models/User.js";
import { PatientProfile } from "../../models/PatientProfile.js";
import { CareRelationship } from "../../models/CareRelationship.js";
import { Document } from "../../models/File.js";
import { Appointment } from "../../models/Appointment.js";
import { Session } from "../../models/Session.js";
import QRCode from "../../models/QRCode.js";
import SOS from "../../models/SOS.js";
import { Notification } from "../../models/Notification.js";
import { FamilyCareMigrationCheckpoint } from "../../models/FamilyCareMigrationCheckpoint.js";
import { permissionsForRole } from "../../services/familyCarePermissions.js";

dotenv.config();
dotenv.config({ path: "./db.env" });

const MIGRATION = "family-care-self-profile-v1";
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const restart = process.argv.includes("--restart");
const batchArg = process.argv.find((arg) => arg.startsWith("--batch-size="));
const batchSize = Math.max(10, Math.min(Number(batchArg?.split("=")[1] || 250), 2000));

const backfillForUser = async (user) => {
  let profile = await PatientProfile.findOne({ identityUserId: user._id, profileType: "self" });
  if (!profile && !dryRun) {
    profile = await PatientProfile.findOneAndUpdate(
      { migrationKey: `self:${user._id}` },
      { $setOnInsert: {
        identityUserId: user._id,
        primaryOwnerUserId: user._id,
        profileType: "self",
        displayName: user.name,
        profilePhotoKey: user.profilePicture || null,
        dateOfBirth: user.dateOfBirth || null,
        gender: user.gender || null,
        bloodGroup: user.bloodType || null,
        medicalSummary: {
          allergies: user.allergies ? [String(user.allergies)] : [],
          conditions: (user.medicalHistory || []).map((item) => item.condition).filter(Boolean),
        },
        consent: { status: "not_required", capturedAt: new Date(), capturedBy: user._id, version: "1.0" },
        createdBy: user._id,
        updatedBy: user._id,
        migrationKey: `self:${user._id}`,
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
  if (dryRun) {
    const counts = await Promise.all([
      Document.countDocuments({ userId: String(user._id), patientProfileId: null }),
      Appointment.countDocuments({ patientId: String(user._id), patientProfileId: null }),
      Session.countDocuments({ patientId: user._id, patientProfileId: null }),
      QRCode.countDocuments({ patientId: user._id, patientProfileId: null }),
      SOS.countDocuments({ patientId: user._id, patientProfileId: null }),
      Notification.countDocuments({ recipientId: user._id, recipientRole: "patient", patientProfileId: null }),
    ]);
    return { profileCreated: profile ? 0 : 1, updated: counts.reduce((sum, count) => sum + count, 0) };
  }

  await CareRelationship.findOneAndUpdate(
    { patientProfileId: profile._id, caregiverUserId: user._id },
    { $set: { relationship: "self", role: "owner", permissions: permissionsForRole("owner"), status: "active", acceptedAt: profile.createdAt || new Date(), revokedAt: null }, $setOnInsert: { migrationKey: `self:${user._id}` } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const results = await Promise.all([
    User.updateOne({ _id: user._id }, { $set: { selfPatientProfileId: profile._id } }),
    Document.updateMany({ userId: String(user._id), patientProfileId: null }, { $set: { patientProfileId: profile._id, uploadedByUserId: user._id } }),
    Appointment.updateMany({ patientId: String(user._id), patientProfileId: null }, { $set: { patientProfileId: profile._id } }),
    Session.updateMany({ patientId: user._id, patientProfileId: null }, { $set: { patientProfileId: profile._id } }),
    QRCode.updateMany({ patientId: user._id, patientProfileId: null }, { $set: { patientProfileId: profile._id } }),
    SOS.updateMany({ patientId: user._id, patientProfileId: null }, { $set: { patientProfileId: profile._id } }),
    Notification.updateMany({ recipientId: user._id, recipientRole: "patient", patientProfileId: null }, { $set: { patientProfileId: profile._id } }),
  ]);
  return { profileCreated: 0, updated: results.reduce((sum, result) => sum + (result.modifiedCount || 0), 0) };
};

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI is required");
  await mongoose.connect(uri, { dbName: "healthvault", family: 4 });
  let checkpoint = restart || dryRun ? null : await FamilyCareMigrationCheckpoint.findOne({ migration: MIGRATION });
  if (checkpoint?.status === "complete") {
    console.log("Migration already completed. Use --restart to verify from the beginning.");
    return;
  }
  let lastUserId = checkpoint?.lastUserId || null;
  let processed = checkpoint?.processed || 0;
  let updatedRecords = checkpoint?.updatedRecords || 0;
  let createdProfiles = 0;
  console.log(JSON.stringify({ event: "family_care_backfill_started", dryRun, batchSize, resumedAfter: lastUserId }));
  while (true) {
    const query = lastUserId ? { _id: { $gt: lastUserId } } : {};
    const users = await User.find(query).sort({ _id: 1 }).limit(batchSize);
    if (!users.length) break;
    for (const user of users) {
      const result = await backfillForUser(user);
      processed += 1;
      updatedRecords += result.updated;
      createdProfiles += result.profileCreated;
      lastUserId = user._id;
    }
    if (!dryRun) {
      checkpoint = await FamilyCareMigrationCheckpoint.findOneAndUpdate(
        { migration: MIGRATION },
        { $set: { lastUserId, processed, updatedRecords, status: "running", lastError: "" } },
        { upsert: true, new: true },
      );
    }
    console.log(JSON.stringify({ event: "family_care_backfill_batch", processed, updatedRecords, lastUserId }));
  }
  if (!dryRun) await FamilyCareMigrationCheckpoint.updateOne({ migration: MIGRATION }, { $set: { status: "complete", lastUserId, processed, updatedRecords } }, { upsert: true });
  console.log(JSON.stringify({ event: "family_care_backfill_complete", dryRun, processed, updatedRecords, wouldCreateProfiles: createdProfiles }));
};

run().catch(async (error) => {
  console.error(JSON.stringify({ event: "family_care_backfill_failed", message: error.message }));
  if (!dryRun && mongoose.connection.readyState === 1) await FamilyCareMigrationCheckpoint.updateOne({ migration: MIGRATION }, { $set: { status: "failed", lastError: String(error.message).slice(0, 500) } }, { upsert: true });
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
