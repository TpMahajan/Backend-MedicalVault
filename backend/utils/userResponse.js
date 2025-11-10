import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import s3Client, { BUCKET_NAME } from "../config/s3.js";

const PROFILE_URL_TTL_SECONDS = Number(process.env.PROFILE_PIC_URL_TTL || 3600);

const toPlainObject = (doc) => {
  if (!doc) return null;
  if (typeof doc.toObject === "function") {
    return doc.toObject({ getters: true, virtuals: true });
  }
  return { ...doc };
};

export const buildUserResponse = async (doc) => {
  const plain = toPlainObject(doc);
  if (!plain) return null;

  const user = {
    id: (plain._id || plain.id)?.toString?.() ?? plain.id ?? null,
    name: plain.name ?? "",
    email: plain.email ?? "",
    mobile: plain.mobile ?? "",
    aadhaar: plain.aadhaar ?? "",
    dateOfBirth: plain.dateOfBirth ?? null,
    age: plain.age ?? null,
    gender: plain.gender ?? "",
    bloodType: plain.bloodType ?? "",
    height: plain.height ?? "",
    weight: plain.weight ?? "",
    lastVisit: plain.lastVisit ?? null,
    nextAppointment: plain.nextAppointment ?? null,
    emergencyContact: plain.emergencyContact ?? {},
    medicalHistory: plain.medicalHistory ?? [],
    medications: plain.medications ?? [],
    medicalRecords: plain.medicalRecords ?? [],
    profilePicture: plain.profilePicture ?? null,
    allergies: plain.allergies ?? "",
    emailVerified: plain.emailVerified ?? false,
    loginType: plain.loginType ?? "email",
    googleId: plain.googleId ?? null,
  };

  if (plain.profilePicture) {
    if (
      typeof plain.profilePicture === "string" &&
      (plain.profilePicture.startsWith("http://") ||
        plain.profilePicture.startsWith("https://"))
    ) {
      user.profilePictureUrl = plain.profilePicture;
      return user;
    }
    try {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: plain.profilePicture,
      });
      user.profilePictureUrl = await getSignedUrl(
        s3Client,
        command,
        { expiresIn: PROFILE_URL_TTL_SECONDS },
      );
    } catch (error) {
      console.error(
        "Failed to generate signed profile picture URL:",
        error.message || error,
      );
    }
  }

  return user;
};


