#!/usr/bin/env node
// Local CLI for running, configuring, backing up, and checking Clyde.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyLocalClientSetup, generateSetupBundle } from "./client/setup.ts";
import { createRuntime } from "./runtime/app.ts";
import { createDeviceToken, listDevices, revokeDevice } from "./runtime/auth.ts";
import { EXAMPLE_CONFIG_TOML, loadConfig } from "./runtime/config.ts";
import { startHttpServer } from "./server/http.ts";
import { startStdioMcp } from "./server/stdio.ts";

export const HELP_TEXT = `clyde - shared local memory for AI coding agents

Usage:
  clyde serve [--config <path>] [--host <ip>] [--port <n>]
  clyde mcp [--config <path>]
  clyde init [--out <clyde.toml>] [--force]
  clyde setup [--url <url>] [--token <token>] [--apply] [--config <path>]
  clyde token create <device-name> [--hooks full|metadata] [--config <path>]
  clyde token list [--config <path>]
  clyde token revoke <name-or-id> [--config <path>]
  clyde export [--out <file.ndjson>] [--config <path>]
  clyde import <file.ndjson> [--config <path>]
  clyde learn [--config <path>]
  clyde embed [--config <path>]
  clyde doctor [--config <path>]
  clyde help
`;

function parseFlags(argv: string[]) {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

export async function runCli(argv: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(argv);
  const cmd = positionals[0] || "help";
  const cfgPath = typeof flags.config === "string" ? flags.config : undefined;

  if (cmd === "help" || flags.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  if (cmd === "init") {
    const out = resolve(typeof flags.out === "string" ? flags.out : "clyde.toml");
    if (existsSync(out) && !flags.force) {
      console.error(`File already exists: ${out}. Pass --force to overwrite it.`);
      return 1;
    }
    writeFileSync(out, EXAMPLE_CONFIG_TOML, "utf8");
    console.log(`Wrote starter config to ${out}`);
    return 0;
  }

  if (cmd === "setup") {
    const cfg = loadConfig(cfgPath);
    const url = typeof flags.url === "string" ? flags.url : `http://${cfg.server.host}:${cfg.server.port}`;
    const token = typeof flags.token === "string" ? flags.token : (cfg.auth.token || undefined);
    if (flags.apply) {
      const res = applyLocalClientSetup(url, token);
      console.log(`Installed hook scripts and config files:\n${res.wrote.map((p) => `- ${p}`).join("\n")}`);
      return 0;
    }
    const bundle = generateSetupBundle(url, token);
    console.log(JSON.stringify(bundle, null, 2));
    return 0;
  }

  const config = loadConfig(cfgPath);
  if (typeof flags.host === "string") config.server.host = flags.host;
  if (typeof flags.port === "string") config.server.port = Number(flags.port);

  if (cmd === "serve") {
    const runtime = await createRuntime({ config });
    const started = await startHttpServer(runtime);
    console.error(`Clyde Local listening on ${started.url} (connector=${config.database.connector}, auth=${config.auth.mode})`);
    const shutdown = async () => {
      await started.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return -1; // keep running
  }

  const runtime = await createRuntime({ config });
  try {
    if (cmd === "mcp") {
      await startStdioMcp(runtime);
      return 0;
    }

    if (cmd === "token") {
      const sub = positionals[1];
      if (sub === "create") {
        const name = positionals[2];
        if (!name) {
          console.error("Usage: clyde token create <device-name> [--hooks full|metadata]");
          return 1;
        }
        const hooks = flags.hooks === "metadata" ? "metadata" : "full";
        const dev = await createDeviceToken(runtime.connector, config.server.owner_id, name, hooks);
        console.log(JSON.stringify(dev, null, 2));
        return 0;
      }
      if (sub === "list") {
        console.log(JSON.stringify(await listDevices(runtime.connector, config.server.owner_id), null, 2));
        return 0;
      }
      if (sub === "revoke") {
        const target = positionals[2];
        if (!target) {
          console.error("Usage: clyde token revoke <name-or-id>");
          return 1;
        }
        const ok = await revokeDevice(runtime.connector, config.server.owner_id, target);
        console.log(ok ? `Revoked ${target}.` : `Device ${target} not found or already revoked.`);
        return ok ? 0 : 1;
      }
      console.error("Unknown token subcommand. Use create, list, or revoke.");
      return 1;
    }

    if (cmd === "export") {
      const ndjson = await runtime.store.exportNdjson();
      if (typeof flags.out === "string") {
        writeFileSync(resolve(flags.out), ndjson, "utf8");
        console.log(`Exported backup to ${resolve(flags.out)}`);
      } else {
        process.stdout.write(ndjson);
      }
      return 0;
    }

    if (cmd === "import") {
      const file = positionals[1];
      if (!file) {
        console.error("Usage: clyde import <file.ndjson>");
        return 1;
      }
      const res = await runtime.store.importNdjson(readFileSync(resolve(file), "utf8"));
      console.log(JSON.stringify(res));
      return 0;
    }

    if (cmd === "learn") {
      console.log(JSON.stringify(await runtime.store.learn(), null, 2));
      return 0;
    }

    if (cmd === "embed") {
      const n = await runtime.store.syncEmbeddings();
      console.log(JSON.stringify({ embedded: n }));
      return 0;
    }

    if (cmd === "doctor") {
      const st = await runtime.store.stats();
      console.log(JSON.stringify({ ok: true, config: { host: config.server.host, port: config.server.port, auth: config.auth.mode }, ...st }, null, 2));
      return 0;
    }

    console.error(`Unknown command: ${cmd}\n`);
    console.log(HELP_TEXT);
    return 1;
  } finally {
    await runtime.close();
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1].endsWith("/cli.ts") || process.argv[1].endsWith("\\cli.ts");
  }
})();
if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
