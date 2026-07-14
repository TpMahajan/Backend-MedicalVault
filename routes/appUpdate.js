import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const updateConfigPath = path.join(projectRoot, "app-update.json");
const apkDirectory = path.join(projectRoot, "apk");

const VERSION_REGEX = /^\d+(?:\.\d+){0,5}$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/;
const apkHashCache = new Map();

function parseVersionSegments(version) {
  return String(version || "")
    .trim()
    .split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const numeric = Number.parseInt(segment.replace(/[^\d]/g, ""), 10);
      return Number.isFinite(numeric) ? numeric : 0;
    });
}

function compareVersions(left, right) {
  const leftParts = parseVersionSegments(left);
  const rightParts = parseVersionSegments(right);
  const maxLen = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLen; index += 1) {
    const l = leftParts[index] || 0;
    const r = rightParts[index] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function normalizeApiBase(baseUrl) {
  const trimmed = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function requestBase(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol)
        .split(",")[0]
        .trim();
  const host = req.get("host");
  return `${protocol}://${host}`;
}

function withVersionQuery(urlValue, version) {
  const raw = String(urlValue || "").trim();
  if (!raw) return raw;

  try {
    const absolute = raw.startsWith("http://") || raw.startsWith("https://");
    const base = absolute ? undefined : "http://localhost";
    const parsed = new URL(raw, base);
    parsed.searchParams.set("v", String(version || "").trim());
    if (absolute) {
      return parsed.toString();
    }
    const pathname = parsed.pathname || "";
    const query = parsed.search || "";
    return `${pathname}${query}`;
  } catch {
    const separator = raw.includes("?") ? "&" : "?";
    return `${raw}${separator}v=${encodeURIComponent(String(version || "").trim())}`;
  }
}

function toPositiveIntOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function loadUpdateConfig() {
  if (!fs.existsSync(updateConfigPath)) {
    throw new Error("app-update.json not found");
  }

  let parsed;
  try {
    const raw = fs.readFileSync(updateConfigPath, "utf8");
    const normalizedRaw = raw.replace(/^\uFEFF/, "").trim();
    parsed = JSON.parse(normalizedRaw);
  } catch (error) {
    throw new Error("Invalid app-update.json content");
  }

  const latestVersion = String(parsed.latestVersion || "").trim();
  const minimumSupportedVersion = String(
    parsed.minimumSupportedVersion || "",
  ).trim();
  const releaseNotes = Array.isArray(parsed.releaseNotes)
    ? parsed.releaseNotes.map((note) => String(note || "").trim()).filter(Boolean).join("\n")
    : String(parsed.releaseNotes || "").trim();
  const sha256 = String(parsed.sha256 || parsed.checksum || "")
    .trim()
    .toLowerCase();
  const checksum = String(parsed.checksum || "")
    .trim()
    .toLowerCase();
  const apkUrl = String(parsed.apkUrl || "").trim();
  const apkFileName = String(parsed.apkFileName || "").trim();

  // Additive, optional fields. Older app-update.json files (and older
  // deployments) without these fields must continue to work exactly as
  // before \u2014 absence is not an error, only malformed presence is.
  if (
    (parsed.latestBuildNumber !== undefined || parsed.latestBuild !== undefined) &&
    toPositiveIntOrNull(parsed.latestBuildNumber ?? parsed.latestBuild) === null
  ) {
    throw new Error("latestBuildNumber must be a positive integer when present");
  }
  if (
    (parsed.minimumSupportedBuildNumber !== undefined || parsed.minimumSupportedBuild !== undefined) &&
    toPositiveIntOrNull(parsed.minimumSupportedBuildNumber ?? parsed.minimumSupportedBuild) === null
  ) {
    throw new Error(
      "minimumSupportedBuildNumber must be a positive integer when present",
    );
  }
  const latestBuildNumber = toPositiveIntOrNull(parsed.latestBuildNumber ?? parsed.latestBuild);
  const minimumSupportedBuildNumber = toPositiveIntOrNull(
    parsed.minimumSupportedBuildNumber ?? parsed.minimumSupportedBuild,
  );
  if (
    latestBuildNumber !== null &&
    minimumSupportedBuildNumber !== null &&
    minimumSupportedVersion === latestVersion &&
    minimumSupportedBuildNumber > latestBuildNumber
  ) {
    throw new Error(
      "minimumSupportedBuildNumber cannot exceed latestBuildNumber when versions are equal",
    );
  }

  if (!VERSION_REGEX.test(latestVersion)) {
    throw new Error("latestVersion must be a dotted numeric version");
  }
  if (!VERSION_REGEX.test(minimumSupportedVersion)) {
    throw new Error("minimumSupportedVersion must be a dotted numeric version");
  }
  if (compareVersions(minimumSupportedVersion, latestVersion) > 0) {
    throw new Error("minimumSupportedVersion cannot exceed latestVersion");
  }
  if (!SHA256_REGEX.test(sha256)) {
    throw new Error("sha256 must be a 64-character SHA256 hex checksum");
  }
  if (checksum && checksum !== sha256) {
    throw new Error("checksum and sha256 must match when both are configured");
  }
  if (
    apkFileName &&
    (apkFileName.includes("/") ||
      apkFileName.includes("\\") ||
      !apkFileName.toLowerCase().endsWith(".apk"))
  ) {
    throw new Error("apkFileName must be a plain APK filename");
  }

  return {
    latestVersion,
    latestBuildNumber,
    minimumSupportedVersion,
    minimumSupportedBuildNumber,
    releaseNotes,
    sha256,
    checksum: sha256,
    apkUrl,
    apkFileName,
    mandatory: parsed.mandatory === true,
    releaseDate: String(parsed.releaseDate || parsed.generatedAt || "").trim(),
  };
}

function resolveApkUrl(req, config) {
  if (config.apkUrl) {
    return withVersionQuery(config.apkUrl, config.latestVersion);
  }
  const envBase =
    normalizeApiBase(process.env.APP_API_BASE_URL) ||
    normalizeApiBase(process.env.API_PUBLIC_BASE_URL);
  const base = envBase || normalizeApiBase(requestBase(req));
  return withVersionQuery(
    `${base}/api/v1/app/apk/${config.latestVersion}`,
    config.latestVersion,
  );
}

function safeApkPath(fileName) {
  const absoluteDirectory = path.resolve(apkDirectory);
  const absolutePath = path.resolve(absoluteDirectory, fileName);
  if (!absolutePath.startsWith(`${absoluteDirectory}${path.sep}`)) {
    return null;
  }
  return absolutePath;
}

function resolveApkFilePath(version, config = null) {
  if (!fs.existsSync(apkDirectory)) {
    return null;
  }

  const candidates = [
    config?.apkFileName && config.latestVersion === version
      ? config.apkFileName
      : "",
    config?.latestBuildNumber && config.latestVersion === version
      ? `${version}+${config.latestBuildNumber}.apk`
      : "",
    `${version}.apk`,
    `healthvault_v${version}.apk`,
    `medicalvault_v${version}.apk`,
    `app_v${version}.apk`,
    `app-${version}.apk`,
  ];

  for (const fileName of candidates.filter(Boolean)) {
    const absolutePath = safeApkPath(fileName);
    if (!absolutePath) continue;
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      return absolutePath;
    }
  }

  const files = fs.readdirSync(apkDirectory).filter((entry) => {
    const lower = entry.toLowerCase();
    return lower.endsWith(".apk") && lower.includes(version.toLowerCase());
  });

  if (files.length === 0) return null;
  return safeApkPath(files.sort()[0]);
}

async function computeFileSha256(filePath) {
  const stat = fs.statSync(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = apkHashCache.get(cacheKey);
  if (cached) return cached;

  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const digest = hash.digest("hex").toLowerCase();
  apkHashCache.clear();
  apkHashCache.set(cacheKey, digest);
  return digest;
}

async function validateConfiguredApk(config) {
  const apkPath = resolveApkFilePath(config.latestVersion, config);
  if (!apkPath) {
    return {
      ok: false,
      code: "APP_UPDATE_APK_NOT_FOUND",
      message: "APK file missing on server",
    };
  }

  const actualSha256 = await computeFileSha256(apkPath);
  if (actualSha256 !== config.sha256) {
    return {
      ok: false,
      code: "APP_UPDATE_SHA_MISMATCH",
      message: "Configured sha256 does not match served APK",
      fileName: path.basename(apkPath),
    };
  }

  const stat = fs.statSync(apkPath);
  return {
    ok: true,
    fileName: path.basename(apkPath),
    size: stat.size,
  };
}

export async function validateAppUpdateConfigOnStartup() {
  try {
    const config = loadUpdateConfig();
    const validation = await validateConfiguredApk(config);
    if (!validation.ok) {
      console.warn("[app-update] Startup validation warning:", {
        code: validation.code,
        message: validation.message,
        latestVersion: config.latestVersion,
      });
      return validation;
    }
    console.info("[app-update] Startup validation passed:", {
      latestVersion: config.latestVersion,
      apkFileName: validation.fileName,
      size: validation.size,
    });
    return validation;
  } catch (error) {
    console.warn("[app-update] Startup validation warning:", {
      code: "APP_UPDATE_CONFIG_INVALID",
      message: error?.message || "Invalid app update config",
    });
    return {
      ok: false,
      code: "APP_UPDATE_CONFIG_INVALID",
      message: error?.message || "Invalid app update config",
    };
  }
}

router.get("/update", async (req, res) => {
  try {
    const currentVersion = String(req.query.currentVersion || "0.0.0").trim();
    const currentBuildNumber = toPositiveIntOrNull(req.query.currentBuildNumber);
    const config = loadUpdateConfig();
    const apkValidation = await validateConfiguredApk(config);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    if (!apkValidation.ok) {
      // Do not announce an update if the backing artifact fails integrity
      // checks — never serve a mismatched or missing APK as "available".
      res.status(503).json({
        success: false,
        code: "UPDATE_ARTIFACT_INVALID",
        errorCode: "UPDATE_ARTIFACT_INVALID",
        message: "Update artifact is currently unavailable. Please try again shortly.",
      });
      return;
    }

    const versionCmp = compareVersions(currentVersion, config.latestVersion);
    let hasUpdate = versionCmp < 0;
    // Same version, newer build available on the server -> still an update.
    if (
      !hasUpdate &&
      versionCmp === 0 &&
      currentBuildNumber !== null &&
      config.latestBuildNumber !== null &&
      currentBuildNumber < config.latestBuildNumber
    ) {
      hasUpdate = true;
    }

    const minCmp = compareVersions(currentVersion, config.minimumSupportedVersion);
    let forceUpdate = minCmp < 0;
    // Equal version but below the minimum supported build number -> forced.
    if (
      !forceUpdate &&
      minCmp === 0 &&
      currentBuildNumber !== null &&
      config.minimumSupportedBuildNumber !== null &&
      currentBuildNumber < config.minimumSupportedBuildNumber
    ) {
      forceUpdate = true;
      hasUpdate = true;
    }

    res.json({
      version: config.latestVersion,
      latestVersion: config.latestVersion,
      // Additive fields. Older app builds ignore unknown JSON keys, so this
      // is safe to add without breaking any existing client.
      latestBuildNumber: config.latestBuildNumber,
      latestBuild: config.latestBuildNumber,
      minimumSupportedVersion: config.minimumSupportedVersion,
      minimumSupportedBuildNumber: config.minimumSupportedBuildNumber,
      minimumSupportedBuild: config.minimumSupportedBuildNumber,
      apkUrl: resolveApkUrl(req, config),
      apkFileName: apkValidation.fileName || config.apkFileName || "",
      apkAvailable: apkValidation.ok,
      releaseNotes: config.releaseNotes,
      mandatory: config.mandatory,
      releaseDate: config.releaseDate,
      checksum: config.sha256,
      sha256: config.sha256,
      hasUpdate,
      forceUpdate: forceUpdate || (config.mandatory && hasUpdate),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      code: "APP_UPDATE_CONFIG_INVALID",
      errorCode: "APP_UPDATE_CONFIG_INVALID",
      message: "Update metadata invalid",
      detail: error.message,
    });
  }
});

router.get("/apk/:version", (req, res) => {
  const version = String(req.params.version || "").trim();
  if (!version || !VERSION_REGEX.test(version)) {
    return res.status(400).json({
      message: "Invalid version format",
    });
  }

  try {
    const config = loadUpdateConfig();
    const apkPath = resolveApkFilePath(version, config);
    if (!apkPath) {
      return res.status(404).json({
        success: false,
        code: "APP_UPDATE_APK_NOT_FOUND",
        errorCode: "APP_UPDATE_APK_NOT_FOUND",
        message: "APK file missing on server",
      });
    }

    const downloadName = path.basename(apkPath);
    const stat = fs.statSync(apkPath);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadName}"`,
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    return res.sendFile(apkPath, (error) => {
      if (error && !res.headersSent) {
        res.status(500).json({
          success: false,
          code: "APP_UPDATE_APK_STREAM_FAILED",
          errorCode: "APP_UPDATE_APK_STREAM_FAILED",
          message: "Failed to stream APK",
        });
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: "APP_UPDATE_APK_DOWNLOAD_FAILED",
      errorCode: "APP_UPDATE_APK_DOWNLOAD_FAILED",
      message: "Failed to process APK download",
    });
  }
});

export default router;
