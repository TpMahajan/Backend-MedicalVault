#!/usr/bin/env node
/**
 * Medical Vault - Firebase App Distribution helper.
 *
 * Wraps the Firebase CLI (`npx firebase-tools`) to upload the canonical
 * release APK produced by release-app-update.mjs to Firebase App
 * Distribution and notify configured tester groups/testers.
 *
 * This module never invokes the Firebase CLI as a side effect of being
 * imported - callers explicitly invoke distributeToFirebase(). It contains
 * no APK build/version logic of its own; that all stays in
 * release-app-update.mjs, which is the single source of truth for the
 * release payload this module uploads.
 */

import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, "..");

class FirebaseDistributionError extends Error {
  constructor(message, { code = "FIREBASE_DISTRIBUTION_ERROR" } = {}) {
    super(message);
    this.name = "FirebaseDistributionError";
    this.code = code;
  }
}

function log(...args) {
  console.log(...args);
}

/**
 * Resolve the Firebase CLI invocation. Always goes through `npx
 * firebase-tools` (which resolves the local devDependency first, per repo
 * policy of never depending on a globally installed Firebase CLI) rather
 * than shelling out to a bare `firebase` binary on PATH.
 */
function firebaseCliCommand() {
  const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
  return { command: npxBin, baseArgs: ["--yes", "firebase-tools"] };
}

/**
 * Read required/optional Firebase configuration from environment variables.
 * Never reads or writes any repository file for secrets.
 */
function resolveFirebaseConfig(env = process.env) {
  const androidAppId = String(env.FIREBASE_ANDROID_APP_ID || "").trim();
  const groups = String(env.FIREBASE_DISTRIBUTION_GROUPS || "").trim();
  const testers = String(env.FIREBASE_DISTRIBUTION_TESTERS || "").trim();
  const googleCredentials = String(env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  const firebaseToken = String(env.FIREBASE_TOKEN || "").trim();
  return { androidAppId, groups, testers, googleCredentials, firebaseToken };
}

/**
 * Validate configuration required to perform an upload. Returns a list of
 * human-readable problems (empty if configuration is sufficient). Does not
 * throw so callers can decide whether to fail hard or just report.
 */
function validateFirebaseConfig(config) {
  const problems = [];
  if (!config.androidAppId) {
    problems.push(
      "FIREBASE_ANDROID_APP_ID is not set. Set it to the Firebase Android " +
        "app ID (e.g. 1:1234567890:android:abcdef1234567890) from the " +
        "Firebase console for this project.",
    );
  }
  if (!config.groups && !config.testers) {
    problems.push(
      "Neither FIREBASE_DISTRIBUTION_GROUPS nor FIREBASE_DISTRIBUTION_TESTERS " +
        "is set. At least one tester group alias or tester email is required " +
        "so the release actually reaches someone.",
    );
  }
  if (!config.googleCredentials && !config.firebaseToken) {
    problems.push(
      "Neither GOOGLE_APPLICATION_CREDENTIALS nor FIREBASE_TOKEN is set. " +
        "Firebase CLI authentication is required to upload a release " +
        "(service-account credentials are preferred; FIREBASE_TOKEN is a " +
        "fallback for interactive/legacy CI auth).",
    );
  } else if (config.googleCredentials && !fs.existsSync(config.googleCredentials)) {
    problems.push(
      "GOOGLE_APPLICATION_CREDENTIALS is set but the file it points to does " +
        "not exist. Verify the path (its value is not printed for safety).",
    );
  }
  return problems;
}

/** Verify the Firebase Android App ID's embedded package matches the APK's. */
function verifyAndroidAppIdMatchesPackage(androidAppId, expectedPackageName) {
  // Firebase Android app IDs are opaque identifiers (project:number:android:hash)
  // and do not embed the package name, so this cannot be checked from the ID
  // string alone. Package-name/App-ID correspondence is enforced by Firebase
  // itself at upload time (the CLI rejects an APK whose package does not match
  // the target app). We still assert the ID has the expected shape so a
  // copy-paste mistake (e.g. an iOS app ID) fails fast with a clear message.
  const shapeOk = /^1:\d+:android:[a-f0-9]+$/i.test(androidAppId);
  if (!shapeOk) {
    throw new FirebaseDistributionError(
      `FIREBASE_ANDROID_APP_ID "${androidAppId}" does not look like a Firebase ` +
        `Android app ID (expected form "1:<project-number>:android:<hash>"). ` +
        `Double-check it against the Firebase console for package ` +
        `"${expectedPackageName}".`,
      { code: "FIREBASE_APP_ID_MALFORMED" },
    );
  }
}

/** Build the human-readable release-notes text used for the Firebase release. */
function buildReleaseNotes({
  appName = "Medical Vault",
  versionName,
  buildNumber,
  releaseNotes,
  sha256,
  gitCommit,
  releasedAtIst,
  buildType = "release",
}) {
  const lines = [];
  lines.push(`${appName} ${versionName} (Build ${buildNumber})`);
  lines.push("");
  const notesBody = String(releaseNotes || "").trim();
  if (notesBody) {
    lines.push(notesBody);
    lines.push("");
  }
  lines.push(`SHA-256: ${sha256}`);
  if (gitCommit) lines.push(`Commit: ${gitCommit}`);
  lines.push(`Build type: ${buildType}`);
  lines.push(`Released: ${releasedAtIst}`);
  return `${lines.join("\n")}\n`;
}

async function writeReleaseNotesFile(content) {
  const tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "mv-firebase-release-notes-"),
  );
  const notesPath = path.join(tmpDir, "release-notes.txt");
  await fsp.writeFile(notesPath, content, "utf8");
  return notesPath;
}

/**
 * Check the local release report history for a prior successful Firebase
 * upload of this exact version+buildNumber+sha256, to prevent an accidental
 * duplicate distribution. Returns the matching prior report entry, or null.
 */
async function findPriorFirebaseRelease({
  releaseReportsDir,
  versionName,
  buildNumber,
  sha256,
}) {
  if (!fs.existsSync(releaseReportsDir)) return null;
  const files = (await fsp.readdir(releaseReportsDir)).filter((f) =>
    f.endsWith(".json"),
  );
  for (const file of files) {
    try {
      const raw = await fsp.readFile(path.join(releaseReportsDir, file), "utf8");
      const parsed = JSON.parse(raw);
      const fb = parsed.firebaseDistribution;
      if (
        fb &&
        fb.status === "uploaded" &&
        parsed.version === versionName &&
        parsed.buildNumber === buildNumber &&
        parsed.sha256 === sha256
      ) {
        return { file, report: parsed };
      }
    } catch {
      // Ignore unreadable/malformed historical reports; they cannot match.
    }
  }
  return null;
}

/**
 * Run the Firebase CLI distribute command. Returns a structured result and
 * never throws on a clean non-zero CLI exit - it returns { ok: false, ... }
 * so the caller (release-app-update.mjs) controls fail-the-release behavior
 * consistently with its other checks. Throws FirebaseDistributionError only
 * for programmer/configuration errors detected before invoking the CLI.
 */
function runFirebaseDistribute({
  apkPath,
  androidAppId,
  groups,
  testers,
  releaseNotesFile,
  env,
}) {
  const { command, baseArgs } = firebaseCliCommand();
  const args = [
    ...baseArgs,
    "appdistribution:distribute",
    apkPath,
    "--app",
    androidAppId,
  ];
  if (groups) args.push("--groups", groups);
  if (testers) args.push("--testers", testers);
  if (releaseNotesFile) args.push("--release-notes-file", releaseNotesFile);

  const spawnEnv = { ...process.env, ...(env || {}) };
  // Never let a stray FIREBASE_TOKEN/service-account value leak into logs:
  // spawnSync output is captured, not streamed, and only sanitized fields
  // are surfaced to the caller/report.
  const result = spawnSync(command, args, {
    cwd: BACKEND_ROOT,
    env: spawnEnv,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new FirebaseDistributionError(
      `Failed to invoke Firebase CLI (${command}): ${result.error.message}`,
      { code: "FIREBASE_CLI_SPAWN_FAILED" },
    );
  }

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const ok = result.status === 0;

  // Extract useful, non-sensitive URIs from CLI output without ever logging
  // full stdout/stderr (which could theoretically echo back flag values).
  const consoleUriMatch = stdout.match(
    /https:\/\/console\.firebase\.google\.com\/\S+/,
  );
  const testerUriMatch = stdout.match(
    /https:\/\/appdistribution\.firebase\.(?:dev|google\.com)\/\S+/,
  );

  return {
    ok,
    exitCode: result.status,
    firebaseConsoleUri: consoleUriMatch ? consoleUriMatch[0] : null,
    testerUri: testerUriMatch ? testerUriMatch[0] : null,
    // Truncated, best-effort failure hint only when the upload failed; on
    // success we do not retain CLI stdout/stderr in the returned object at
    // all, so nothing beyond the two extracted URIs is ever persisted.
    errorHint: ok ? null : sanitizeCliFailureOutput(stderr || stdout),
  };
}

/** Strip anything resembling a token/credential path before surfacing CLI errors. */
function sanitizeCliFailureOutput(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-10) // last 10 non-empty lines is normally enough to diagnose
    .join("\n")
    .replace(/([A-Za-z0-9_-]{20,})/g, (match) =>
      // Redact long opaque tokens (access tokens, JWTs) while keeping
      // ordinary words/paths readable.
      /^[A-Za-z0-9_-]+$/.test(match) && /[0-9]/.test(match) && /[A-Za-z]/.test(match)
        ? "[REDACTED]"
        : match,
    )
    .slice(0, 2000);
}

/**
 * High-level entry point used by release-app-update.mjs's `release`/`firebase`
 * commands. Handles config validation, duplicate-upload protection, release
 * notes generation, and invoking the CLI. Does not build or verify the APK -
 * callers must pass an already-verified canonical APK path.
 */
async function distributeToFirebase({
  apkPath,
  packageName,
  versionName,
  buildNumber,
  sha256,
  releaseNotes,
  gitCommit,
  releasedAtIst,
  buildType = "release",
  releaseReportsDir,
  groupsOverride,
  testersOverride,
  forceReupload = false,
  dryRun = false,
  env = process.env,
}) {
  const config = resolveFirebaseConfig(env);
  const groups = groupsOverride ?? config.groups;
  const testers = testersOverride ?? config.testers;
  const effectiveConfig = { ...config, groups, testers };

  const problems = validateFirebaseConfig(effectiveConfig);
  if (problems.length > 0) {
    throw new FirebaseDistributionError(
      `Firebase App Distribution configuration is incomplete:\n  - ${problems.join(
        "\n  - ",
      )}`,
      { code: "FIREBASE_CONFIG_INCOMPLETE" },
    );
  }

  verifyAndroidAppIdMatchesPackage(config.androidAppId, packageName);

  if (!fs.existsSync(apkPath) || fs.statSync(apkPath).size === 0) {
    throw new FirebaseDistributionError(
      `Cannot upload to Firebase App Distribution: APK not found or empty at ${apkPath}`,
      { code: "FIREBASE_APK_MISSING" },
    );
  }

  if (releaseReportsDir && !forceReupload) {
    const prior = await findPriorFirebaseRelease({
      releaseReportsDir,
      versionName,
      buildNumber,
      sha256,
    });
    if (prior) {
      throw new FirebaseDistributionError(
        `This exact version+build+checksum (${versionName}+${buildNumber}, ` +
          `sha256=${sha256.slice(0, 12)}...) was already uploaded to Firebase ` +
          `App Distribution (see ${prior.file}). Pass --force-firebase-reupload ` +
          `if this is an intentional repeated upload.`,
        { code: "FIREBASE_DUPLICATE_UPLOAD" },
      );
    }
  }

  const notesContent = buildReleaseNotes({
    versionName,
    buildNumber,
    releaseNotes,
    sha256,
    gitCommit,
    releasedAtIst,
    buildType,
  });
  const releaseNotesFile = await writeReleaseNotesFile(notesContent);

  if (dryRun) {
    log("[firebase] --dry-run: would upload the following release:");
    log(`  APK           : ${apkPath}`);
    log(`  App ID        : ${config.androidAppId}`);
    log(`  Groups        : ${groups || "(none)"}`);
    log(`  Testers       : ${testers || "(none)"}`);
    log(`  Release notes :\n${notesContent.replace(/^/gm, "    ")}`);
    return {
      ok: true,
      dryRun: true,
      status: "dry-run-skipped",
      androidAppId: config.androidAppId,
      groups,
      testers,
      releaseNotes: notesContent,
      firebaseConsoleUri: null,
      testerUri: null,
    };
  }

  log(
    `[firebase] Uploading ${path.basename(apkPath)} to Firebase App Distribution ` +
      `(app=${config.androidAppId})...`,
  );

  let authEnv = {};
  if (config.googleCredentials) {
    authEnv.GOOGLE_APPLICATION_CREDENTIALS = config.googleCredentials;
  } else if (config.firebaseToken) {
    authEnv.FIREBASE_TOKEN = config.firebaseToken;
  }

  const cliResult = runFirebaseDistribute({
    apkPath,
    androidAppId: config.androidAppId,
    groups,
    testers,
    releaseNotesFile,
    env: authEnv,
  });

  await fsp.rm(path.dirname(releaseNotesFile), { recursive: true, force: true });

  if (!cliResult.ok) {
    throw new FirebaseDistributionError(
      `Firebase CLI exited with code ${cliResult.exitCode} while uploading ` +
        `the release.${cliResult.errorHint ? ` Last output:\n${cliResult.errorHint}` : ""}`,
      { code: "FIREBASE_UPLOAD_FAILED" },
    );
  }

  log("[firebase] Upload succeeded.");
  if (cliResult.firebaseConsoleUri) {
    log(`[firebase] Console release: ${cliResult.firebaseConsoleUri}`);
  }
  if (cliResult.testerUri) {
    log(`[firebase] Tester release link: ${cliResult.testerUri}`);
  }

  return {
    ok: true,
    dryRun: false,
    status: "uploaded",
    androidAppId: config.androidAppId,
    groups,
    testers,
    releaseNotes: notesContent,
    firebaseConsoleUri: cliResult.firebaseConsoleUri,
    testerUri: cliResult.testerUri,
  };
}

export {
  FirebaseDistributionError,
  resolveFirebaseConfig,
  validateFirebaseConfig,
  verifyAndroidAppIdMatchesPackage,
  buildReleaseNotes,
  findPriorFirebaseRelease,
  runFirebaseDistribute,
  sanitizeCliFailureOutput,
  distributeToFirebase,
  firebaseCliCommand,
};
