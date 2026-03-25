import express from "express";
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
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function requestBase(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || req.protocol).split(",")[0].trim();
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

function loadUpdateConfig() {
  if (!fs.existsSync(updateConfigPath)) {
    throw new Error("app-update.json not found");
  }

  let parsed;
  try {
    const raw = fs.readFileSync(updateConfigPath, "utf-8");
    const normalizedRaw = raw.replace(/^\uFEFF/, "").trim();
    parsed = JSON.parse(normalizedRaw);
  } catch (error) {
    throw new Error("Invalid app-update.json content");
  }

  const latestVersion = String(parsed.latestVersion || "").trim();
  const minimumSupportedVersion = String(
    parsed.minimumSupportedVersion || ""
  ).trim();
  const releaseNotes = String(parsed.releaseNotes || "").trim();
  const sha256 = String(parsed.sha256 || parsed.checksum || "")
    .trim()
    .toLowerCase();
  const apkUrl = String(parsed.apkUrl || "").trim();

  if (!VERSION_REGEX.test(latestVersion)) {
    throw new Error("latestVersion must be a dotted numeric version");
  }
  if (!VERSION_REGEX.test(minimumSupportedVersion)) {
    throw new Error("minimumSupportedVersion must be a dotted numeric version");
  }
  if (compareVersions(minimumSupportedVersion, latestVersion) > 0) {
    throw new Error("minimumSupportedVersion cannot exceed latestVersion");
  }

  return {
    latestVersion,
    minimumSupportedVersion,
    releaseNotes,
    sha256,
    checksum: sha256,
    apkUrl,
  };
}

function resolveApkUrl(req, config) {
  if (config.apkUrl) {
    return withVersionQuery(config.apkUrl, config.latestVersion);
  }
  const envBase = normalizeApiBase(process.env.APP_API_BASE_URL);
  const base = envBase || normalizeApiBase(requestBase(req));
  return withVersionQuery(`${base}/api/app/apk/${config.latestVersion}`, config.latestVersion);
}

function resolveApkFilePath(version) {
  if (!fs.existsSync(apkDirectory)) {
    return null;
  }

  const candidates = [
    `${version}.apk`,
    `healthvault_v${version}.apk`,
    `medicalvault_v${version}.apk`,
    `app_v${version}.apk`,
    `app-${version}.apk`,
  ];

  for (const fileName of candidates) {
    const absolutePath = path.join(apkDirectory, fileName);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      return absolutePath;
    }
  }

  const files = fs.readdirSync(apkDirectory).filter((entry) => {
    const lower = entry.toLowerCase();
    return lower.endsWith(".apk") && lower.includes(version.toLowerCase());
  });

  if (files.length === 0) return null;
  return path.join(apkDirectory, files[0]);
}

router.get("/update", (req, res) => {
  try {
    const currentVersion = String(req.query.currentVersion || "0.0.0").trim();
    const config = loadUpdateConfig();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    const hasUpdate = compareVersions(currentVersion, config.latestVersion) < 0;
    const forceUpdate =
      compareVersions(currentVersion, config.minimumSupportedVersion) < 0;

    res.json({
      version: config.latestVersion,
      latestVersion: config.latestVersion,
      minimumSupportedVersion: config.minimumSupportedVersion,
      apkUrl: resolveApkUrl(req, config),
      releaseNotes: config.releaseNotes,
      checksum: config.sha256,
      sha256: config.sha256,
      hasUpdate,
      forceUpdate,
    });
  } catch (error) {
    res.status(500).json({
      message: "Unable to resolve app update metadata",
      error: error.message,
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
    const apkPath = resolveApkFilePath(version);
    if (!apkPath) {
      return res.status(404).json({
        message: `APK not found for version ${version}`,
      });
    }

    const downloadName = path.basename(apkPath);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    return res.download(apkPath, downloadName, (error) => {
      if (error && !res.headersSent) {
        res.status(500).json({
          message: "Failed to stream APK",
          error: error.message,
        });
      }
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to process APK download",
      error: error.message,
    });
  }
});

export default router;
