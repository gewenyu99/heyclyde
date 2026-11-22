// Runtime assembly tying configuration, SQL connector, blob storage, LLM adapter, MemoryStore, and scheduler together.
import { loadConnector } from "../connectors/custom.ts";
import { migrate } from "../connectors/schema.ts";
import type { SqlConnector } from "../connectors/types.ts";
import { MemoryStore } from "../store/memory-store.ts";
import { type BlobStore, InlineSqlBlobStore, LocalFsBlobStore } from "./blobs.ts";
import { type ClydeConfig, loadConfig } from "./config.ts";
import { createLlmProvider, type LlmProvider } from "./llm.ts";
import { LocalScheduler } from "./scheduler.ts";

export type ClydeRuntime = {
  config: ClydeConfig;
  connector: SqlConnector;
  blobs: BlobStore;
  llm: LlmProvider;
  store: MemoryStore;
  scheduler: LocalScheduler;
  close(): Promise<void>;
};

export async function createRuntime(opts: {
  config?: ClydeConfig;
  configPath?: string;
  connector?: SqlConnector;
} = {}): Promise<ClydeRuntime> {
  const config = opts.config ?? loadConfig(opts.configPath);
  const connector = opts.connector ?? await loadConnector(config.database, config.configDir);
  await migrate(connector);

  const blobs: BlobStore = config.blobs.backend === "sql"
    ? new InlineSqlBlobStore({
      inlineMaxBytes: config.blobs.inline_max_bytes,
      maxBlobBytes: config.blobs.max_blob_bytes,
      maxQuotaBytes: config.blobs.max_quota_bytes,
    })
    : new LocalFsBlobStore({
      dir: config.blobs.dir,
      inlineMaxBytes: config.blobs.inline_max_bytes,
      maxBlobBytes: config.blobs.max_blob_bytes,
      maxQuotaBytes: config.blobs.max_quota_bytes,
    });

  const llm = createLlmProvider(config);
  const store = new MemoryStore(connector, blobs, llm, config);
  const scheduler = new LocalScheduler(store, config);
  let closed = false;

  return {
    config,
    connector,
    blobs,
    llm,
    store,
    scheduler,
    async close() {
      if (closed) return;
      closed = true;
      await scheduler.stop();
      await connector.close();
    },
  };
}
