// Newline-delimited JSON-RPC MCP transport over stdin/stdout for local CLI tools.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { createInterface } from "node:readline";
import type { LocalPrincipal } from "../runtime/auth.ts";
import type { ClydeRuntime } from "../runtime/app.ts";
import { handleJsonRpcMessage } from "./mcp.ts";

export async function startStdioMcp(runtime: ClydeRuntime): Promise<void> {
  const sessionId = randomUUID();
  const principal: LocalPrincipal = {
    role: "owner",
    owner: runtime.config.server.owner_id,
    principal: "stdio",
    hooks: "full",
  };
  const baseUrl = `http://${runtime.config.server.host}:${runtime.config.server.port}`;

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      continue;
    }
    const res = await handleJsonRpcMessage(msg, { principal, sessionId, clientName: "stdio-mcp" }, runtime.store, baseUrl);
    if (res.body !== undefined) {
      process.stdout.write(JSON.stringify(res.body) + "\n");
    }
  }
}
