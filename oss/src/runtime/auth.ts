// Authentication and device token management for local HTTP, MCP, and hook endpoints.
import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { nowIso, ph, tbl } from "../connectors/query.ts";
import type { SqlConnector } from "../connectors/types.ts";
import type { ClydeConfig } from "./config.ts";

export type LocalPrincipal = {
  role: "owner" | "device";
  owner: string;
  principal: string;
  hooks: "full" | "metadata";
};

export function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !a) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export async function createDeviceToken(
  connector: SqlConnector,
  ownerId: string,
  name: string,
  hooks: "full" | "metadata" = "full",
): Promise<{ id: number | string; name: string; token: string; hooks: string }> {
  const token = `clyde_dev_${randomBytes(24).toString("base64url")}`;
  const hash = sha256Hex(token);
  const T = (n: string) => tbl(n, connector);
  const p = (i: number) => ph(connector.dialect, i);
  const res = await connector.execute(
    `INSERT INTO ${T("device")} (owner_id, name, token_sha256, hooks, created_at) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)})`,
    [ownerId, name, hash, hooks, nowIso()],
  );
  let id: number | string = res.lastInsertId ?? 0;
  if (!id) {
    const rows = await connector.query<{ id: number }>(
      `SELECT id FROM ${T("device")} WHERE owner_id = ${p(1)} AND token_sha256 = ${p(2)}`,
      [ownerId, hash],
    );
    id = rows[0]?.id ?? 0;
  }
  return { id, name, token, hooks };
}

export async function listDevices(connector: SqlConnector, ownerId: string) {
  const T = (n: string) => tbl(n, connector);
  const p = (i: number) => ph(connector.dialect, i);
  return await connector.query<{
    id: number;
    name: string;
    hooks: string;
    created_at: string;
    last_seen: string | null;
    revoked_at: string | null;
  }>(
    `SELECT id, name, hooks, created_at, last_seen, revoked_at FROM ${T("device")} WHERE owner_id = ${p(1)} ORDER BY id`,
    [ownerId],
  );
}

export async function revokeDevice(connector: SqlConnector, ownerId: string, deviceNameOrId: string): Promise<boolean> {
  const T = (n: string) => tbl(n, connector);
  const p = (i: number) => ph(connector.dialect, i);
  const byId = /^\d+$/.test(deviceNameOrId);
  const res = await connector.execute(
    `UPDATE ${T("device")} SET revoked_at = ${p(1)} WHERE owner_id = ${p(2)} AND revoked_at IS NULL AND ${byId ? `id = ${p(3)}` : `name = ${p(3)}`}`,
    [nowIso(), ownerId, byId ? Number(deviceNameOrId) : deviceNameOrId],
  );
  return res.rowsAffected > 0;
}

export async function authenticateRequest(
  req: Request,
  path: string,
  config: ClydeConfig,
  connector: SqlConnector,
): Promise<LocalPrincipal | Response> {
  // Healthcheck, static root UI shell (if enabled), and signed upload URLs handle their own authorization.
  if (path === "/healthz" || path.startsWith("/blobs/upload/")) {
    return { role: "owner", owner: config.server.owner_id, principal: "local", hooks: "full" };
  }
  if (config.auth.mode === "none") {
    return { role: "owner", owner: config.server.owner_id, principal: "local", hooks: "full" };
  }
  // Allow loading browser HTML shell without bearer header when UI is enabled; API/MCP calls still enforce bearer token.
  if (config.server.ui && req.method === "GET" && (path === "/" || path === "/index.html" || path === "/favicon.svg")) {
    return { role: "owner", owner: config.server.owner_id, principal: "browser-shell", hooks: "full" };
  }

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const givenHash = sha256Hex(token);
  if (config.auth.mode === "token") {
    const wantHash = sha256Hex(config.auth.token);
    if (!safeEqualHex(givenHash, wantHash)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return { role: "owner", owner: config.server.owner_id, principal: "token", hooks: "full" };
  }

  // Device token table mode.
  const T = (n: string) => tbl(n, connector);
  const p = (i: number) => ph(connector.dialect, i);
  const rows = await connector.query<{ id: number; name: string; hooks: string }>(
    `SELECT id, name, hooks FROM ${T("device")} WHERE owner_id = ${p(1)} AND token_sha256 = ${p(2)} AND revoked_at IS NULL`,
    [config.server.owner_id, givenHash],
  );
  const dev = rows[0];
  if (!dev) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  await connector.execute(
    `UPDATE ${T("device")} SET last_seen = ${p(1)} WHERE id = ${p(2)}`,
    [nowIso(), dev.id],
  ).catch(() => {});
  return {
    role: "device",
    owner: config.server.owner_id,
    principal: dev.name,
    hooks: dev.hooks === "metadata" ? "metadata" : "full",
  };
}
