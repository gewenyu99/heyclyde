import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redactText } from "../src/core/redact.ts";
import { createRuntime } from "../src/runtime/app.ts";
import { createDeviceToken, listDevices, revokeDevice } from "../src/runtime/auth.ts";
import { defaultConfig, isLoopbackHost, loadConfig, parseToml, validateConfig } from "../src/runtime/config.ts";
import { startHttpServer } from "../src/server/http.ts";
import { handleJsonRpcMessage } from "../src/server/mcp.ts";

test("TOML parser, env interpolation, CLYDE_* overrides, and loopback security checks", () => {
  const toml = [
    "# Sample configuration",
    "[server]",
    'host = "127.0.0.1" # inline comment with # hash inside?',
    'owner_name = "Local # Owner"',
    "port = 9191",
    "ui = false",
    "",
    "[embeddings]",
    'provider = "openai"',
    'api_key = "${TEST_EMBED_KEY}"',
    "dim = 768",
    "",
    "[auth]",
    'mode = "token"',
    'token = "${TEST_AUTH_TOKEN}"',
  ].join("\n");

  const parsed = parseToml(toml);
  assert.equal((parsed.server as Record<string, unknown>).port, 9191);
  assert.equal((parsed.server as Record<string, unknown>).owner_name, "Local # Owner");
  assert.equal((parsed.server as Record<string, unknown>).ui, false);

  const dir = mkdtempSync(join(tmpdir(), "clyde-cfg-"));
  const cfgPath = join(dir, "clyde.toml");
  writeFileSync(cfgPath, toml, "utf8");
  try {
    const cfg = loadConfig(cfgPath, {
      TEST_EMBED_KEY: ["sk", "fake", "1234567890abcdefghij"].join("-"),
      TEST_AUTH_TOKEN: "tok-from-env",
      CLYDE_PORT: "9292",
      CLYDE_UI: "false",
      CLYDE_DATA_DIR: join(dir, "env-data"),
      CLYDE_DB_CONNECTOR: "sqlite",
      CLYDE_DB_PREFIX: "c_",
      CLYDE_LEARN_INTERVAL_SEC: "42",
    });
    assert.equal(cfg.server.port, 9292);
    assert.equal(cfg.server.ui, false);
    assert.equal(cfg.server.data_dir, join(dir, "env-data"));
    assert.equal(cfg.database.path, join(dir, "env-data", "clyde.db"));
    assert.equal(cfg.blobs.dir, join(dir, "env-data", "blobs"));
    assert.equal(cfg.database.table_prefix, "c_");
    assert.equal(cfg.ranking.learn_interval_sec, 42);
    assert.equal(cfg.auth.token, "tok-from-env");
    assert.ok(cfg.embeddings.api_key.startsWith("sk-"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);

  const unsafe = defaultConfig();
  unsafe.server.host = "0.0.0.0";
  unsafe.auth.mode = "none";
  assert.throws(() => validateConfig(unsafe), /Refusing to bind/);

  const safeRemote = defaultConfig();
  safeRemote.server.host = "0.0.0.0";
  safeRemote.auth.mode = "token";
  safeRemote.auth.token = "strong-local-secret";
  assert.doesNotThrow(() => validateConfig(safeRemote));
});

test("Auth modes: token bearer check & device metadata/revocation enforcement over live HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clyde-auth-"));
  const cfg = defaultConfig();
  cfg.server.data_dir = dir;
  cfg.server.port = 0;
  cfg.server.ui = true;
  cfg.database.path = join(dir, "auth.db");
  cfg.blobs.dir = join(dir, "blobs");
  cfg.auth.mode = "token";
  cfg.auth.token = "secret-bearer-token-xyz";

  const runtime = await createRuntime({ config: cfg });
  const srv = await startHttpServer(runtime);
  try {
    // Public healthz & browser UI shell routes return 200/204
    assert.equal((await fetch(`${srv.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${srv.url}/`)).status, 200);
    assert.equal((await fetch(`${srv.url}/index.html`)).status, 200);
    assert.equal((await fetch(`${srv.url}/favicon.svg`)).status, 204);

    // Unauthenticated API/MCP denied with 401
    assert.equal((await fetch(`${srv.url}/api/stats`)).status, 401);
    assert.equal(
      (
        await fetch(`${srv.url}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        })
      ).status,
      401,
    );

    // Valid bearer token passes
    const okStats = await fetch(`${srv.url}/api/stats`, {
      headers: { authorization: `Bearer ${cfg.auth.token}` },
    });
    assert.equal(okStats.status, 200);

    // Switch runtime auth config to devices mode dynamically
    cfg.auth.mode = "devices";
    const dev = await createDeviceToken(runtime.connector, cfg.server.owner_id, "laptop-meta", "metadata");
    assert.ok(dev.token.startsWith("clyde_dev_"));
    assert.equal((await listDevices(runtime.connector, cfg.server.owner_id)).length, 1);

    // Metadata-only device strips prompt body when recording hook events
    const hookRes = await fetch(`${srv.url}/hooks/UserPromptSubmit?agent=laptop`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${dev.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: "dev-sess-1",
        cwd: "/tmp/proj",
        prompt: "TOP_SECRET_PROMPT_TEXT_MUST_NOT_BE_STORED",
      }),
    });
    assert.equal(hookRes.status, 200);

    const events = await runtime.connector.query<{ payload_json: string }>(
      "SELECT payload_json FROM event WHERE device = ?",
      ["laptop-meta"],
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].payload_json.includes("TOP_SECRET_PROMPT_TEXT"), false);
    assert.equal(events[0].payload_json.includes("dev-sess-1"), true);

    // Revoking device immediately enforces 401
    assert.equal(await revokeDevice(runtime.connector, cfg.server.owner_id, "laptop-meta"), true);
    const afterRevoke = await fetch(`${srv.url}/api/stats`, {
      headers: { authorization: `Bearer ${dev.token}` },
    });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await srv.close();
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Secret redaction across remember, hook payloads, and offline write_screen = redact-only + stdio JSON-RPC framing", async () => {
  // Dynamically construct synthetic secret shapes so test source contains no credential literals
  const fakeOpenAiKey = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWxYz12"].join("-");
  const fakeGithubTok = ["ghp", "1234567890abcdefghijklmnopqr"].join("_");
  const fakeAwsKey = "AKIA" + "0123456789ABCDEF";
  const fakePem = ["-----BEGIN PRIVATE ", "KEY-----\nMIIBVQIBADANBgkqhkiG\n-----END PRIVATE ", "KEY-----"].join("");

  const [redacted, kinds] = redactText(`keys: ${fakeOpenAiKey} ${fakeGithubTok} ${fakeAwsKey}\n${fakePem}`);
  assert.ok(!redacted.includes(fakeOpenAiKey));
  assert.ok(!redacted.includes(fakeGithubTok));
  assert.ok(!redacted.includes(fakeAwsKey));
  assert.ok(!redacted.includes("MIIBVQIBADANBgkqhkiG"));
  assert.ok(kinds.includes("api-key") && kinds.includes("github-token") && kinds.includes("aws-key") && kinds.includes("private-key"));

  const dir = mkdtempSync(join(tmpdir(), "clyde-redact-"));
  const cfg = defaultConfig();
  cfg.server.data_dir = dir;
  cfg.database.path = ":memory:";
  cfg.blobs.dir = join(dir, "blobs");
  cfg.embeddings.provider = "none";
  cfg.judge.provider = "none";
  cfg.judge.write_screen = "redact-only";

  const runtime = await createRuntime({ config: cfg });
  try {
    const ctx = {
      principal: { role: "owner" as const, owner: "local", principal: "stdio", hooks: "full" as const },
      sessionId: "stdio-test-1",
      clientName: "stdio-mcp",
    };

    const init = await handleJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "stdio-test" } } },
      ctx,
      runtime.store,
      "http://127.0.0.1:8787",
    );
    assert.equal(init.status, 200);

    const rem = await handleJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: {
            pattern: "observations",
            kind: "observation",
            title: `Avoid storing ${fakeOpenAiKey} in config`,
            body: `Saw token ${fakeGithubTok} in logs.`,
            evidence_kind: "assistant",
            evidence: `Cleaned ${fakeAwsKey} from example.`,
          },
        },
      },
      ctx,
      runtime.store,
      "http://127.0.0.1:8787",
    );
    const remResult = (rem.body as Record<string, unknown> | undefined)?.result as
      | { isError?: boolean; content?: { text: string }[] }
      | undefined;
    assert.equal(remResult?.isError, false, remResult?.content?.[0]?.text);
    const remId = remResult?.content?.[0]?.text?.match(/^Remembered ([^\s.]+)/)?.[1];
    assert.ok(remId, `Expected generated ID in: ${remResult?.content?.[0]?.text}`);

    const rows = await runtime.connector.query<{ title: string; body: string; evidence: string }>(
      "SELECT title, body, evidence FROM entry WHERE id = ?",
      [remId],
    );
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].title.includes(fakeOpenAiKey));
    assert.ok(rows[0].title.includes("[redacted:api-key]"));
    assert.ok(!rows[0].body.includes(fakeGithubTok));
    assert.ok(rows[0].body.includes("[redacted:github-token]"));
    assert.ok(!rows[0].evidence.includes(fakeAwsKey));
    assert.ok(rows[0].evidence.includes("[redacted:aws-key]"));
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
