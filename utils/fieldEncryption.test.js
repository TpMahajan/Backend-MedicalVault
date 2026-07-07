import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { decryptField, encryptField } from "./fieldEncryption.js";

const TEST_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";

describe("fieldEncryption", () => {
  const originalKey = process.env.DATA_ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.DATA_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = originalKey;
  });

  it("round-trips a value (regression: prefix contains a colon)", () => {
    const encrypted = encryptField("9876543210");
    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(decryptField(encrypted)).toBe("9876543210");
  });

  it("does not double-encrypt an already encrypted value", () => {
    const once = encryptField("hello");
    const twice = encryptField(once);
    expect(twice).toBe(once);
    expect(decryptField(twice)).toBe("hello");
  });

  it("passes through plain values and empties", () => {
    expect(decryptField("plain")).toBe("plain");
    expect(decryptField("")).toBe("");
    expect(encryptField("")).toBe("");
  });

  it("returns the original blob when decryption fails (never throws)", () => {
    expect(decryptField("enc:v1:AAAA:BBBB:CCCC")).toBe("enc:v1:AAAA:BBBB:CCCC");
  });
});
