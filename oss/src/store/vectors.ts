// In-process exact cosine vector cache hydrated from SQL (works on SQLite and any generic SQL connector).
import { cosineSimilarity } from "../core/ranking.ts";
import { fromFloat32Bytes, ph, tbl } from "../connectors/query.ts";
import type { SqlConnector } from "../connectors/types.ts";

export type VectorRecord = {
  entryId: string;
  model: string;
  dimensions: number;
  contentSha256: string;
  vec: Float32Array;
};

export class VectorIndex {
  private readonly items = new Map<string, VectorRecord>();
  private loadedFor: string | null = null;

  invalidate(): void {
    this.items.clear();
    this.loadedFor = null;
  }

  async ensureLoaded(connector: SqlConnector, ownerId: string): Promise<void> {
    if (this.loadedFor === ownerId) return;
    const T = (n: string) => tbl(n, connector);
    const p = (i: number) => ph(connector.dialect, i);
    const rows = await connector.query<{
      entry_id: string;
      model: string;
      dimensions: number;
      content_sha256: string;
      embedding: unknown;
    }>(
      `SELECT entry_id, model, dimensions, content_sha256, embedding FROM ${T("entry_embedding")} WHERE owner_id = ${p(1)}`,
      [ownerId],
    );
    this.items.clear();
    for (const r of rows) {
      const vec = fromFloat32Bytes(r.embedding);
      if (!vec || !vec.length) continue;
      this.items.set(r.entry_id, {
        entryId: r.entry_id,
        model: r.model,
        dimensions: Number(r.dimensions || vec.length),
        contentSha256: r.content_sha256,
        vec,
      });
    }
    this.loadedFor = ownerId;
  }

  set(record: VectorRecord): void {
    this.items.set(record.entryId, record);
  }

  delete(entryId: string): void {
    this.items.delete(entryId);
  }

  has(entryId: string, model?: string): boolean {
    const rec = this.items.get(entryId);
    if (!rec) return false;
    return model ? rec.model === model : true;
  }

  count(model?: string, dimensions?: number): number {
    if (!model) return this.items.size;
    let n = 0;
    for (const rec of this.items.values()) {
      if (rec.model === model && (!dimensions || rec.dimensions === dimensions)) n++;
    }
    return n;
  }

  search(
    queryVec: ArrayLike<number>,
    model: string,
    allowedIds: Set<string>,
    limit: number,
  ): Array<{ id: string; score: number }> {
    const scored: Array<{ id: string; score: number }> = [];
    for (const [id, rec] of this.items) {
      if (!allowedIds.has(id)) continue;
      if (rec.model !== model || rec.vec.length !== queryVec.length) continue;
      const score = cosineSimilarity(queryVec, rec.vec);
      if (Number.isFinite(score)) scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return scored.slice(0, limit);
  }
}
