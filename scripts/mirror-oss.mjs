#!/usr/bin/env node
// Syncs pure WinterCG core algorithms into oss/src/core/ and exports a clean standalone mirror.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_CORE = join(ROOT, "memory", "supabase", "functions", "memory", "core");
const OSS_DIR = join(ROOT, "oss");
const OSS_CORE = join(OSS_DIR, "src", "core");
const AUDIT_SCRIPT = join(ROOT, "scripts", "audit-oss.mjs");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const doCommit = args.includes("--commit");
const exportIdx = args.indexOf("--export");
const exportTarget = exportIdx !== -1 ? resolve(args[exportIdx + 1] ?? "") : null;

if (exportIdx !== -1 && !args[exportIdx + 1]) {
  console.error("Usage: node scripts/mirror-oss.mjs [--check] [--export <dir> [--commit]]");
  process.exit(2);
}

function listTs(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).sort() : [];
}

function syncCore(verifyOnly) {
  const srcFiles = listTs(SRC_CORE);
  const dstFiles = listTs(OSS_CORE);
  const diffs = [];

  for (const f of srcFiles) {
    const srcBuf = readFileSync(join(SRC_CORE, f));
    const dstPath = join(OSS_CORE, f);
    if (!existsSync(dstPath) || !readFileSync(dstPath).equals(srcBuf)) {
      if (verifyOnly) diffs.push(`out-of-sync: oss/src/core/${f}`);
      else writeFileSync(dstPath, srcBuf);
    }
  }
  for (const f of dstFiles) {
    if (!srcFiles.includes(f)) {
      if (verifyOnly) diffs.push(`stale file in oss/src/core/: ${f}`);
      else rmSync(join(OSS_CORE, f), { force: true });
    }
  }
  return diffs;
}

const SKIP_COPY = new Set([".git", "node_modules", ".DS_Store", "clyde.toml", ".env"]);
function shouldCopy(relPath) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  for (const p of parts) {
    if (SKIP_COPY.has(p)) return false;
  }
  if (/\.(db|db-wal|db-shm|sqlite|sqlite3)$/i.test(relPath)) return false;
  return true;
}

function mirrorTree(srcRoot, dstRoot) {
  mkdirSync(dstRoot, { recursive: true });
  const keep = new Set();

  function copyRec(curSrc, curDst, relPrefix) {
    for (const name of readdirSync(curSrc).sort()) {
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (!shouldCopy(rel)) continue;
      keep.add(rel);
      const srcPath = join(curSrc, name);
      const dstPath = join(curDst, name);
      const st = statSync(srcPath);
      if (st.isDirectory()) {
        mkdirSync(dstPath, { recursive: true });
        copyRec(srcPath, dstPath, rel);
      } else if (st.isFile()) {
        cpSync(srcPath, dstPath, { force: true });
      }
    }
  }
  copyRec(srcRoot, dstRoot, "");

  // Prune stale entries in dstRoot (leaving .git alone if caller handles git separately).
  function pruneRec(curDst, relPrefix) {
    if (!existsSync(curDst)) return;
    for (const name of readdirSync(curDst)) {
      if (name === ".git") continue;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const dstPath = join(curDst, name);
      if (!keep.has(rel)) {
        rmSync(dstPath, { recursive: true, force: true });
      } else if (statSync(dstPath).isDirectory()) {
        pruneRec(dstPath, rel);
      }
    }
  }
  pruneRec(dstRoot, "");
}

if (checkOnly) {
  const diffs = syncCore(true);
  if (diffs.length) {
    console.error("mirror-oss --check FAILED:");
    for (const d of diffs) console.error(`  ${d}`);
    process.exit(1);
  }
  execFileSync(process.execPath, [AUDIT_SCRIPT, OSS_DIR], { stdio: "inherit" });
  console.log("mirror-oss --check PASSED.");
  process.exit(0);
}

mkdirSync(OSS_CORE, { recursive: true });
syncCore(false);
console.log(`Synced ${listTs(OSS_CORE).length} core modules -> oss/src/core/`);

if (exportTarget) {
  if (exportTarget === ROOT || exportTarget === OSS_DIR) {
    console.error("Refusing to export over source repository directory.");
    process.exit(2);
  }
  // Reset any prior .git before copying if rebuilding an orphan release commit.
  if (doCommit) rmSync(join(exportTarget, ".git"), { recursive: true, force: true });
  mirrorTree(OSS_DIR, exportTarget);
  console.log(`Exported standalone mirror -> ${exportTarget}`);

  if (doCommit) {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Clyde Contributors",
      GIT_AUTHOR_EMAIL: "noreply@clyde-memory.invalid",
      GIT_COMMITTER_NAME: "Clyde Contributors",
      GIT_COMMITTER_EMAIL: "noreply@clyde-memory.invalid",
    };
    execFileSync("git", ["-C", exportTarget, "init", "-b", "main"], { env: gitEnv, stdio: "inherit" });
    execFileSync("git", ["-C", exportTarget, "config", "user.name", "Clyde Contributors"], { env: gitEnv, stdio: "inherit" });
    execFileSync("git", ["-C", exportTarget, "config", "user.email", "noreply@clyde-memory.invalid"], { env: gitEnv, stdio: "inherit" });
    execFileSync("git", ["-C", exportTarget, "add", "-A"], { env: gitEnv, stdio: "inherit" });
    execFileSync("git", ["-C", exportTarget, "commit", "-m", "Sync open-source release"], { env: gitEnv, stdio: "inherit" });
  }

  execFileSync(process.execPath, [AUDIT_SCRIPT, exportTarget], { stdio: "inherit" });
}
