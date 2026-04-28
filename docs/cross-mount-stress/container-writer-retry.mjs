// Container writer with retry-on-error — production-shaped. Used to measure
// the steady-state retry rate when both sides contend on a single SQLite file
// across the bind mount.
import { Database } from 'bun:sqlite';

const dbPath = process.argv[2] || '/workspace/session.db';
const writerId = process.argv[3] || 'container';
const durationSec = Number(process.argv[4] || '15');

const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  writer TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);`);

const stmt = db.prepare('INSERT INTO messages (writer, seq) VALUES (?, ?)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
