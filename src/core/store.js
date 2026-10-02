import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

export function openStore(filename = process.env.DB_PATH || '.data/app.sqlite') {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode:0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, unique_key TEXT UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, record_id TEXT NOT NULL, action TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, provider_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);`);
  const decode = row => row ? { ...row, data: JSON.parse(row.data) } : null;
  const records = (kind) => db.prepare('SELECT * FROM records WHERE kind=? ORDER BY created_at DESC').all(kind).map(decode);
  const get = id => decode(db.prepare('SELECT * FROM records WHERE id=?').get(id));
  const find = key => decode(db.prepare('SELECT * FROM records WHERE unique_key=?').get(key));
  const insert = (kind, data, status = 'received', key = null) => {
    const id = randomUUID();
    db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').run(id, kind, data.email || '', status, JSON.stringify(data), key, Date.now());
    return get(id);
  };
  const update = (id, status, data) => {
    const row = get(id);
    if (!row) throw new Error('Record not found.');
    db.prepare('UPDATE records SET status=?, data=? WHERE id=?').run(status, JSON.stringify(data || row.data), id);
    return get(id);
  };
  const atomic = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const hash = raw => createHash('sha256').update(raw).digest('hex');
  const token = (recordId, action, seconds = 86400) => {
    const raw = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO tokens VALUES (?,?,?,?,NULL)').run(hash(raw), recordId, action, Date.now() + seconds * 1000);
    return raw;
  };
  const inspectToken = (raw, now = Date.now()) => {
    if (typeof raw !== 'string' || raw.length > 100) return null;
    const found = db.prepare('SELECT * FROM tokens WHERE hash=? AND consumed_at IS NULL AND expires_at>?').get(hash(raw), now);
    return found ? { ...found, record: get(found.record_id) } : null;
  };
  const consume = raw => db.prepare('UPDATE tokens SET consumed_at=? WHERE hash=? AND consumed_at IS NULL').run(Date.now(), hash(raw));
  const queue = (key, payload) => db.prepare("INSERT OR IGNORE INTO outbox(id,dedupe_key,payload,created_at) VALUES (?,?,?,?)").run(randomUUID(), key, JSON.stringify(payload), Date.now());
  return { db, records, get, find, insert, update, atomic, token, inspectToken, consume, queue,
    removeTokens: id => db.prepare('DELETE FROM tokens WHERE record_id=?').run(id),
    close: () => db.close() };
}
