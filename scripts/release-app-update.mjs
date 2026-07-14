#!/usr/bin/env node
/**
 * Medical Vault - Canonical in-app update release tool.
 *
 * This is the single source of truth for preparing, verifying, and
 * (optionally) releasing a new Android app-update payload. All other
 * scripts (compute-apk-sha256.ps1 / .sh) are thin wrappers around this file.
 *
 * All paths are resolved relative to THIS FILE's location (repository
 * layout), never relative to the caller's current working directory.
 *
 * Commands:
 *   prepare       - resolve version/build, verify APK manifest, copy APK,
 *                    compute SHA-256, atomically update app-update.json.
 *   verify-local  - start an isolated (no-DB) Express harness serving the
 *                    real appUpdate route + real app-update.json/apk dir,
 *                    then exercise it exactly like a client would.
 *   verify-remote - read-only verification against a deployed backend
 *                    (e.g. the real Render URL). Never mutates anything.
 *   release       - prepare, then (optionally, if --deploy-render and
 *                    RENDER_DEPLOY_HOOK_URL are both present) trigger a
 *                    Render deploy hook, poll until live, and verify remote.
 *
 * Exit codes:
 *   0  success
 *   1  fatal error (validation failure, IO failure, assertion failure)
 *   2  "release-pending" - local prep succeeded but remote deployment was
 *      not triggered (no --deploy-render or no RENDER_DEPLOY_HOOK_URL).
 */

import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import http from "http";
import https from "https";

// ---------------------------------------------------------------------------
// Path resolution (repository-relative, never CWD-relative)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, ".."); // Backend-MedicalVault
const REPO_ROOT = path.resolve(BACKEND_ROOT, ".."); // Medical Vault
const DEFAULT_FLUTTER_ROOT = path.join(REPO_ROOT, "MedicalVault");
const DEFAULT_PUBSPEC_PATH = path.join(DEFAULT_FLUTTER_ROOT, "pubspec.yaml");
const DEFAULT_FLUTTER_APK_PATH = path.join(
  DEFAULT_FLUTTER_ROOT,
  "build",
  "app",
  "outputs",
  "flutter-apk",
  "app-release.apk",
);
const DEFAULT_APK_DIR = path.join(BACKEND_ROOT, "apk");
const DEFAULT_METADATA_PATH = path.join(BACKEND_ROOT, "app-update.json");
const DEFAULT_RELEASE_REPORTS_DIR = path.join(
  BACKEND_ROOT,
  "release-reports",
  "app-update",
);
const ANDROID_BUILD_GRADLE_PATH = path.join(
  DEFAULT_FLUTTER_ROOT,
  "android",
  "app",
  "build.gradle",
);

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

class ReleaseToolError extends Error {
  constructor(message, { code = "RELEASE_TOOL_ERROR" } = {}) {
    super(message);
    this.name = "ReleaseToolError";
    this.code = code;
  }
}

function log(...args) {
  console.log(...args);
}

function warn(...args) {
  console.warn(...args);
}

function nowIso() {
  return new Date().toISOString();
}

/** Format a Date as an IST (Asia/Kolkata) timestamp string, filename-safe. */
function formatIst(date, { forFilename = false } = {}) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const h = get("hour");
  const mi = get("minute");
  const s = get("second");
  if (forFilename) {
    return `${y}${mo}${d}T${h}${mi}${s}IST`;
  }
  return `${y}-${mo}-${d} ${h}:${mi}:${s} IST`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const boolFlags = new Set(["deploy-render", "skip-build", "dry-run"]);
    if (boolFlags.has(key)) {
      args[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true; // treat as boolean toggle if no value follows
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

async function filesAreByteIdentical(pathA, pathB) {
  const [statA, statB] = await Promise.all([fsp.stat(pathA), fsp.stat(pathB)]);
  if (statA.size !== statB.size) return false;
  const [hashA, hashB] = await Promise.all([sha256File(pathA), sha256File(pathB)]);
  return hashA === hashB;
}

/** Strip BOM, parse JSON, throw ReleaseToolError with context on failure. */
function parseJsonStrict(raw, context) {
  const normalized = raw.replace(/^﻿/, "");
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new ReleaseToolError(
      `Invalid JSON in ${context}: ${error.message}`,
      { code: "INVALID_JSON" },
    );
  }
}

/** Atomic write: temp file in the same directory, fsync, rename over target. */
async function atomicWriteFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  const handle = await fsp.open(tmpPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmpPath, targetPath);
}

// ---------------------------------------------------------------------------
// Version / build-number resolution
// ---------------------------------------------------------------------------

function readPubspecVersion(pubspecPath) {
  if (!fs.existsSync(pubspecPath)) {
    throw new ReleaseToolError(`pubspec.yaml not found at ${pubspecPath}`, {
      code: "PUBSPEC_NOT_FOUND",
    });
  }
  const raw = fs.readFileSync(pubspecPath, "utf8");
  const match = raw.match(/^\s*version\s*:\s*([0-9A-Za-z._+-]+)\s*$/m);
  if (!match) {
    throw new ReleaseToolError(
      `Could not read "version:" from ${pubspecPath}`,
      { code: "PUBSPEC_VERSION_MISSING" },
    );
  }
  const full = match[1].trim();
  const [versionName, buildNumberRaw] = full.split("+");
  if (!versionName) {
    throw new ReleaseToolError(`Malformed version in pubspec.yaml: "${full}"`, {
      code: "PUBSPEC_VERSION_MALFORMED",
    });
  }
  if (!buildNumberRaw || !/^\d+$/.test(buildNumberRaw)) {
    throw new ReleaseToolError(
      `pubspec.yaml version "${full}" is missing a numeric build number ` +
        `(expected form "x.y.z+N")`,
      { code: "PUBSPEC_BUILD_NUMBER_MISSING" },
    );
  }
  return {
    versionName: versionName.trim(),
    buildNumber: Number.parseInt(buildNumberRaw, 10),
  };
}

function readAndroidApplicationId(buildGradlePath) {
  if (!fs.existsSync(buildGradlePath)) return null;
  const raw = fs.readFileSync(buildGradlePath, "utf8");
  const match = raw.match(/applicationId\s*=?\s*["']([^"']+)["']/);
  return match ? match[1].trim() : null;
}

function parseVersionSegments(version) {
  return String(version || "")
    .trim()
    .split(".")
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s.replace(/[^\d]/g, ""), 10) || 0);
}

function compareVersions(left, right) {
  const l = parseVersionSegments(left);
  const r = parseVersionSegments(right);
  const max = Math.max(l.length, r.length);
  for (let i = 0; i < max; i += 1) {
    const a = l[i] || 0;
    const b = r[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function isValidDottedVersion(version) {
  return VERSION_REGEX.test(String(version || "").trim());
}

// ---------------------------------------------------------------------------
// app-update.json load/validate
// ---------------------------------------------------------------------------

function loadMetadataRaw(metadataPath) {
  if (!fs.existsSync(metadataPath)) {
    throw new ReleaseToolError(`app-update.json not found at ${metadataPath}`, {
      code: "METADATA_NOT_FOUND",
    });
  }
  const raw = fs.readFileSync(metadataPath, "utf8");
  return parseJsonStrict(raw, metadataPath);
}

function validateMetadataShape(config, context) {
  const errors = [];
  if (!isValidDottedVersion(config.latestVersion)) {
    errors.push("latestVersion must be an x.y.z dotted numeric version");
  }
  if (!isValidDottedVersion(config.minimumSupportedVersion)) {
    errors.push(
      "minimumSupportedVersion must be an x.y.z dotted numeric version",
    );
  }
  if (
    isValidDottedVersion(config.latestVersion) &&
    isValidDottedVersion(config.minimumSupportedVersion) &&
    compareVersions(config.minimumSupportedVersion, config.latestVersion) > 0
  ) {
    errors.push("minimumSupportedVersion cannot exceed latestVersion");
  }
  if (!SHA256_REGEX.test(String(config.sha256 || "").toLowerCase())) {
    errors.push("sha256 must be a 64-character lowercase hex string");
  }
  if (
    String(config.checksum || "").toLowerCase() !==
    String(config.sha256 || "").toLowerCase()
  ) {
    errors.push("checksum must equal sha256");
  }
  if (config.latestBuildNumber !== undefined) {
    if (
      !Number.isInteger(config.latestBuildNumber) ||
      config.latestBuildNumber <= 0
    ) {
      errors.push("latestBuildNumber must be a positive integer when present");
    }
  }
  if (config.minimumSupportedBuildNumber !== undefined) {
    if (
      !Number.isInteger(config.minimumSupportedBuildNumber) ||
      config.minimumSupportedBuildNumber <= 0
    ) {
      errors.push(
        "minimumSupportedBuildNumber must be a positive integer when present",
      );
    }
  }
  if (
    config.apkFileName &&
    (String(config.apkFileName).includes("/") ||
      String(config.apkFileName).includes("\\") ||
      !String(config.apkFileName).toLowerCase().endsWith(".apk"))
  ) {
    errors.push("apkFileName must be a plain *.apk filename with no path separators");
  }
  if (errors.length > 0) {
    throw new ReleaseToolError(
      `Invalid app-update.json (${context}):\n  - ${errors.join("\n  - ")}`,
      { code: "METADATA_INVALID" },
    );
  }
}

// ---------------------------------------------------------------------------
// APK manifest inspection (aapt / apkanalyzer)
// ---------------------------------------------------------------------------

function findAndroidSdkTool(toolNames) {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Library", "Android", "sdk"), // macOS default
    path.join(os.homedir(), "Android", "Sdk"), // Linux default
  ].filter(Boolean);

  for (const root of sdkRoots) {
    const buildToolsDir = path.join(root, "build-tools");
    if (!fs.existsSync(buildToolsDir)) continue;
    const versions = fs
      .readdirSync(buildToolsDir)
      .filter((v) => fs.statSync(path.join(buildToolsDir, v)).isDirectory())
      .sort()
      .reverse(); // newest first (lexicographic works for x.y.z build-tools dirs)
    for (const version of versions) {
      for (const toolName of toolNames) {
        const candidate = path.join(buildToolsDir, version, toolName);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    // apkanalyzer lives under cmdline-tools, not build-tools
    const cmdlineToolsDir = path.join(root, "cmdline-tools");
    if (fs.existsSync(cmdlineToolsDir)) {
      for (const sub of fs.readdirSync(cmdlineToolsDir)) {
        const candidate = path.join(cmdlineToolsDir, sub, "bin", "apkanalyzer");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Inspect an APK's manifest using aapt (preferred, ships with build-tools)
 * falling back to apkanalyzer. Returns { packageName, versionName, versionCode, raw }.
 */
function inspectApkManifest(apkPath) {
  const aaptPath = findAndroidSdkTool(["aapt", "aapt2"]);
  if (aaptPath) {
    const isAapt2 = path.basename(aaptPath).startsWith("aapt2");
    const cmd = isAapt2
      ? [aaptPath, "dump", "badging", apkPath]
      : [aaptPath, "dump", "badging", apkPath];
    let output;
    try {
      output = execFileSync(cmd[0], cmd.slice(1), {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      throw new ReleaseToolError(
        `aapt failed to read APK manifest for ${apkPath}: ${error.message}`,
        { code: "APK_MANIFEST_READ_FAILED" },
      );
    }
    const packageMatch = output.match(/package: name='([^']+)'/);
    const versionNameMatch = output.match(/versionName='([^']+)'/);
    const versionCodeMatch = output.match(/versionCode='([^']+)'/);
    const debuggableMatch = /application-debuggable/.test(output);
    return {
      tool: "aapt",
      packageName: packageMatch ? packageMatch[1] : null,
      versionName: versionNameMatch ? versionNameMatch[1] : null,
      versionCode: versionCodeMatch
        ? Number.parseInt(versionCodeMatch[1], 10)
        : null,
      debuggable: debuggableMatch,
      raw: output,
    };
  }

  const apkAnalyzerPath = findAndroidSdkTool(["apkanalyzer"]);
  if (apkAnalyzerPath) {
    let manifest;
    try {
      manifest = execFileSync(
        apkAnalyzerPath,
        ["manifest", "print", apkPath],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (error) {
      throw new ReleaseToolError(
        `apkanalyzer failed to read APK manifest for ${apkPath}: ${error.message}`,
        { code: "APK_MANIFEST_READ_FAILED" },
      );
    }
    const packageMatch = manifest.match(/package="([^"]+)"/);
    const versionNameMatch = manifest.match(/android:versionName="([^"]+)"/);
    const versionCodeMatch = manifest.match(/android:versionCode="([^"]+)"/);
    const debuggableMatch = /android:debuggable="true"/.test(manifest);
    return {
      tool: "apkanalyzer",
      packageName: packageMatch ? packageMatch[1] : null,
      versionName: versionNameMatch ? versionNameMatch[1] : null,
      versionCode: versionCodeMatch
        ? Number.parseInt(versionCodeMatch[1], 10)
        : null,
      debuggable: debuggableMatch,
      raw: manifest,
    };
  }

  return null; // neither tool available
}

async function verifyApkManifest({ apkPath, expectedVersionName, expectedBuildNumber, dryRun }) {
  const stat = await fsp.stat(apkPath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0) {
    throw new ReleaseToolError(
      `APK at ${apkPath} is missing or zero-length`,
      { code: "APK_MISSING_OR_EMPTY" },
    );
  }

  const manifest = inspectApkManifest(apkPath);
  if (!manifest) {
    const message =
      "Android build tools (aapt/aapt2/apkanalyzer) not found. Set " +
      "ANDROID_HOME or ANDROID_SDK_ROOT, or install Android SDK build-tools. " +
      "APK manifest verification is a required prerequisite in normal mode.";
    if (dryRun) {
      warn(`[WARN] ${message} Continuing because --dry-run was supplied.`);
      return {
        ok: false,
        skipped: true,
        reason: message,
      };
    }
    throw new ReleaseToolError(message, { code: "ANDROID_TOOLS_NOT_FOUND" });
  }

  const applicationId = readAndroidApplicationId(ANDROID_BUILD_GRADLE_PATH);
  const problems = [];
  if (applicationId && manifest.packageName && manifest.packageName !== applicationId) {
    problems.push(
      `package name mismatch: APK has "${manifest.packageName}", expected "${applicationId}"`,
    );
  }
  if (manifest.versionName && manifest.versionName !== expectedVersionName) {
    problems.push(
      `versionName mismatch: APK has "${manifest.versionName}", expected "${expectedVersionName}"`,
    );
  }
  if (
    manifest.versionCode !== null &&
    manifest.versionCode !== expectedBuildNumber
  ) {
    problems.push(
      `versionCode mismatch: APK has ${manifest.versionCode}, expected ${expectedBuildNumber}`,
    );
  }
  if (manifest.debuggable) {
    problems.push("APK is a debuggable build, not a release build");
  }

  if (problems.length > 0) {
    throw new ReleaseToolError(
      `APK manifest verification failed for ${apkPath} (via ${manifest.tool}):\n  - ${problems.join("\n  - ")}`,
      { code: "APK_MANIFEST_MISMATCH" },
    );
  }

  return {
    ok: true,
    tool: manifest.tool,
    packageName: manifest.packageName,
    versionName: manifest.versionName,
    versionCode: manifest.versionCode,
  };
}

// ---------------------------------------------------------------------------
// prepare command
// ---------------------------------------------------------------------------

async function resolveReleaseNotes(args) {
  if (args["release-notes-file"]) {
    const notesPath = path.isAbsolute(args["release-notes-file"])
      ? args["release-notes-file"]
      : path.resolve(process.cwd(), args["release-notes-file"]);
    if (!fs.existsSync(notesPath)) {
      throw new ReleaseToolError(
        `--release-notes-file not found: ${notesPath}`,
        { code: "RELEASE_NOTES_FILE_NOT_FOUND" },
      );
    }
    return fs.readFileSync(notesPath, "utf8").replace(/\r\n/g, "\n").trimEnd();
  }
  if (args["release-notes"]) {
    return String(args["release-notes"]).replace(/\\n/g, "\n");
  }
  return null; // caller decides whether to preserve existing notes
}

async function cmdPrepare(args) {
  const dryRun = Boolean(args["dry-run"]);
  const skipBuild = Boolean(args["skip-build"]); // reserved: this tool never invokes `flutter build`
  void skipBuild;

  const pubspecPath = DEFAULT_PUBSPEC_PATH;
  const { versionName: pubspecVersionName, buildNumber: pubspecBuildNumber } =
    readPubspecVersion(pubspecPath);

  const versionName = args.version ? String(args.version).trim() : pubspecVersionName;
  const buildNumber = args["build-number"]
    ? Number.parseInt(args["build-number"], 10)
    : pubspecBuildNumber;

  if (!isValidDottedVersion(versionName)) {
    throw new ReleaseToolError(
      `--version/pubspec version "${versionName}" must have exactly three numeric segments (x.y.z)`,
      { code: "VERSION_INVALID" },
    );
  }
  if (!Number.isInteger(buildNumber) || buildNumber <= 0) {
    throw new ReleaseToolError(
      `Build number "${buildNumber}" must be a positive integer`,
      { code: "BUILD_NUMBER_INVALID" },
    );
  }

  const metadataPath = DEFAULT_METADATA_PATH;
  const apkDir = DEFAULT_APK_DIR;
  const sourceApkPath = args.apk
    ? path.isAbsolute(args.apk)
      ? args.apk
      : path.resolve(process.cwd(), args.apk)
    : DEFAULT_FLUTTER_APK_PATH;

  if (!fs.existsSync(sourceApkPath)) {
    throw new ReleaseToolError(
      `Source APK not found at ${sourceApkPath}. Build it first with ` +
        `"flutter build apk --release" in ${DEFAULT_FLUTTER_ROOT}, or pass --apk <path>.`,
      { code: "SOURCE_APK_NOT_FOUND" },
    );
  }

  // Load existing metadata (if any) to enforce monotonicity + preserve fields.
  let existingConfig = null;
  if (fs.existsSync(metadataPath)) {
    existingConfig = loadMetadataRaw(metadataPath);
  }

  // An exact re-run with the identical version+build AND byte-identical
  // source APK is a deliberate idempotent no-op, not a downgrade attempt.
  // Only skip the monotonicity checks when both version and build number
  // are unchanged AND the bytes match; any other combination still goes
  // through full validation below.
  let isIdempotentRerun = false;
  if (existingConfig) {
    const existingVersion = String(existingConfig.latestVersion || "").trim();
    const existingBuild = Number.isInteger(existingConfig.latestBuildNumber)
      ? existingConfig.latestBuildNumber
      : null;

    if (
      existingVersion === versionName &&
      existingBuild === buildNumber &&
      existingConfig.apkFileName
    ) {
      const existingApkPath = path.join(apkDir, existingConfig.apkFileName);
      if (fs.existsSync(existingApkPath)) {
        isIdempotentRerun = await filesAreByteIdentical(sourceApkPath, existingApkPath);
      }
    }

    if (existingVersion && isValidDottedVersion(existingVersion) && !isIdempotentRerun) {
      const cmp = compareVersions(versionName, existingVersion);
      if (cmp < 0) {
        throw new ReleaseToolError(
          `New version ${versionName} is lower than currently published ${existingVersion}. Refusing to downgrade.`,
          { code: "VERSION_DOWNGRADE_REJECTED" },
        );
      }
      if (cmp === 0 && existingBuild !== null && buildNumber <= existingBuild) {
        throw new ReleaseToolError(
          `Version ${versionName} is unchanged; build number must increase ` +
            `(currently published buildNumber=${existingBuild}, got ${buildNumber}). ` +
            `If you intended to re-publish the exact same APK, this is only allowed when ` +
            `the source APK bytes are identical to the currently published artifact.`,
          { code: "BUILD_NUMBER_NOT_INCREASED" },
        );
      }
      if (cmp > 0 && existingBuild !== null && buildNumber < existingBuild) {
        throw new ReleaseToolError(
          `Build number ${buildNumber} is lower than currently published ${existingBuild}. Refusing to downgrade Android versionCode.`,
          { code: "BUILD_NUMBER_DOWNGRADE_REJECTED" },
        );
      }
    }
  }

  // --- APK manifest verification -------------------------------------------------
  const manifestResult = await verifyApkManifest({
    apkPath: sourceApkPath,
    expectedVersionName: versionName,
    expectedBuildNumber: buildNumber,
    dryRun,
  });

  // --- Copy: temp -> verify -> atomic rename --------------------------------------
  const canonicalFileName = `${versionName}+${buildNumber}.apk`;
  const destApkPath = path.join(apkDir, canonicalFileName);
  const sourceHash = await sha256File(sourceApkPath);
  const sourceStat = await fsp.stat(sourceApkPath);

  let apkChanged = true;
  if (!dryRun) {
    await fsp.mkdir(apkDir, { recursive: true });

    if (fs.existsSync(destApkPath)) {
      const identical = await filesAreByteIdentical(sourceApkPath, destApkPath);
      if (identical) {
        apkChanged = false;
        log(`[prepare] Destination APK already matches source byte-for-byte; reusing ${destApkPath}`);
      } else {
        throw new ReleaseToolError(
          `Destination APK ${destApkPath} already exists with DIFFERENT bytes than the ` +
            `source APK. Refusing to silently overwrite a published artifact. Remove it ` +
            `manually first if you intend to replace it.`,
          { code: "APK_DEST_CONFLICT" },
        );
      }
    } else {
      const tmpPath = path.join(
        apkDir,
        `.${canonicalFileName}.tmp-${process.pid}-${Date.now()}`,
      );
      await fsp.copyFile(sourceApkPath, tmpPath);
      const tmpStat = await fsp.stat(tmpPath);
      if (tmpStat.size !== sourceStat.size) {
        await fsp.unlink(tmpPath).catch(() => {});
        throw new ReleaseToolError(
          `Copied APK size (${tmpStat.size}) does not match source size (${sourceStat.size})`,
          { code: "APK_COPY_SIZE_MISMATCH" },
        );
      }
      const tmpHash = await sha256File(tmpPath);
      if (tmpHash !== sourceHash) {
        await fsp.unlink(tmpPath).catch(() => {});
        throw new ReleaseToolError(
          `Copied APK SHA-256 (${tmpHash}) does not match source SHA-256 (${sourceHash})`,
          { code: "APK_COPY_HASH_MISMATCH" },
        );
      }
      await fsp.rename(tmpPath, destApkPath);
    }
  }

  const finalHash = dryRun ? sourceHash : await sha256File(destApkPath);
  if (finalHash !== sourceHash) {
    throw new ReleaseToolError(
      "Final backend APK SHA-256 does not match source APK SHA-256 after copy",
      { code: "APK_FINAL_HASH_MISMATCH" },
    );
  }

  // --- Build next metadata ---------------------------------------------------------
  const minimumVersion = args["minimum-version"]
    ? String(args["minimum-version"]).trim()
    : existingConfig?.minimumSupportedVersion || versionName;
  const minimumBuildNumberArg = args["minimum-build-number"]
    ? Number.parseInt(args["minimum-build-number"], 10)
    : existingConfig?.minimumSupportedBuildNumber;

  if (!isValidDottedVersion(minimumVersion)) {
    throw new ReleaseToolError(
      `--minimum-version "${minimumVersion}" must be an x.y.z dotted numeric version`,
      { code: "MINIMUM_VERSION_INVALID" },
    );
  }
  if (compareVersions(minimumVersion, versionName) > 0) {
    throw new ReleaseToolError(
      `--minimum-version ${minimumVersion} cannot exceed the release version ${versionName}`,
      { code: "MINIMUM_VERSION_EXCEEDS_LATEST" },
    );
  }

  const releaseNotesOverride = await resolveReleaseNotes(args);
  const releaseNotes =
    releaseNotesOverride !== null
      ? releaseNotesOverride
      : String(existingConfig?.releaseNotes || "").replace(/\r\n/g, "\n");

  const nextConfig = {
    ...(existingConfig || {}),
    latestVersion: versionName,
    latestBuildNumber: buildNumber,
    minimumSupportedVersion: minimumVersion,
    ...(minimumBuildNumberArg !== undefined && Number.isInteger(minimumBuildNumberArg)
      ? { minimumSupportedBuildNumber: minimumBuildNumberArg }
      : {}),
    apkFileName: canonicalFileName,
    apkUrl: existingConfig?.apkUrl ?? "",
    releaseNotes,
    sha256: sourceHash,
    checksum: sourceHash,
    generatedAt: new Date().toISOString(),
  };

  validateMetadataShape(nextConfig, "prepared config (pre-write)");

  const metadataChanged =
    !existingConfig ||
    JSON.stringify(existingConfig) !==
      JSON.stringify({ ...nextConfig, generatedAt: existingConfig.generatedAt });

  if (!dryRun) {
    const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
    // Guard against BOM / bad encoding by round-tripping through Buffer.
    const buffer = Buffer.from(serialized, "utf8");
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      throw new ReleaseToolError("Refusing to write a UTF-8 BOM into app-update.json", {
        code: "BOM_DETECTED",
      });
    }

    const backupPath = existingConfig
      ? `${metadataPath}.bak-${Date.now()}`
      : null;
    if (backupPath && fs.existsSync(metadataPath)) {
      await fsp.copyFile(metadataPath, backupPath);
    }

    try {
      await atomicWriteFile(metadataPath, serialized);

      // Validate what we just wrote, on disk, from scratch.
      const verifyRaw = await fsp.readFile(metadataPath, "utf8");
      if (verifyRaw.charCodeAt(0) === 0xfeff) {
        throw new ReleaseToolError("Written app-update.json contains a BOM", {
          code: "BOM_DETECTED",
        });
      }
      const verifyParsed = parseJsonStrict(verifyRaw, metadataPath);
      validateMetadataShape(verifyParsed, "post-write verification");
      if (verifyParsed.sha256 !== sourceHash || verifyParsed.checksum !== sourceHash) {
        throw new ReleaseToolError(
          "Post-write verification found sha256/checksum mismatch",
          { code: "POST_WRITE_HASH_MISMATCH" },
        );
      }
    } catch (error) {
      // Restore original file automatically on any validation failure.
      if (backupPath && fs.existsSync(backupPath)) {
        await fsp.copyFile(backupPath, metadataPath);
        warn(`[prepare] Restored original app-update.json from backup after validation failure.`);
      }
      throw error;
    } finally {
      if (backupPath && fs.existsSync(backupPath)) {
        await fsp.unlink(backupPath).catch(() => {});
      }
    }
  }

  const result = {
    dryRun,
    sourceApkPath,
    destApkPath,
    metadataPath,
    versionName,
    buildNumber,
    minimumVersion,
    minimumBuildNumber: nextConfig.minimumSupportedBuildNumber ?? null,
    apkFileName: canonicalFileName,
    fileSizeBytes: sourceStat.size,
    sha256: sourceHash,
    metadataChanged,
    apkChanged,
    manifestVerification: manifestResult,
    releaseNotes,
  };

  log("");
  log("=== app-update prepare: result ===");
  log(`Source APK path      : ${result.sourceApkPath}`);
  log(`Destination APK path : ${result.destApkPath}${dryRun ? " (dry-run, not written)" : ""}`);
  log(`Active metadata path : ${result.metadataPath}${dryRun ? " (dry-run, not written)" : ""}`);
  log(`Version              : ${result.versionName}`);
  log(`Build number         : ${result.buildNumber}`);
  log(`Minimum version      : ${result.minimumVersion}`);
  log(`Minimum build number : ${result.minimumBuildNumber ?? "(not set)"}`);
  log(`File size (bytes)    : ${result.fileSizeBytes}`);
  log(`SHA-256              : ${result.sha256}`);
  log(`Metadata changed     : ${result.metadataChanged}`);
  log(`APK changed          : ${result.apkChanged}`);
  log(
    `APK manifest check   : ${
      manifestResult.skipped
        ? `SKIPPED (dry-run, tools unavailable) - ${manifestResult.reason}`
        : `OK via ${manifestResult.tool} (package=${manifestResult.packageName}, versionName=${manifestResult.versionName}, versionCode=${manifestResult.versionCode})`
    }`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Isolated local verification harness (no MongoDB)
// ---------------------------------------------------------------------------

/**
 * Boots a throwaway Express app that mounts ONLY the real appUpdate router,
 * with no DB connection and no other route/middleware from index.js. This
 * lets verify-local exercise the real route logic without touching the
 * production MongoDB Atlas cluster referenced by Backend-MedicalVault/.env.
 */
async function startIsolatedHarness({ port = 0 } = {}) {
  const { default: express } = await import("express");
  const routeModuleUrl = new URL("../routes/appUpdate.js", import.meta.url);
  const { default: appUpdateRoutes } = await import(routeModuleUrl.href);

  const app = express();
  app.use("/api/app", appUpdateRoutes);
  app.use("/api/v1/app", appUpdateRoutes);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const actualPort = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers (no external deps; Node's http/https)
// ---------------------------------------------------------------------------

function httpGetJson(url, { headers = {}, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    // Render free-tier services can take 20-30s+ to wake from a cold start.
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Request timed out")));
  });
}

function httpDownloadToFile(url, destPath, { headers = {}, timeoutMs = 180000 } = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        resolve(httpDownloadToFile(nextUrl, destPath, { headers, timeoutMs }, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          reject(
            new Error(
              `Download failed with status ${res.statusCode}: ${Buffer.concat(chunks)
                .toString("utf8")
                .slice(0, 500)}`,
            ),
          );
        });
        return;
      }
      const contentType = String(res.headers["content-type"] || "");
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => {
        fileStream.close(() => resolve({ contentType, headers: res.headers }));
      });
      fileStream.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Download timed out")));
  });
}

// ---------------------------------------------------------------------------
// verify-local command
// ---------------------------------------------------------------------------

async function cmdVerifyLocal(args) {
  const metadataPath = DEFAULT_METADATA_PATH;
  const expectedConfig = loadMetadataRaw(metadataPath);
  validateMetadataShape(expectedConfig, metadataPath);

  const harness = await startIsolatedHarness();
  const report = {
    baseUrl: harness.baseUrl,
    checks: [],
  };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok, detail });
    log(`[verify-local] ${ok ? "PASS" : "FAIL"} - ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) throw new ReleaseToolError(`verify-local check failed: ${name} (${detail})`, {
      code: "VERIFY_LOCAL_FAILED",
    });
  };

  try {
    const updateUrl = `${harness.baseUrl}/api/v1/app/update?currentVersion=0.0.1`;
    const response = await httpGetJson(updateUrl);
    check("update endpoint returns 200", response.statusCode === 200, `status=${response.statusCode}`);

    const data = JSON.parse(response.body);
    check(
      "latestVersion matches app-update.json",
      data.latestVersion === expectedConfig.latestVersion,
      `${data.latestVersion} vs ${expectedConfig.latestVersion}`,
    );
    check(
      "sha256 matches app-update.json",
      data.sha256 === expectedConfig.sha256,
      `${data.sha256} vs ${expectedConfig.sha256}`,
    );
    check(
      "checksum equals sha256 in response",
      data.checksum === data.sha256,
      `${data.checksum} vs ${data.sha256}`,
    );
    check("apkUrl present and non-empty", Boolean(data.apkUrl), data.apkUrl);
    check(
      "apkUrl does not point at localhost/127.0.0.1/10.0.2.2 when a public base URL is configured",
      args["remote-base-url"]
        ? !/localhost|127\.0\.0\.1|10\.0\.2\.2/i.test(data.apkUrl)
        : true,
      data.apkUrl,
    );

    // Download the APK through the isolated harness and verify byte-for-byte.
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mv-app-update-verify-"));
    const downloadedPath = path.join(tmpDir, "downloaded.apk");
    const apkUrlForHarness = data.apkUrl.replace(/^https?:\/\/[^/]+/, harness.baseUrl);
    const downloadMeta = await httpDownloadToFile(apkUrlForHarness, downloadedPath);
    check(
      "downloaded content-type is not text/html (no error page)",
      !/text\/html/i.test(downloadMeta.contentType || ""),
      downloadMeta.contentType,
    );

    const downloadedStat = await fsp.stat(downloadedPath);
    check("downloaded APK is non-empty", downloadedStat.size > 0, `size=${downloadedStat.size}`);

    const downloadedHash = await sha256File(downloadedPath);
    check(
      "downloaded APK sha256 matches metadata",
      downloadedHash === expectedConfig.sha256,
      `${downloadedHash} vs ${expectedConfig.sha256}`,
    );

    await fsp.rm(tmpDir, { recursive: true, force: true });

    // Version/build eligibility trace cases (client-equivalent logic).
    const traceCases = [
      {
        label: "older version is update-eligible",
        currentVersion: "1.0.1",
        currentBuild: 1,
        expectHasUpdate: true,
      },
      {
        label: "current version/build exactly matches latest (no update)",
        currentVersion: expectedConfig.latestVersion,
        currentBuild: expectedConfig.latestBuildNumber,
        expectHasUpdate: false,
      },
      {
        label: "below minimum version forces update",
        currentVersion: "0.0.1",
        currentBuild: 1,
        expectForceUpdate: true,
      },
    ];
    for (const testCase of traceCases) {
      const url = `${harness.baseUrl}/api/v1/app/update?currentVersion=${encodeURIComponent(
        testCase.currentVersion,
      )}`;
      const res = await httpGetJson(url);
      const body = JSON.parse(res.body);
      if (testCase.expectHasUpdate !== undefined) {
        check(
          `trace: ${testCase.label}`,
          body.hasUpdate === testCase.expectHasUpdate,
          `hasUpdate=${body.hasUpdate}`,
        );
      }
      if (testCase.expectForceUpdate !== undefined) {
        check(
          `trace: ${testCase.label}`,
          body.forceUpdate === testCase.expectForceUpdate,
          `forceUpdate=${body.forceUpdate}`,
        );
      }
    }

    // Legacy alias route also works.
    const aliasResponse = await httpGetJson(`${harness.baseUrl}/api/app/update?currentVersion=0.0.1`);
    check("legacy /api/app/update alias returns 200", aliasResponse.statusCode === 200, `status=${aliasResponse.statusCode}`);

    log("");
    log("=== verify-local: all checks passed ===");
    return { ok: true, checks: report.checks };
  } finally {
    await harness.close();
  }
}

// ---------------------------------------------------------------------------
// verify-remote command (read-only, safe against production)
// ---------------------------------------------------------------------------

async function cmdVerifyRemote(args) {
  const remoteBaseUrl = String(args["remote-base-url"] || "").trim().replace(/\/+$/, "");
  if (!remoteBaseUrl) {
    throw new ReleaseToolError(
      "--remote-base-url is required for verify-remote (e.g. https://backend-medicalvault.onrender.com)",
      { code: "REMOTE_BASE_URL_REQUIRED" },
    );
  }
  if (!remoteBaseUrl.startsWith("https://")) {
    throw new ReleaseToolError("--remote-base-url must use https://", {
      code: "REMOTE_BASE_URL_NOT_HTTPS",
    });
  }

  const localConfig = fs.existsSync(DEFAULT_METADATA_PATH)
    ? loadMetadataRaw(DEFAULT_METADATA_PATH)
    : null;

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log(`[verify-remote] ${ok ? "PASS" : "FAIL"} - ${name}${detail ? `: ${detail}` : ""}`);
  };

  const updateUrl = `${remoteBaseUrl}/api/v1/app/update?currentVersion=0.0.1&currentBuildNumber=1`;
  const response = await httpGetJson(updateUrl);
  check("remote update endpoint reachable (200)", response.statusCode === 200, `status=${response.statusCode}`);
  if (response.statusCode !== 200) {
    return { ok: false, checks, remoteBaseUrl };
  }

  const data = JSON.parse(response.body);
  check("remote latestVersion present", Boolean(data.latestVersion), data.latestVersion);
  check("remote sha256 present and well-formed", SHA256_REGEX.test(String(data.sha256 || "").toLowerCase()), data.sha256);
  check("remote checksum equals sha256", data.checksum === data.sha256, `${data.checksum} vs ${data.sha256}`);
  check("remote apkUrl uses https", String(data.apkUrl || "").startsWith("https://"), data.apkUrl);
  check(
    "remote apkUrl is not localhost/127.0.0.1/10.0.2.2",
    !/localhost|127\.0\.0\.1|10\.0\.2\.2/i.test(String(data.apkUrl || "")),
    data.apkUrl,
  );

  if (localConfig) {
    check(
      "remote latestVersion matches local prepared metadata",
      data.latestVersion === localConfig.latestVersion,
      `remote=${data.latestVersion} local=${localConfig.latestVersion}`,
    );
    check(
      "remote checksum matches local prepared metadata",
      data.sha256 === localConfig.sha256,
      `remote=${data.sha256} local=${localConfig.sha256}`,
    );
  }

  // Download deployed APK and verify checksum + size.
  let downloadedHash = null;
  let downloadedSize = null;
  if (data.apkUrl) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mv-app-update-remote-"));
    const downloadedPath = path.join(tmpDir, "remote.apk");
    try {
      const meta = await httpDownloadToFile(data.apkUrl, downloadedPath);
      check(
        "downloaded remote content-type is not text/html",
        !/text\/html/i.test(meta.contentType || ""),
        meta.contentType,
      );
      const stat = await fsp.stat(downloadedPath);
      downloadedSize = stat.size;
      check("downloaded remote APK is non-empty", stat.size > 0, `size=${stat.size}`);
      downloadedHash = await sha256File(downloadedPath);
      check(
        "downloaded remote APK sha256 matches remote metadata",
        downloadedHash === data.sha256,
        `${downloadedHash} vs ${data.sha256}`,
      );
      if (localConfig) {
        check(
          "downloaded remote APK sha256 matches local prepared metadata",
          downloadedHash === localConfig.sha256,
          `${downloadedHash} vs ${localConfig.sha256}`,
        );
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  } else {
    check("remote apkUrl present", false, "empty apkUrl in remote response");
  }

  const allOk = checks.every((c) => c.ok);
  log("");
  log(`=== verify-remote: ${allOk ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} ===`);
  return {
    ok: allOk,
    checks,
    remoteBaseUrl,
    remote: {
      latestVersion: data.latestVersion,
      latestBuildNumber: data.latestBuildNumber ?? null,
      releaseNotes: data.releaseNotes,
      sha256: data.sha256,
      apkUrl: data.apkUrl,
    },
    downloadedHash,
    downloadedSize,
  };
}

// ---------------------------------------------------------------------------
// Render deploy hook (guarded; not exercised without explicit configuration)
// ---------------------------------------------------------------------------

async function triggerRenderDeployAndPoll({ remoteBaseUrl, expectedVersion, expectedSha256 }) {
  const hookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    throw new ReleaseToolError(
      "--deploy-render was passed but RENDER_DEPLOY_HOOK_URL is not set. Refusing to deploy.",
      { code: "DEPLOY_HOOK_NOT_CONFIGURED" },
    );
  }

  log("[release] Triggering Render deploy hook (URL not printed)...");
  await new Promise((resolve, reject) => {
    const lib = hookUrl.startsWith("https://") ? https : http;
    const req = lib.request(hookUrl, { method: "POST" }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.end();
  });

  log("[release] Deploy triggered. Polling deployed endpoint for the new version...");

  const maxAttempts = 20;
  let delayMs = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 1.5, 60000); // exponential backoff, capped at 60s

    try {
      const res = await httpGetJson(
        `${remoteBaseUrl}/api/v1/app/update?currentVersion=0.0.1`,
      );
      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        if (data.latestVersion === expectedVersion && data.sha256 === expectedSha256) {
          log(`[release] Deployed version confirmed live after attempt ${attempt}.`);
          return { ok: true, attempts: attempt };
        }
      }
    } catch (error) {
      warn(`[release] Poll attempt ${attempt} failed: ${error.message}`);
    }
  }

  throw new ReleaseToolError(
    "Timed out waiting for deployed version to match the prepared release",
    { code: "DEPLOY_POLL_TIMEOUT" },
  );
}

// ---------------------------------------------------------------------------
// release command (prepare + optional guarded deploy + optional verify-remote)
// ---------------------------------------------------------------------------

async function cmdRelease(args) {
  const prepared = await cmdPrepare(args);
  const remoteBaseUrl = args["remote-base-url"]
    ? String(args["remote-base-url"]).trim().replace(/\/+$/, "")
    : null;

  const report = {
    prepared,
    deploy: null,
    remoteVerification: null,
  };

  if (!args["deploy-render"]) {
    log("");
    log("Release prepared locally. Deploy Backend-MedicalVault before remote verification.");
    await writeReleaseReport(args, report, "release-pending");
    process.exitCode = 2; // distinct "release-pending" code
    return report;
  }

  if (!process.env.RENDER_DEPLOY_HOOK_URL) {
    throw new ReleaseToolError(
      "--deploy-render requires the RENDER_DEPLOY_HOOK_URL environment variable to be set.",
      { code: "DEPLOY_HOOK_NOT_CONFIGURED" },
    );
  }
  if (!remoteBaseUrl) {
    throw new ReleaseToolError(
      "--deploy-render requires --remote-base-url so the tool can poll/verify the deployment.",
      { code: "REMOTE_BASE_URL_REQUIRED" },
    );
  }

  const deployResult = await triggerRenderDeployAndPoll({
    remoteBaseUrl,
    expectedVersion: prepared.versionName,
    expectedSha256: prepared.sha256,
  });
  report.deploy = deployResult;

  const remoteVerification = await cmdVerifyRemote({ "remote-base-url": remoteBaseUrl });
  report.remoteVerification = remoteVerification;
  if (!remoteVerification.ok) {
    throw new ReleaseToolError(
      "Remote verification failed after deployment. See checks above.",
      { code: "REMOTE_VERIFICATION_FAILED" },
    );
  }

  await writeReleaseReport(args, report, "released");
  return report;
}

async function writeReleaseReport(args, report, status) {
  const now = new Date();
  const versionLabel = `${report.prepared.versionName}+${report.prepared.buildNumber}`;
  const timestampLabel = formatIst(now, { forFilename: true });
  const reportPath =
    args["json-report"] ||
    path.join(DEFAULT_RELEASE_REPORTS_DIR, `${versionLabel}-${timestampLabel}.json`);

  const gitCommit = safeGitCommit(BACKEND_ROOT);

  const payload = {
    status,
    version: report.prepared.versionName,
    buildNumber: report.prepared.buildNumber,
    minimumSupportedVersion: report.prepared.minimumVersion,
    minimumSupportedBuildNumber: report.prepared.minimumBuildNumber,
    apkFileName: report.prepared.apkFileName,
    fileSizeBytes: report.prepared.fileSizeBytes,
    sha256: report.prepared.sha256,
    metadataPath: report.prepared.metadataPath,
    sourceApkPath: report.prepared.sourceApkPath,
    releaseNotes: report.prepared.releaseNotes,
    localVerification: null,
    deploymentTrigger: report.deploy
      ? { triggered: true, attempts: report.deploy.attempts }
      : { triggered: false, reason: "not requested or not authorized this run" },
    remoteVerification: report.remoteVerification
      ? {
          ok: report.remoteVerification.ok,
          remoteBaseUrl: report.remoteVerification.remoteBaseUrl,
          remoteLatestVersion: report.remoteVerification.remote?.latestVersion,
          remoteSha256: report.remoteVerification.remote?.sha256,
          downloadedHash: report.remoteVerification.downloadedHash,
          downloadedSize: report.remoteVerification.downloadedSize,
        }
      : null,
    timestamps: {
      preparedAtIst: formatIst(now),
      preparedAtUtc: nowIso(),
    },
    gitCommit,
  };

  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await atomicWriteFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
  log(`[release] Release report written to ${reportPath}`);
  return reportPath;
}

function safeGitCommit(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (!command) {
    console.error(
      "Usage: release-app-update.mjs <prepare|verify-local|verify-remote|release> [options]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    switch (command) {
      case "prepare":
        await cmdPrepare(args);
        break;
      case "verify-local":
        await cmdVerifyLocal(args);
        break;
      case "verify-remote": {
        const result = await cmdVerifyRemote(args);
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "release":
        await cmdRelease(args);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof ReleaseToolError) {
      console.error(`\n[ERROR] ${error.code}: ${error.message}`);
    } else {
      console.error(`\n[ERROR] Unexpected failure: ${error.message}`);
      if (process.env.DEBUG) console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

// Only run when executed directly (not when imported by tests).
function isMainModule() {
  if (!process.argv[1]) return false;
  // Compare realpaths, not raw resolved paths: on macOS/Linux the OS temp
  // directory (and other paths) can involve a symlink (e.g. /var ->
  // /private/var), so process.argv[1] and import.meta.url-derived
  // __filename can be two different-looking but equivalent absolute paths.
  // A naive string comparison would silently treat this file as "imported,
  // not executed" and skip main() entirely.
  try {
    const argvRealPath = fs.realpathSync(path.resolve(process.argv[1]));
    const selfRealPath = fs.realpathSync(__filename);
    return argvRealPath === selfRealPath;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}
const isMain = isMainModule();
if (isMain) {
  main();
}

export {
  parseArgs,
  readPubspecVersion,
  compareVersions,
  isValidDottedVersion,
  parseVersionSegments,
  sha256File,
  atomicWriteFile,
  parseJsonStrict,
  validateMetadataShape,
  loadMetadataRaw,
  inspectApkManifest,
  findAndroidSdkTool,
  verifyApkManifest,
  cmdPrepare,
  cmdVerifyLocal,
  cmdVerifyRemote,
  cmdRelease,
  startIsolatedHarness,
  httpGetJson,
  httpDownloadToFile,
  formatIst,
  ReleaseToolError,
  BACKEND_ROOT,
  REPO_ROOT,
  DEFAULT_FLUTTER_ROOT,
  DEFAULT_PUBSPEC_PATH,
  DEFAULT_FLUTTER_APK_PATH,
  DEFAULT_APK_DIR,
  DEFAULT_METADATA_PATH,
};
