import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const loadPolicy = async ({ credentials } = {}) => {
  jest.resetModules();
  jest.unstable_mockModule("../config/s3.js", () => ({
    default: {
      config: {
        credentials: credentials === undefined ? null : credentials,
      },
    },
    BUCKET_NAME: "test-bucket",
    REGION: "test-region",
  }));
  return import("./uploadStoragePolicy.js");
};

const validCredentialProvider = async () => ({
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret",
});

describe("uploadStoragePolicy", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFallbackFlag = process.env.ALLOW_LOCAL_UPLOAD_FALLBACK;

  beforeEach(() => {
    delete process.env.ALLOW_LOCAL_UPLOAD_FALLBACK;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalFallbackFlag === undefined) {
      delete process.env.ALLOW_LOCAL_UPLOAD_FALLBACK;
    } else {
      process.env.ALLOW_LOCAL_UPLOAD_FALLBACK = originalFallbackFlag;
    }
  });

  it("selects S3 whenever credentials resolve", async () => {
    process.env.NODE_ENV = "production";
    const policy = await loadPolicy({ credentials: validCredentialProvider });
    await expect(policy.resolveUploadStorage("test")).resolves.toBe("s3");
  });

  it("falls back to local storage in development when S3 is missing", async () => {
    process.env.NODE_ENV = "development";
    const policy = await loadPolicy({ credentials: null });
    await expect(policy.resolveUploadStorage("test")).resolves.toBe("local");
  });

  it("rejects uploads in production when S3 is missing (no silent local fallback)", async () => {
    process.env.NODE_ENV = "production";
    const policy = await loadPolicy({ credentials: null });
    await expect(policy.resolveUploadStorage("test")).rejects.toMatchObject({
      name: "UploadStorageUnavailableError",
      statusCode: 503,
    });
  });

  it("honors ALLOW_LOCAL_UPLOAD_FALLBACK=true in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_LOCAL_UPLOAD_FALLBACK = "true";
    const policy = await loadPolicy({ credentials: null });
    await expect(policy.resolveUploadStorage("test")).resolves.toBe("local");
  });

  it("honors ALLOW_LOCAL_UPLOAD_FALLBACK=false in development", async () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_LOCAL_UPLOAD_FALLBACK = "false";
    const policy = await loadPolicy({ credentials: null });
    await expect(policy.resolveUploadStorage("test")).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("treats a rejecting credential provider as missing S3", async () => {
    process.env.NODE_ENV = "development";
    const policy = await loadPolicy({
      credentials: async () => {
        throw new Error("Could not load credentials from any providers");
      },
    });
    await expect(policy.resolveUploadStorage("test")).resolves.toBe("local");
  });
});
