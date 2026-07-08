import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const configPath = path.join(backendRoot, "app-update.json");
const apkDir = path.join(backendRoot, "apk");

const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return String(args[index + 1] || "").trim();
};

const shouldWrite = args.includes("--write");
const versionOverride = getArg("--version");
const apkPathOverride = getArg("--apk");

const readConfig = () => {
  const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
};

const readPubspecVersion = () => {
  const pubspecPath = path.resolve(
    backendRoot,
    "..",
    "MedicalVault",
    "pubspec.yaml",
  );
  if (!fs.existsSync(pubspecPath)) return "";
  const raw = fs.readFileSync(pubspecPath, "utf8");
  const match = raw.match(/^\s*version\s*:\s*([0-9A-Za-z._+-]+)/m);
  const fullVersion = match?.[1]?.trim() || "";
  return fullVersion.split("+")[0] || fullVersion;
};

const resolveVersion = (config) =>
  versionOverride ||
  readPubspecVersion() ||
  String(config.latestVersion || "").trim();

const resolveApkPath = (version, config) => {
  if (apkPathOverride) return path.resolve(process.cwd(), apkPathOverride);
  const candidates = [
    String(config.apkFileName || "").trim(),
    `${version}.apk`,
    `medicalvault_v${version}.apk`,
    `healthvault_v${version}.apk`,
    `app_v${version}.apk`,
    `app-${version}.apk`,
  ].filter(Boolean);

  for (const fileName of candidates) {
    const candidate = path.join(apkDir, fileName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return path.join(apkDir, `${version}.apk`);
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });

const main = async () => {
  if (!fs.existsSync(configPath)) {
    throw new Error(`app-update.json not found at ${configPath}`);
  }

  const config = readConfig();
  const version = resolveVersion(config);
  if (!version) {
    throw new Error(
      "Could not resolve app version from --version, pubspec.yaml, or app-update.json",
    );
  }

  const apkPath = resolveApkPath(version, config);
  if (!fs.existsSync(apkPath)) {
    throw new Error(`APK not found at ${apkPath}`);
  }

  const sha256 = await sha256File(apkPath);
  console.log(`Version : ${version}`);
  console.log(`APK     : ${apkPath}`);
  console.log(`SHA256  : ${sha256}`);

  if (!shouldWrite) return;

  const nextConfig = {
    ...config,
    latestVersion: version,
    sha256,
    checksum: sha256,
  };
  if (!String(nextConfig.minimumSupportedVersion || "").trim()) {
    nextConfig.minimumSupportedVersion = version;
  }

  fs.writeFileSync(
    configPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    "utf8",
  );
  console.log(`Updated ${configPath}`);
};

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
