#!/usr/bin/env node
// Security, secret-leak, cloud-reference, and self-containment auditor for the open-source mirror.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const targetDir = resolve(process.argv[2] ?? join(process.cwd(), "oss"));
if (!existsSync(targetDir)) {
  console.error(`audit-oss: target directory does not exist: ${targetDir}`);
  process.exit(2);
}

const SKIP_DIRS = new Set([".git", "node_modules"]);
const FORBIDDEN_FILE_PATTERNS = [
  /^\.env($|\.(?!example$))/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i,
];

// Literal secret shapes (checked everywhere except regex-pattern declaration lines inside src/core/redact.ts).
const SECRET_RULES = [
  { id: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "sk-api-key", re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { id: "sb-secret", re: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{12,}/g },
  { id: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g },
  { id: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe-key", re: /\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: "jwt-token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: "db-url-cred", re: /\b(?:postgres(?:ql)?|mysql|mariadb|libsql):\/\/[^:\s/]+:(?!pass(?:word)?@|example@|\$\{)[^@\s]{3,}@/gi },
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const ALLOWED_EMAIL_DOMAINS = /^(?:.+\.invalid|example\.com|example\.org|example\.net|users\.noreply\.github\.com)$/i;

// HeyClyde Cloud, billing, infra, personal, and internal milestone/eval strings (must be 0 matches).
const CLOUD_TERMS = [
  /heyclyde/i,
  /heyclyde\.me/i,
  /wlhlncmgjqyidosunugv/i,
  /supabase/i,
  /polar/i,
  /paddle/i,
  /cloudflare/i,
  /wrangler/i,
  /turnstile/i,
  /resend/i,
  /pennywhistle/i,
  /billing/i,
  /entitlement/i,
  /overage/i,
  /starter_checkout/i,
  /checkout_url/i,
  /free_slot/i,
  /free_per_paid/i,
  /claim_free_seat/i,
  /spend_limit_cents/i,
  /price_micro_usd/i,
  /12\.99/,
  /2\.99/,
  /4\.19/,
  /allowlisted/i,
  /allowed_email/i,
  /open_signup/i,
  /reseed_reviewer/i,
  /review@/i,
  /pgroonga/i,
  /pg_cron/i,
  /pg_net/i,
  /EdgeRuntime/,
  /vault\.decrypted_secrets/i,
  /vault\.secrets/i,
  /memory_tenant/i,
  /memory_console/i,
  /PROXY_SECRET/i,
  /x-memory-proxy/i,
  /x-memory-host/i,
  /cf-ipcountry/i,
  /cf-region-code/i,
  /MEMORY_BACKUP_KEY/i,
  /\bwen\b/i,
  /wen's/i,
  /vincent/i,
  /gewenyu/i,
  /\/Users\//,
  /like-vincent/i,
  /clyde-flow/i,
  /paseo/i,
  /dispatch_quest/i,
  /warlock/i,
  /journeymate/i,
  /localsubs/i,
  /quietsubs/i,
  /posthog/i,
  /\bdmia\b/i,
  /LEARNING-PLAN/i,
  /SUPABASE-PLAN/i,
  /MODEL-PLAN/i,
  /PRODUCT-PLAN/i,
  /CLYDE-DESIGN/i,
  /seed\/build\.py/i,
  /\bR(?:20|24|25|28|29|31|32|33|34|38|41|43|44|45|46|47|49|50|51|53|54|55|58|59|61|62|65|66|67|69|70|72|74|75|76|78)\b/,
  /eval\/labels/i,
  /qrel/i,
  /zh-probes/i,
  /golden-v1/i,
  /ants\.py/i,
];

const IMPORT_BOUNDARY_RULES = [
  { id: "parent-memory-import", re: /['"]\.\.?\/[^'"]*\/memory(?:\/|['"])/g },
  { id: "remote-deno-import", re: /https:\/\/deno\.land/g },
  { id: "jsr-import", re: /['"]jsr:/g },
  { id: "npm-supabase-import", re: /['"]npm:@supabase/g },
  { id: "deno-global-runtime", re: /\bDeno\./g },
];

const findings = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function scanText(relPath, text, opts = {}) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;

    for (const term of CLOUD_TERMS) {
      const m = line.match(term);
      if (m) {
        findings.push({
          gate: "cloud-or-personal",
          file: relPath,
          line: ln,
          detail: `Matched ${term}: ${JSON.stringify(m[0])}`,
        });
      }
    }

    if (!(opts.skipSecretRulesForRedactDef && line.trim().startsWith("[") && line.includes("/"))) {
      for (const rule of SECRET_RULES) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(line);
        if (m) {
          findings.push({
            gate: "secret-leak",
            file: relPath,
            line: ln,
            detail: `Matched ${rule.id}: ${JSON.stringify(m[0].slice(0, 24))}...`,
          });
        }
      }
    }

    if (!opts.isGitLog || !line.startsWith("Author:") && !line.startsWith("Commit:")) {
      EMAIL_RE.lastIndex = 0;
      let em;
      while ((em = EMAIL_RE.exec(line)) !== null) {
        if (!ALLOWED_EMAIL_DOMAINS.test(em[1])) {
          findings.push({
            gate: "email-leak",
            file: relPath,
            line: ln,
            detail: `Unexpected email address: ${em[0]}`,
          });
        }
      }
    } else {
      // Git commit author/committer lines must also use an allowed synthetic domain (e.g. .invalid).
      EMAIL_RE.lastIndex = 0;
      let em;
      while ((em = EMAIL_RE.exec(line)) !== null) {
        if (!ALLOWED_EMAIL_DOMAINS.test(em[1])) {
          findings.push({
            gate: "git-author-email",
            file: relPath,
            line: ln,
            detail: `Non-synthetic git metadata email: ${em[0]}`,
          });
        }
      }
    }

    if (opts.checkImports) {
      for (const br of IMPORT_BOUNDARY_RULES) {
        br.re.lastIndex = 0;
        const m = br.re.exec(line);
        if (m) {
          findings.push({
            gate: "import-boundary",
            file: relPath,
            line: ln,
            detail: `Matched ${br.id}: ${JSON.stringify(m[0])}`,
          });
        }
      }
    }
  }
}

const files = walk(targetDir);
for (const abs of files) {
  const rel = relative(targetDir, abs).replace(/\\/g, "/");
  for (const fp of FORBIDDEN_FILE_PATTERNS) {
    if (fp.test(rel)) {
      findings.push({ gate: "forbidden-file", file: rel, detail: `Forbidden file pattern ${fp}` });
    }
  }
  for (const term of CLOUD_TERMS) {
    if (term.test(rel)) {
      findings.push({ gate: "forbidden-filename", file: rel, detail: `Path matched ${term}` });
    }
  }
  const raw = readFileSync(abs);
  if (raw.includes(0)) continue; // skip binary assets
  const text = raw.toString("utf8");
  scanText(rel, text, {
    skipSecretRulesForRedactDef: rel === "src/core/redact.ts",
    checkImports: /^(src|test)\/.*\.(ts|mts|js|mjs)$/.test(rel),
  });
}

if (existsSync(join(targetDir, ".git"))) {
  const revCount = execFileSync("git", ["-C", targetDir, "rev-list", "--count", "--all"], { encoding: "utf8" }).trim();
  if (Number(revCount) > 1) {
    findings.push({
      gate: "git-history",
      file: ".git",
      detail: `Expected single orphan release commit, found ${revCount} commits.`,
    });
  }
  const log = execFileSync("git", ["-C", targetDir, "log", "--format=fuller", "-p", "--all"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  scanText(".git/log", log, { isGitLog: true });
}

if (findings.length > 0) {
  console.error(`audit-oss FAILED with ${findings.length} finding(s) in ${targetDir}:`);
  for (const f of findings) {
    console.error(`  [${f.gate}] ${f.file}${f.line ? `:${f.line}` : ""} - ${f.detail}`);
  }
  process.exit(1);
}

console.log(`audit-oss PASSED (${files.length} files${existsSync(join(targetDir, ".git")) ? " + git history" : ""}, 0 findings): ${targetDir}`);
