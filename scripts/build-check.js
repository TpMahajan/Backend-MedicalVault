import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "apk",
  "coverage",
  "dist",
  "build",
]);

const SCAN_ROOTS = [
  ".",
  "config",
  "controllers",
  "middleware",
  "models",
  "routes",
  "services",
  "utils",
  "backend",
];

function collectJsFiles(startPath, output) {
  if (!fs.existsSync(startPath)) return;
  const stat = fs.statSync(startPath);
  if (stat.isFile()) {
    if (startPath.endsWith(".js")) {
      output.push(startPath);
    }
    return;
  }

  for (const entry of fs.readdirSync(startPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(startPath, entry.name);

    if (entry.isDirectory()) {
      collectJsFiles(fullPath, output);
      continue;
    }

    if (entry.isFile() && fullPath.endsWith(".js")) {
      output.push(fullPath);
    }
  }
}

function uniqueSorted(list) {
  return [...new Set(list)].sort((a, b) => a.localeCompare(b));
}

function runNodeCheck(filePath) {
  return spawnSync(process.execPath, ["--check", filePath], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
}

const allCandidates = [];
for (const relativeRoot of SCAN_ROOTS) {
  const absoluteRoot = path.join(projectRoot, relativeRoot);
  collectJsFiles(absoluteRoot, allCandidates);
}

const jsFiles = uniqueSorted(allCandidates);
if (jsFiles.length === 0) {
  console.error("Build check failed: no JavaScript files found to validate.");
  process.exit(1);
}

const failures = [];
for (const filePath of jsFiles) {
  const result = runNodeCheck(filePath);
  if (result.status !== 0) {
    failures.push({
      filePath,
      stderr: (result.stderr || "").trim(),
      stdout: (result.stdout || "").trim(),
    });
  }
}

if (failures.length > 0) {
  console.error(
    `Backend build check failed in ${failures.length} file(s):`
  );
  for (const failure of failures) {
    const rel = path.relative(projectRoot, failure.filePath);
    console.error(`\n- ${rel}`);
    if (failure.stderr) {
      console.error(failure.stderr);
    } else if (failure.stdout) {
      console.error(failure.stdout);
    } else {
      console.error("Unknown syntax validation error.");
    }
  }
  process.exit(1);
}

console.log(`Backend build check passed (${jsFiles.length} JS files validated).`);
