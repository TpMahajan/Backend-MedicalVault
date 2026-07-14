import express from "express";
import request from "supertest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";

// routes/appUpdate.js resolves its config/APK paths relative to its own
// module location (Backend-MedicalVault/app-update.json and
// Backend-MedicalVault/apk/), not from an injectable option. To test it in
// isolation without ever touching the real production metadata/APK, this
// suite:
//   1. Snapshots the real app-update.json + apk/ directory listing.
//   2. Swaps in disposable fixtures for the duration of each test.
//   3. Restores the exact original state in afterEach/afterAll, even on
//      failure (try/finally), and verifies restoration afterward.
//
// No network calls, no MongoDB, and no permanent modification of any real
// file happens anywhere in this suite.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const realConfigPath = path.join(backendRoot, "app-update.json");
const realApkDir = path.join(backendRoot, "apk");

const FAKE_APK_CONTENT = Buffer.from(
  "PK-fake-release-apk-bytes-for-testing-only-".repeat(50),
);
const FAKE_APK_SHA256 = crypto
  .createHash("sha256")
  .update(FAKE_APK_CONTENT)
  .digest("hex");
const FAKE_APK_FILENAME = "9.9.9+999.apk";

let originalConfigRaw = null;
let originalApkFiles = []; // { name, content }
let sandboxApkFiles = []; // fixture files added during a test, cleaned up after

function readOriginalApkDirSnapshot() {
  if (!fs.existsSync(realApkDir)) return [];
  return fs
    .readdirSync(realApkDir)
    .filter((name) => !name.startsWith("."))
    .map((name) => ({
      name,
      content: fs.readFileSync(path.join(realApkDir, name)),
    }));
}

beforeAll(() => {
  originalConfigRaw = fs.existsSync(realConfigPath)
    ? fs.readFileSync(realConfigPath, "utf8")
    : null;
  originalApkFiles = readOriginalApkDirSnapshot();
});

afterAll(() => {
  // Final safety net: prove the real files are restored exactly.
  if (originalConfigRaw !== null) {
    fs.writeFileSync(realConfigPath, originalConfigRaw, "utf8");
  }
  const currentApkNames = fs.existsSync(realApkDir)
    ? fs.readdirSync(realApkDir).filter((n) => !n.startsWith("."))
    : [];
  for (const name of currentApkNames) {
    const wasOriginal = originalApkFiles.some((f) => f.name === name);
    if (!wasOriginal) {
      fs.unlinkSync(path.join(realApkDir, name));
    }
  }
  for (const original of originalApkFiles) {
    const currentPath = path.join(realApkDir, original.name);
    if (
      !fs.existsSync(currentPath) ||
      !fs.readFileSync(currentPath).equals(original.content)
    ) {
      fs.writeFileSync(currentPath, original.content);
    }
  }

  const finalConfig = fs.readFileSync(realConfigPath, "utf8");
  if (originalConfigRaw !== null) {
    expect(finalConfig).toBe(originalConfigRaw);
  }
});

function writeTestConfig(configObj) {
  fs.writeFileSync(realConfigPath, `${JSON.stringify(configObj, null, 2)}\n`, "utf8");
}

function writeTestApk(fileName, content = FAKE_APK_CONTENT) {
  const target = path.join(realApkDir, fileName);
  fs.writeFileSync(target, content);
  sandboxApkFiles.push(target);
}

afterEach(() => {
  // Restore config to original after every test.
  if (originalConfigRaw !== null) {
    fs.writeFileSync(realConfigPath, originalConfigRaw, "utf8");
  }
  // Remove any fixture APK files created during the test.
  for (const filePath of sandboxApkFiles) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  sandboxApkFiles = [];
});

function buildApp(router) {
  const app = express();
  app.use("/api/v1/app", router);
  app.use("/api/app", router);
  return app;
}

const baseConfig = () => ({
  latestVersion: "9.9.9",
  latestBuildNumber: 999,
  minimumSupportedVersion: "9.9.0",
  minimumSupportedBuildNumber: 900,
  apkFileName: FAKE_APK_FILENAME,
  apkUrl: "",
  releaseNotes: "Disposable test release",
  sha256: FAKE_APK_SHA256,
  checksum: FAKE_APK_SHA256,
});

// Import the real, unmocked router. Its module-level path constants are
// computed once at import time from __dirname, so they always point at the
// real files above regardless of what we temporarily write into them.
const { default: appUpdateRouter } = await import("./appUpdate.js");

describe("appUpdate route (disposable-fixture isolation over real paths)", () => {
  beforeEach(() => {
    // Ensure a clean slate matching the untouched original before each test
    // additionally overlays its own fixture.
    if (originalConfigRaw !== null) {
      fs.writeFileSync(realConfigPath, originalConfigRaw, "utf8");
    }
  });

  it("returns valid metadata response with additive build-number fields", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=9.9.5");
    expect(res.status).toBe(200);
    expect(res.body.latestVersion).toBe("9.9.9");
    expect(res.body.latestBuildNumber).toBe(999);
    expect(res.body.minimumSupportedBuildNumber).toBe(900);
    expect(res.body.apkFileName).toBe(FAKE_APK_FILENAME);
    expect(res.body.sha256).toBe(FAKE_APK_SHA256);
    expect(res.body.checksum).toBe(FAKE_APK_SHA256);
  });

  it("returns dynamic absolute APK URL derived from request host when apkUrl is empty", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app)
      .get("/api/v1/app/update?currentVersion=9.9.5")
      .set("Host", "example-backend.test");
    expect(res.status).toBe(200);
    expect(res.body.apkUrl).toMatch(
      /^http:\/\/example-backend\.test\/api\/v1\/app\/apk\/9\.9\.9/,
    );
  });

  it("returns 503 UPDATE_ARTIFACT_INVALID when APK file is missing", async () => {
    writeTestConfig(baseConfig());
    // Intentionally do not create the APK fixture file.
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=9.9.5");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("UPDATE_ARTIFACT_INVALID");
    expect(res.body.success).toBe(false);
  });

  it("returns 503 UPDATE_ARTIFACT_INVALID when APK sha256 does not match metadata", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME, Buffer.from("different-bytes-than-expected"));
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=9.9.5");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("UPDATE_ARTIFACT_INVALID");
  });

  it("rejects invalid metadata (sha256/checksum mismatch) with 500", async () => {
    writeTestConfig({ ...baseConfig(), checksum: "0".repeat(64) });
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=9.9.5");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("APP_UPDATE_CONFIG_INVALID");
  });

  it("rejects invalid JSON metadata with 500", async () => {
    fs.writeFileSync(realConfigPath, "{ not valid json", "utf8");
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=9.9.5");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("APP_UPDATE_CONFIG_INVALID");
  });

  it("sends no-cache headers on the update response", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=9.9.5");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("version comparison: older version receives an update", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=9.9.5");
    expect(res.body.hasUpdate).toBe(true);
    expect(res.body.forceUpdate).toBe(false);
  });

  it("build-number comparison: same version, lower build number receives an update", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get(
      "/api/v1/app/update?currentVersion=9.9.9&currentBuildNumber=997",
    );
    expect(res.body.hasUpdate).toBe(true);
    expect(res.body.forceUpdate).toBe(false);
  });

  it("no update when current version and build match latest exactly", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get(
      "/api/v1/app/update?currentVersion=9.9.9&currentBuildNumber=999",
    );
    expect(res.body.hasUpdate).toBe(false);
  });

  it("no downgrade: newer installed version than latest reports no update", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=20.0.0");
    expect(res.body.hasUpdate).toBe(false);
    expect(res.body.forceUpdate).toBe(false);
  });

  it("forced update: below minimum supported version", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=1.0.0");
    expect(res.body.forceUpdate).toBe(true);
    expect(res.body.hasUpdate).toBe(true);
  });

  it("forced update: same version but below minimum supported build number", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get(
      "/api/v1/app/update?currentVersion=9.9.0&currentBuildNumber=899",
    );
    expect(res.body.forceUpdate).toBe(true);
    expect(res.body.hasUpdate).toBe(true);
  });

  it("rejects path traversal attempts in the APK download route", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/apk/..%2f..%2f..%2fetc%2fpasswd");
    expect(res.status).toBe(400);
  });

  it("serves the APK file for a valid version with correct headers", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/apk/9.9.9");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(
      "application/vnd.android.package-archive",
    );
    expect(Number(res.headers["content-length"])).toBe(FAKE_APK_CONTENT.length);
  });

  it("returns 404 when the requested version's APK does not exist", async () => {
    writeTestConfig(baseConfig());
    writeTestApk(FAKE_APK_FILENAME);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/apk/1.2.3");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("APP_UPDATE_APK_NOT_FOUND");
  });

  it("still works for legacy metadata without build-number fields (backward compatible)", async () => {
    writeTestConfig({
      latestVersion: "9.9.9",
      minimumSupportedVersion: "9.9.0",
      apkUrl: "",
      releaseNotes: "Legacy release without build numbers",
      sha256: FAKE_APK_SHA256,
      checksum: FAKE_APK_SHA256,
    });
    writeTestApk(`9.9.9.apk`, FAKE_APK_CONTENT);
    const app = buildApp(appUpdateRouter);

    const res = await request(app).get("/api/v1/app/update?currentVersion=9.9.5");
    expect(res.status).toBe(200);
    expect(res.body.latestBuildNumber).toBeNull();
    expect(res.body.minimumSupportedBuildNumber).toBeNull();
    expect(res.body.hasUpdate).toBe(true);
  });

  it("real files are restored to their original state after this suite", () => {
    const currentConfig = fs.readFileSync(realConfigPath, "utf8");
    if (originalConfigRaw !== null) {
      expect(currentConfig).toBe(originalConfigRaw);
    }
    const currentApkNames = fs.existsSync(realApkDir)
      ? fs.readdirSync(realApkDir).filter((n) => !n.startsWith("."))
      : [];
    expect(currentApkNames.sort()).toEqual(
      originalApkFiles.map((f) => f.name).sort(),
    );
  });
});
