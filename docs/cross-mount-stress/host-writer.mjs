// Host-side stress writer — uses better-sqlite3 (Node) like the paraclaw host.
// Inserts N rows into session.db with random sleeps. Pair with container-writer.mjs
// running inside a container that bind-mounts the same file to demonstrate
// cross-mount lock contention.
import Database from 'better-sqlite3';
import { setTimeout as sleep } from 'node:timers/promises';

const dbPath = process.argv[2] || '/tmp/paraclaw-xmount-test/session.db';
const writerId = process.argv[3] || 'host';
const count = Number(process.argv[4] || '500');

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
let written = 0;
let errors = 0;

for (let i = 1; i <= count; i++) {
  try {
    stmt.run(writerId, i);
    written++;
  } catch (e) {
    errors++;
    if (errors < 5) console.error(`${writerId} write error #${i}: ${e.message}`);
  }
  if (i % 50 === 0) await sleep(2 + Math.random() * 8);
  else if (Math.random() < 0.1) await sleep(Math.random() * 3);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`[${writerId}] wrote ${written}/${count} rows in ${elapsed}s, ${errors} errors`);

const integrity = db.prepare('PRAGMA integrity_check').get();
console.log(`[${writerId}] integrity:`, JSON.stringify(integrity));

const counts = db.prepare('SELECT writer, COUNT(*) AS n FROM messages GROUP BY writer ORDER BY writer').all();
console.log(`[${writerId}] row counts:`, counts);
db.close();
