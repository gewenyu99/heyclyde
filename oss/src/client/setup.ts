// Client configuration generators and optional local installation for Claude Code, Codex, Gemini CLI, and Antigravity.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildHookScript, LOCAL_CLYDE_RULE } from "./hook.ts";

export type SetupBundle = {
  url: string;
  hookPath: string;
  claudeMcp: Record<string, unknown>;
  codexToml: string;
  geminiSettings: Record<string, unknown>;
  antigravityMcp: Record<string, unknown>;
};

export function generateSetupBundle(url: string, token?: string): SetupBundle {
  const cleanUrl = url.replace(/\/+$/, "");
  const mcpUrl = `${cleanUrl}/mcp`;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const hookPath = join(homedir(), ".config", "clyde", "clyde-hook.sh");

  const claudeMcp = {
    type: "http",
    url: mcpUrl,
    ...(headers ? { headers } : {}),
  };

  const codexLines = [
    "[mcp_servers.clyde]",
    `url = "${mcpUrl}"`,
    ...(token ? [`http_headers = { "Authorization" = "Bearer ${token}" }`] : []),
    "",
    "[features]",
    "memories = false",
  ];

  const geminiSettings = {
    mcpServers: {
      clyde: {
        httpUrl: mcpUrl,
        ...(headers ? { headers } : {}),
      },
    },
  };

  const antigravityMcp = {
    mcpServers: {
      clyde: {
        serverUrl: mcpUrl,
        ...(headers ? { headers } : {}),
      },
    },
  };

  return {
    url: cleanUrl,
    hookPath,
    claudeMcp,
    codexToml: codexLines.join("\n"),
    geminiSettings,
    antigravityMcp,
  };
}

export function applyLocalClientSetup(url: string, token?: string): { wrote: string[] } {
  const cleanUrl = url.replace(/\/+$/, "");
  const cfgDir = join(homedir(), ".config", "clyde");
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });

  const wrote: string[] = [];
  const urlFile = join(cfgDir, "url");
  writeFileSync(urlFile, cleanUrl + "\n", { mode: 0o600 });
  wrote.push(urlFile);

  if (token) {
    const tokFile = join(cfgDir, "token");
    writeFileSync(tokFile, token + "\n", { mode: 0o600 });
    wrote.push(tokFile);
  }

  const hookFile = join(cfgDir, "clyde-hook.sh");
  writeFileSync(hookFile, buildHookScript(cleanUrl), { mode: 0o700 });
  chmodSync(hookFile, 0o700);
  wrote.push(hookFile);

  const ruleFile = join(cfgDir, "clyde-rule.md");
  writeFileSync(ruleFile, LOCAL_CLYDE_RULE, { mode: 0o600 });
  wrote.push(ruleFile);

  // Merge non-destructively into ~/.claude.json only if it already exists.
  const claudeJson = join(homedir(), ".claude.json");
  if (existsSync(claudeJson)) {
    try {
      const obj = JSON.parse(readFileSync(claudeJson, "utf8")) as Record<string, unknown>;
      const mcp = (obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {}) as Record<string, unknown>;
      mcp.clyde = generateSetupBundle(cleanUrl, token).claudeMcp;
      obj.mcpServers = mcp;
      mkdirSync(dirname(claudeJson), { recursive: true });
      writeFileSync(claudeJson, JSON.stringify(obj, null, 2) + "\n");
      wrote.push(claudeJson);
    } catch {
      // Leave malformed user config untouched.
    }
  }

  return { wrote };
}
