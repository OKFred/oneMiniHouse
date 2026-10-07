import { DatabaseSync } from 'node:sqlite';

export interface Pending { seq: number; id: string; topic: string; payload: string; captured_ms: number }
export interface Latest { device: string; id: string; topic: string; payload: string }
export class Outbox {
  private db: DatabaseSync;
  private limits: { maxRows: number; maxAgeDays: number };
  constructor(path: string, limits: { maxRows: number; maxAgeDays: number }) {
    this.limits = limits;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, topic TEXT NOT NULL, payload TEXT NOT NULL, captured_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS latest (device TEXT PRIMARY KEY, id TEXT NOT NULL, topic TEXT NOT NULL, payload TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO counters VALUES ('dropped', 0);`);
  }
  save(row: Omit<Pending, 'seq'>, device: string, stateTopic: string, statePayload = row.payload) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO outbox(id,topic,payload,captured_ms) VALUES(?,?,?,?)').run(row.id, row.topic, row.payload, row.captured_ms);
      this.state(device, row.id, stateTopic, statePayload);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  state(device: string, id: string, topic: string, payload: string) {
    this.db.prepare('INSERT INTO latest VALUES(?,?,?,?,1) ON CONFLICT(device) DO UPDATE SET id=excluded.id,topic=excluded.topic,payload=excluded.payload,dirty=1').run(device,id,topic,payload);
  }
  prune(now = Date.now()): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const expired = Number(this.db.prepare('DELETE FROM outbox WHERE captured_ms < ?').run(now - this.limits.maxAgeDays * 86400000).changes);
      const overflow = Number(this.db.prepare('DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox ORDER BY seq DESC LIMIT -1 OFFSET ?)').run(this.limits.maxRows).changes);
      const dropped = expired + overflow;
      this.db.prepare("UPDATE counters SET value=value+? WHERE key='dropped'").run(dropped);
      this.db.exec('COMMIT');
      return dropped;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  first(): Pending | undefined { return this.db.prepare('SELECT * FROM outbox ORDER BY seq LIMIT 1').get() as Pending | undefined; }
  ack(id: string) { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  dirty(): Latest[] { return this.db.prepare('SELECT device,id,topic,payload FROM latest WHERE dirty=1 ORDER BY device').all() as unknown as Latest[]; }
  ackState(device: string, id: string) { this.db.prepare('UPDATE latest SET dirty=0 WHERE device=? AND id=?').run(device,id); }
  replayStates() { this.db.exec('UPDATE latest SET dirty=1'); }
  stats() {
    return { queued: Number(this.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n), dropped: Number(this.db.prepare("SELECT value FROM counters WHERE key='dropped'").get()!.value) };
  }
  close() { this.db.close(); }
}

// A failed / missing PUBACK leaves the same ID durable. Retained state is sourced
// only from latest, never from historical outbox records.
export async function flush(outbox: Outbox, publish: (topic: string, payload: string, retain: boolean) => Promise<void>, limit = 25) {
  for (let i = 0; i < limit; i++) {
    const row = outbox.first();
    if (!row) break;
    await publish(row.topic, row.payload, false);
    outbox.ack(row.id);
  }
  for (const state of outbox.dirty()) {
    await publish(state.topic, state.payload, true);
    outbox.ackState(state.device, state.id);
  }
}
