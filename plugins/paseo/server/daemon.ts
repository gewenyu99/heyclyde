/**
 * The clyde daemon on this machine, through ~/.clyde/daemon.json. One SSE subscription bumps a revision on every event,
 * and waiters long-poll on it, since Paseo's plugin API has RPCs but no push.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WAIT_MS = 20_000;
const RECONNECT_MS = 3_000;

type Info = { port: number; token: string };

function home(): string {
  return process.env.CLYDE_HOME || join(homedir(), ".clyde");
}

export function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(home(), name), "utf8")) as T;
  } catch {
    return null;
  }
}

function info(): Info {
  const i = readJson<Info>("daemon.json");
  if (!i) throw new Error("clyde isn't running on this machine. Run clyde up.");
  return i;
}

export async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const i = info();
  const res = await fetch(`http://127.0.0.1:${i.port}${path}`, {
    method, headers: { authorization: `Bearer ${i.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clyde answered ${res.status} for ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export type Live = { revision(): number; wait(after: number, ms?: number): Promise<number>; close(): void };

/** Follows the daemon's event stream. Every event, and every reconnect, moves the revision and wakes the waiters. */
export async function ensureCompanion() {
  const path=join(process.env.PASEO_HOME || join(homedir(),".paseo"),"config.json");
  const source=JSON.parse(readFileSync(path,"utf8")).plugins?.clyde;
  if(source?.source!=="directory" || !source.path)return;
  const bin=join(source.path,"runtime","bin","clyde.ts");
  if(existsSync(bin))await promisify(execFile)("node",[bin,"daemon","ensure"],{timeout:20000});
}

export function follow(recover?:()=>Promise<void>): Live {
  let lastRecovery=0;
  let revision = 0;
  let closed = false;
  let abort: AbortController | null = null;
  const waiters = new Set<() => void>();
  const bump = (id?: number) => {
    revision = Math.max(revision + 1, id ?? 0);
    for (const wake of [...waiters]) wake();
  };

  async function connect(): Promise<void> {
    while (!closed) {
      try {
        const i = info();
        abort = new AbortController();
        const res = await fetch(`http://127.0.0.1:${i.port}/events?since=${Number.MAX_SAFE_INTEGER}`, {
          headers: { authorization: `Bearer ${i.token}` }, signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events answered ${res.status}`);
        bump();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const id = frame.match(/^id: (\d+)/m)?.[1];
            if (/^data: /m.test(frame)) bump(id ? Number(id) : undefined);
          }
        }
      } catch {
        if(!closed && recover && Date.now()-lastRecovery>=30000){
          lastRecovery=Date.now();
          try { await recover(); } catch { /* Retry after a failed local startup. */ }
        }
      }
      if (!closed) await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  }
  void connect();

  return {
    revision: () => revision,
    wait(after, ms = WAIT_MS) {
      if (revision > after) return Promise.resolve(revision);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve(revision);
        };
        const timer = setTimeout(done, ms);
        waiters.add(done);
      });
    },
    close() {
      closed = true;
      abort?.abort();
      for (const wake of [...waiters]) wake();
    },
  };
}
