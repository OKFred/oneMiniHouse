import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface ProtocolFrame {
  direction: 'tx' | 'rx'; protocol: 'yunmu-v5' | 'modbus-rtu';
  frame_time_utc: string; wire_hex: string; crc_valid?: boolean;
}
export type FrameObserver = (frame: ProtocolFrame) => void;
export interface FrameEnvelope extends ProtocolFrame {
  schema_version: 1; frame_id: string; collection_id: string;
  site_id: string; gateway_id: string; device_id: string;
}
export const frameEnvelope = (identity: Pick<FrameEnvelope, 'site_id' | 'gateway_id' | 'device_id' | 'collection_id'>, frame: ProtocolFrame): FrameEnvelope => ({
  schema_version: 1, frame_id: randomUUID(), ...identity, ...frame,
});
export class FrameStorageError extends Error {}

// This is a bounded protocol archive, independent of business outbox retention.
// PUBACK marks a frame delivered; the archive remains until age/count retention.
export class FrameStore {
  private db: DatabaseSync;
  private limits: { maxAgeDays: number; maxRows: number };
  constructor(path: string, limits = { maxAgeDays: 30, maxRows: 250000 }) {
    this.limits = limits;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS frames (seq INTEGER PRIMARY KEY AUTOINCREMENT, frame_id TEXT UNIQUE NOT NULL, topic TEXT NOT NULL, payload TEXT NOT NULL, store_time_utc INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS frames_pending ON frames(published,seq);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO counters VALUES ('dropped_pending',0),('pruned',0);`);
  }
  save(topic: string, frame: FrameEnvelope, now = Date.now()) {
    if (!/^(?:[a-f\d]{2}){1,512}$/i.test(frame.wire_hex)) throw new FrameStorageError('Invalid or oversized protocol frame');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT INTO frames(frame_id,topic,payload,store_time_utc) VALUES(?,?,?,?)').run(frame.frame_id, topic, JSON.stringify(frame), now);
      this.pruneRows(now);
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw new FrameStorageError('Protocol frame storage failed', { cause: e }); }
  }
  private pruneRows(now: number) {
    const cutoff = now - this.limits.maxAgeDays * 86400000;
    // Retention applies to published and pending frames alike; pending loss is explicit.
    const where = 'store_time_utc < ? OR seq IN (SELECT seq FROM frames ORDER BY seq DESC LIMIT -1 OFFSET ?)';
    const pending = Number(this.db.prepare(`SELECT count(*) n FROM frames WHERE (${where}) AND published=0`).get(cutoff, this.limits.maxRows)!.n);
    const removed = Number(this.db.prepare(`DELETE FROM frames WHERE ${where}`).run(cutoff, this.limits.maxRows).changes);
    this.db.prepare("UPDATE counters SET value=value+? WHERE name='dropped_pending'").run(pending);
    this.db.prepare("UPDATE counters SET value=value+? WHERE name='pruned'").run(removed);
    return removed;
  }
  prune(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const n = this.pruneRows(now); this.db.exec('COMMIT'); return n; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  next() { return this.db.prepare('SELECT frame_id,topic,payload FROM frames WHERE published=0 ORDER BY seq LIMIT 1').get() as { frame_id: string; topic: string; payload: string } | undefined; }
  ack(id: string) { this.db.prepare('UPDATE frames SET published=1 WHERE frame_id=?').run(id); }
  stats() {
    const row = this.db.prepare('SELECT count(*) archived,coalesce(sum(published=0),0) pending FROM frames').get()!;
    return { archived: Number(row.archived), pending: Number(row.pending), dropped_pending: Number(this.db.prepare("SELECT value FROM counters WHERE name='dropped_pending'").get()!.value) };
  }
  async flush(publish: (topic: string, payload: string, retain: boolean) => Promise<void>, limit = 25) {
    for (let i = 0; i < limit; i++) {
      const row = this.next(); if (!row) return;
      await publish(row.topic, row.payload, false); this.ack(row.frame_id);
    }
  }
  close() { this.db.close(); }
}
