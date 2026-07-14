import { describe, expect, it } from "@jest/globals";

process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const { PatientProfile } = await import("./PatientProfile.js");

describe("PatientProfile encrypted contact fields", () => {
  it("accepts an encrypted emergency phone envelope while retaining the plaintext length limit at the controller boundary", async () => {
    const profile = new PatientProfile({
      primaryOwnerUserId: "507f1f77bcf86cd799439011",
      createdBy: "507f1f77bcf86cd799439011",
      updatedBy: "507f1f77bcf86cd799439011",
      profileType: "managed",
      displayName: "Test dependent",
      emergencyContact: { phone: "+91 98765 43210" },
    });
    await expect(profile.validate()).resolves.toBeUndefined();
    const stored = profile.toObject({ getters: false }).emergencyContact.phone;
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored.length).toBeGreaterThan(32);
    expect(profile.emergencyContact.phone).toBe("+91 98765 43210");
  });
});
