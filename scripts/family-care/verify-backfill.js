import mongoose from "mongoose";
import dotenv from "dotenv";
import { User } from "../../models/User.js";
import { PatientProfile } from "../../models/PatientProfile.js";
import { CareRelationship } from "../../models/CareRelationship.js";
import { Document } from "../../models/File.js";
import { Appointment } from "../../models/Appointment.js";

dotenv.config();
dotenv.config({ path: "./db.env" });

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI is required");
  await mongoose.connect(uri, { dbName: "healthvault", family: 4 });
  const [users, selfProfiles, owners, usersMissingProfile, duplicateProfiles, documentsMissingProfile, appointmentsMissingProfile] = await Promise.all([
    User.countDocuments(),
    PatientProfile.countDocuments({ profileType: "self" }),
    CareRelationship.countDocuments({ role: "owner", status: "active" }),
    User.countDocuments({ selfPatientProfileId: null }),
    PatientProfile.aggregate([{ $match: { profileType: "self" } }, { $group: { _id: "$identityUserId", count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $count: "count" }]),
    Document.countDocuments({ patientProfileId: null }),
    Appointment.countDocuments({ patientProfileId: null }),
  ]);
  const result = { users, selfProfiles, activeOwnerRelationships: owners, usersMissingProfile, duplicateSelfProfileUsers: duplicateProfiles[0]?.count || 0, documentsMissingProfile, appointmentsMissingProfile };
  result.valid = usersMissingProfile === 0 && result.duplicateSelfProfileUsers === 0 && documentsMissingProfile === 0 && appointmentsMissingProfile === 0;
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 2;
};

run().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
