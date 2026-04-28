// Slowed host writer — loops on a duration deadline so it overlaps with the
// container writer. ~100 writes/sec, 5–15ms between writes.
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
const start = Date.now();
const deadline = start + durationSec * 1000;
let written = 0;
let errors = 0;
let i = 0;

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
