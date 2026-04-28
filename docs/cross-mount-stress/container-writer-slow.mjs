// Slowed container writer — duration-bounded loop for true cross-mount overlap.
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
const start = Date.now();
const deadline = start + durationSec * 1000;
let written = 0,
  errors = 0,
  i = 0;

while (Date.now() < deadline) {
  i++;
  try {
    stmt.run(writerId, i);
    written++;
  } catch (e) {
    errors++;
    if (errors < 10) console.error(`${writerId} write err #${i}: ${e.message}`);
  }
  await sleep(5 + Math.random() * 10);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`[${writerId}] wrote ${written} in ${elapsed}s, ${errors} errors`);
console.log(`[${writerId}] integrity:`, JSON.stringify(db.prepare('PRAGMA integrity_check').get()));
console.log(`[${writerId}] counts:`, db.prepare('SELECT writer, COUNT(*) n FROM messages GROUP BY writer').all());
db.close();
