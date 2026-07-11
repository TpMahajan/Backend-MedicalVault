/**
 * Removes only fields and records created by family-care-self-profile-v1.
 * Defaults to dry-run. Pass --apply and the exact confirmation phrase.
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

dotenv.config();
dotenv.config({ path: "./db.env" });
const apply = process.argv.includes("--apply") && process.argv.includes("--confirm=ROLLBACK_FAMILY_CARE_V1");

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI is required");
  await mongoose.connect(uri, { dbName: "healthvault", family: 4 });
  const profiles = await PatientProfile.find({ migrationKey: /^self:/ }).select("_id identityUserId").lean();
  const profileIds = profiles.map((profile) => profile._id);
  const summary = {
    mode: apply ? "APPLY" : "DRY_RUN",
    profiles: profiles.length,
    relationships: await CareRelationship.countDocuments({ migrationKey: /^self:/ }),
    documents: await Document.countDocuments({ patientProfileId: { $in: profileIds } }),
    appointments: await Appointment.countDocuments({ patientProfileId: { $in: profileIds } }),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log("No changes made. To apply: --apply --confirm=ROLLBACK_FAMILY_CARE_V1");
    return;
  }
  await Promise.all([
    User.updateMany({ selfPatientProfileId: { $in: profileIds } }, { $unset: { selfPatientProfileId: "" } }),
    Document.updateMany({ patientProfileId: { $in: profileIds } }, { $unset: { patientProfileId: "", uploadedByUserId: "" } }),
    Appointment.updateMany({ patientProfileId: { $in: profileIds } }, { $unset: { patientProfileId: "", createdByUserId: "", managedByCaregiverUserId: "" } }),
    Session.updateMany({ patientProfileId: { $in: profileIds } }, { $unset: { patientProfileId: "" } }),
    QRCode.updateMany({ patientProfileId: { $in: profileIds } }, { $unset: { patientProfileId: "" } }),
    SOS.updateMany({ patientProfileId: { $in: profileIds } }, { $unset: { patientProfileId: "" } }),
    Notification.updateMany({ patientProfileId: { $in: profileIds } }, { $unset: { patientProfileId: "" } }),
  ]);
  await CareRelationship.deleteMany({ migrationKey: /^self:/ });
  await PatientProfile.deleteMany({ migrationKey: /^self:/ });
  await FamilyCareMigrationCheckpoint.deleteOne({ migration: "family-care-self-profile-v1" });
  console.log("Rollback complete.");
};

run().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
