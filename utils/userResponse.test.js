import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("../config/s3.js", () => ({
  default: { config: { credentials: null } },
  BUCKET_NAME: "test-bucket",
  REGION: "test-region",
}));
jest.unstable_mockModule("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(async () => "https://signed.example/url"),
}));

const TEST_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";

const { buildUserResponse } = await import("./userResponse.js");
const { encryptField } = await import("./fieldEncryption.js");

describe("buildUserResponse emergency contact", () => {
  const originalKey = process.env.DATA_ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.DATA_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = originalKey;
  });

  it("returns emergencyContact as an object with name/relationship/phone", async () => {
    const user = await buildUserResponse({
      _id: "user-1",
      name: "Asha",
      emergencyContact: {
        name: "Ravi",
        relationship: "Brother",
        phone: "9876543210",
      },
    });

    expect(user.emergencyContact).toMatchObject({
      name: "Ravi",
      relationship: "Brother",
      phone: "9876543210",
    });
  });

  it("resolves phone from mobile/number aliases", async () => {
    const user = await buildUserResponse({
      _id: "user-2",
      emergencyContact: { name: "Ravi", mobile: "9998887776" },
    });

    expect(user.emergencyContact.phone).toBe("9998887776");
  });

  it("decrypts an encrypted emergency phone", async () => {
    const encrypted = encryptField("9123456780");
    expect(encrypted.startsWith("enc:v1:")).toBe(true);

    const user = await buildUserResponse({
      _id: "user-3",
      emergencyContact: { name: "Ravi", phone: encrypted },
    });

    expect(user.emergencyContact.phone).toBe("9123456780");
  });

  it("never leaks an undecryptable blob to the client", async () => {
    const foreignBlob = "enc:v1:AAAA:BBBB:CCCC"; // wrong key / corrupt
    const user = await buildUserResponse({
      _id: "user-4",
      emergencyContact: { name: "Ravi", phone: foreignBlob },
    });

    expect(user.emergencyContact.phone).toBe("");
  });

  it("returns an empty-contact object when emergency contact is cleared", async () => {
    const user = await buildUserResponse({
      _id: "user-5",
      emergencyContact: { name: null, relationship: null, phone: null },
    });

    expect(user.emergencyContact.phone).toBe("");
    expect(user.emergencyContact.name).toBeNull();
  });
});
