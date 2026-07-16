import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// spawnSync is mocked at the module level so no test ever shells out to a
// real `firebase` CLI or the network. Each test configures the mock's
// return value directly.
const spawnSyncMock = jest.fn();
await jest.unstable_mockModule("child_process", () => ({
  spawnSync: spawnSyncMock,
}));

const {
  FirebaseDistributionError,
  resolveFirebaseConfig,
  validateFirebaseConfig,
  verifyAndroidAppIdMatchesPackage,
  buildReleaseNotes,
  findPriorFirebaseRelease,
  sanitizeCliFailureOutput,
  distributeToFirebase,
} = await import("./firebase-distribution.mjs");

const VALID_APP_ID = "1:1234567890:android:abcdef1234567890";

let tmpRoot;
let apkPath;

beforeEach(async () => {
  spawnSyncMock.mockReset();
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mv-firebase-dist-test-"));
  apkPath = path.join(tmpRoot, "1.0.24+24.apk");
  await fsp.writeFile(apkPath, Buffer.from([1, 2, 3, 4]));
  await fsp.writeFile(path.join(tmpRoot, "creds.json"), "{}");
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function baseParams(overrides = {}) {
  return {
    apkPath,
    packageName: "com.example.hello",
    versionName: "1.0.24",
    buildNumber: 24,
    sha256: "a".repeat(64),
    releaseNotes: "Some release notes",
    gitCommit: "abc123",
    releasedAtIst: "2026-07-16 18:30:00 IST",
    dryRun: false,
    env: {
      FIREBASE_ANDROID_APP_ID: VALID_APP_ID,
      FIREBASE_DISTRIBUTION_GROUPS: "qa-team",
      GOOGLE_APPLICATION_CREDENTIALS: path.join(tmpRoot, "creds.json"),
    },
    ...overrides,
  };
}

describe("resolveFirebaseConfig / validateFirebaseConfig", () => {
  it("flags a missing FIREBASE_ANDROID_APP_ID", () => {
    const config = resolveFirebaseConfig({});
    const problems = validateFirebaseConfig(config);
    expect(problems.some((p) => p.includes("FIREBASE_ANDROID_APP_ID"))).toBe(true);
  });

  it("flags missing authentication when neither credentials nor token are set", () => {
    const config = resolveFirebaseConfig({
      FIREBASE_ANDROID_APP_ID: VALID_APP_ID,
      FIREBASE_DISTRIBUTION_GROUPS: "qa-team",
    });
    const problems = validateFirebaseConfig(config);
    expect(problems.some((p) => p.includes("authentication"))).toBe(true);
  });

  it("flags missing tester groups/testers", () => {
    const config = resolveFirebaseConfig({
      FIREBASE_ANDROID_APP_ID: VALID_APP_ID,
      FIREBASE_TOKEN: "some-token",
    });
    const problems = validateFirebaseConfig(config);
    expect(problems.some((p) => p.includes("FIREBASE_DISTRIBUTION_GROUPS"))).toBe(true);
  });

  it("accepts a fully configured environment", () => {
    const config = resolveFirebaseConfig({
      FIREBASE_ANDROID_APP_ID: VALID_APP_ID,
      FIREBASE_DISTRIBUTION_GROUPS: "qa-team",
      FIREBASE_TOKEN: "some-token",
    });
    expect(validateFirebaseConfig(config)).toEqual([]);
  });
});

describe("verifyAndroidAppIdMatchesPackage", () => {
  it("accepts a well-formed Firebase Android app ID", () => {
    expect(() =>
      verifyAndroidAppIdMatchesPackage(VALID_APP_ID, "com.example.hello"),
    ).not.toThrow();
  });

  it("rejects a malformed app ID", () => {
    expect(() =>
      verifyAndroidAppIdMatchesPackage("not-an-app-id", "com.example.hello"),
    ).toThrow(FirebaseDistributionError);
  });
});

describe("buildReleaseNotes", () => {
  it("includes version, build, sha256, commit, and timestamp", () => {
    const notes = buildReleaseNotes({
      versionName: "1.0.24",
      buildNumber: 24,
      releaseNotes: "Fixed a bug",
      sha256: "deadbeef".repeat(8),
      gitCommit: "abc123",
      releasedAtIst: "2026-07-16 18:30:00 IST",
    });
    expect(notes).toContain("Medical Vault 1.0.24 (Build 24)");
    expect(notes).toContain("Fixed a bug");
    expect(notes).toContain("deadbeef".repeat(8));
    expect(notes).toContain("abc123");
    expect(notes).toContain("2026-07-16 18:30:00 IST");
  });
});

describe("sanitizeCliFailureOutput", () => {
  it("redacts long opaque alphanumeric tokens", () => {
    const output = "Error: invalid token ya29.a0AfH6SMBx7dQnotarealtoken1234567890abcd";
    const sanitized = sanitizeCliFailureOutput(output);
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).not.toContain("ya29.a0AfH6SMBx7dQnotarealtoken1234567890abcd");
  });

  it("keeps ordinary words readable", () => {
    const sanitized = sanitizeCliFailureOutput("Error: app not found");
    expect(sanitized).toContain("Error: app not found");
  });
});

describe("findPriorFirebaseRelease (duplicate-upload protection)", () => {
  it("returns null when the reports directory does not exist", async () => {
    const result = await findPriorFirebaseRelease({
      releaseReportsDir: path.join(tmpRoot, "does-not-exist"),
      versionName: "1.0.24",
      buildNumber: 24,
      sha256: "a".repeat(64),
    });
    expect(result).toBeNull();
  });

  it("finds a matching prior successful upload by version+build+sha256", async () => {
    const reportsDir = path.join(tmpRoot, "reports");
    await fsp.mkdir(reportsDir, { recursive: true });
    await fsp.writeFile(
      path.join(reportsDir, "1.0.24+24-report.json"),
      JSON.stringify({
        version: "1.0.24",
        buildNumber: 24,
        sha256: "a".repeat(64),
        firebaseDistribution: { status: "uploaded" },
      }),
    );
    const result = await findPriorFirebaseRelease({
      releaseReportsDir: reportsDir,
      versionName: "1.0.24",
      buildNumber: 24,
      sha256: "a".repeat(64),
    });
    expect(result).not.toBeNull();
    expect(result.file).toBe("1.0.24+24-report.json");
  });

  it("does not match a report with a different sha256", async () => {
    const reportsDir = path.join(tmpRoot, "reports2");
    await fsp.mkdir(reportsDir, { recursive: true });
    await fsp.writeFile(
      path.join(reportsDir, "report.json"),
      JSON.stringify({
        version: "1.0.24",
        buildNumber: 24,
        sha256: "b".repeat(64),
        firebaseDistribution: { status: "uploaded" },
      }),
    );
    const result = await findPriorFirebaseRelease({
      releaseReportsDir: reportsDir,
      versionName: "1.0.24",
      buildNumber: 24,
      sha256: "a".repeat(64),
    });
    expect(result).toBeNull();
  });

  it("ignores malformed JSON report files instead of throwing", async () => {
    const reportsDir = path.join(tmpRoot, "reports3");
    await fsp.mkdir(reportsDir, { recursive: true });
    await fsp.writeFile(path.join(reportsDir, "bad.json"), "{ not json");
    const result = await findPriorFirebaseRelease({
      releaseReportsDir: reportsDir,
      versionName: "1.0.24",
      buildNumber: 24,
      sha256: "a".repeat(64),
    });
    expect(result).toBeNull();
  });
});

describe("distributeToFirebase", () => {
  it("throws when configuration is incomplete", async () => {
    await expect(
      distributeToFirebase(baseParams({ env: {} })),
    ).rejects.toThrow(FirebaseDistributionError);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("throws when the APK file is missing", async () => {
    await expect(
      distributeToFirebase(
        baseParams({ apkPath: path.join(tmpRoot, "does-not-exist.apk") }),
      ),
    ).rejects.toThrow(FirebaseDistributionError);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("never invokes the Firebase CLI under --dry-run", async () => {
    const result = await distributeToFirebase(baseParams({ dryRun: true }));
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("dry-run-skipped");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("passes the correct APK path, app ID, groups, and release-notes file to the CLI", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "Uploaded release. https://console.firebase.google.com/project/x/y",
      stderr: "",
    });

    await distributeToFirebase(baseParams());

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnSyncMock.mock.calls[0];
    expect(command).toMatch(/npx/);
    expect(args).toEqual(
      expect.arrayContaining([
        "appdistribution:distribute",
        apkPath,
        "--app",
        VALID_APP_ID,
        "--groups",
        "qa-team",
        "--release-notes-file",
      ]),
    );
    const notesFileIndex = args.indexOf("--release-notes-file") + 1;
    const notesFilePath = args[notesFileIndex];
    expect(fs.existsSync(notesFilePath)).toBe(false); // cleaned up after upload
  });

  it("supports firebase-testers override in addition to groups", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    await distributeToFirebase(
      baseParams({ testersOverride: "tester@example.com" }),
    );
    const [, args] = spawnSyncMock.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining(["--testers", "tester@example.com"]),
    );
  });

  it("throws FirebaseDistributionError when the CLI exits non-zero", async () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Error: app not found",
    });
    await expect(distributeToFirebase(baseParams())).rejects.toThrow(
      FirebaseDistributionError,
    );
  });

  it("never prints or retains raw credential/token env values on failure", async () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Auth failed with token ya29.a0somethingsomething1234567890abcdefghij",
    });
    let caught;
    try {
      await distributeToFirebase(baseParams());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FirebaseDistributionError);
    expect(caught.message).not.toContain("ya29.a0somethingsomething1234567890abcdefghij");
  });

  it("blocks a duplicate upload of the same version+build+sha256 without --force-firebase-reupload", async () => {
    const reportsDir = path.join(tmpRoot, "reports-dup");
    await fsp.mkdir(reportsDir, { recursive: true });
    await fsp.writeFile(
      path.join(reportsDir, "prior.json"),
      JSON.stringify({
        version: "1.0.24",
        buildNumber: 24,
        sha256: "a".repeat(64),
        firebaseDistribution: { status: "uploaded" },
      }),
    );
    await expect(
      distributeToFirebase(baseParams({ releaseReportsDir: reportsDir })),
    ).rejects.toThrow(/already uploaded/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("allows a forced re-upload of the same version+build+sha256 with forceReupload", async () => {
    const reportsDir = path.join(tmpRoot, "reports-force");
    await fsp.mkdir(reportsDir, { recursive: true });
    await fsp.writeFile(
      path.join(reportsDir, "prior.json"),
      JSON.stringify({
        version: "1.0.24",
        buildNumber: 24,
        sha256: "a".repeat(64),
        firebaseDistribution: { status: "uploaded" },
      }),
    );
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const result = await distributeToFirebase(
      baseParams({ releaseReportsDir: reportsDir, forceReupload: true }),
    );
    expect(result.status).toBe("uploaded");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("retries cleanly: a failed attempt followed by a successful retry both use the same APK", async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "transient error" });
    await expect(distributeToFirebase(baseParams())).rejects.toThrow(
      FirebaseDistributionError,
    );

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const result = await distributeToFirebase(baseParams());
    expect(result.ok).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    const secondCallArgs = spawnSyncMock.mock.calls[1][1];
    expect(secondCallArgs).toContain(apkPath);
  });
});
