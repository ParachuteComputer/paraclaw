// Host writer with retry-on-busy/IO-error — the production-shaped variant.
// Used to measure the steady-state retry rate when both sides contend on a
// single bind-mounted SQLite file under VirtioFS.
import Database from 'better-sqlite3';
import { setTimeout as sleep } from 'node:timers/promises';

const dbPath = process.argv[2] || '/tmp/paraclaw-xmount-test/session.db';
const writerId = process.argv[3] || 'host';
const durationSec = Number(process.argv[4] || '15');

const db = new Database(dbPath);
db.pragma('journal_mode = DELETE');
db.pragma('busy_timeout = 5000');
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  writer TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);`);

const stmt = db.prepare('INSERT INTO messages (writer, seq) VALUES (?, ?)');

async function writeWithRetry(seq, maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      stmt.run(writerId, seq);
      return { ok: true, attempts: attempt };
    } catch (e) {
      if (attempt === maxAttempts) return { ok: false, attempts: attempt, err: e.message };
      await sleep(20 + Math.random() * 80);
    }
  }
}

const start = Date.now();
const deadline = start + durationSec * 1000;
let written = 0,
  perm = 0,
  retries = 0,
  i = 0;

while (Date.now() < deadline) {
  i++;
  const r = await writeWithRetry(i);
  if (r.ok) {
    written++;
    if (r.attempts > 1) retries += r.attempts - 1;
  } else perm++;
  await sleep(5 + Math.random() * 10);
}

console.log(`[${writerId}] ${written} ok, ${perm} perm-fail, ${retries} retries`);
console.log(`[${writerId}] integrity:`, JSON.stringify(db.prepare('PRAGMA integrity_check').get()));
console.log(`[${writerId}] counts:`, db.prepare('SELECT writer, COUNT(*) n FROM messages GROUP BY writer').all());
db.close();
