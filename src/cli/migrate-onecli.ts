#!/usr/bin/env bun
/**
 * One-shot migration: copy credentials out of an OneCLI export into
 * paraclaw's local secret store.
 *
 * Usage:
 *   onecli secrets list --json > /tmp/onecli-secrets.json   # via the operator's shell
 *   bun src/cli/migrate-onecli.ts /tmp/onecli-secrets.json
 *
 * The OneCLI SDK at 0.3.1 doesn't expose a secrets-list API, so this CLI
 * works off whatever JSON the OneCLI binary itself emits — that keeps the
 * dependency boundary clean and avoids re-implementing the gateway's auth
 * dance here. Each row is encrypted with paraclaw's master key
 * (`~/.parachute/claw/master.key`, generated on first call) and inserted
 * into the central DB. Re-running the same migration is safe: putSecret
 * is upsert-by (name, agent_group_id).
 *
 * Schema accepted (mirrors `onecli secrets list --json`):
 *   [
 *     { "name": "SLACK_BOT_TOKEN", "value": "xoxb-…", "kind": "channel-token",
 *       "agent_group_id": null, "host_pattern": "*.slack.com" }
 *   ]
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { initDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { type SecretKind, putSecret } from '../secrets/index.js';

interface ImportRow {
  name?: string;
  value?: string;
  kind?: string;
  agent_group_id?: string | null;
  host_pattern?: string | null;
}

const ALLOWED_KINDS: SecretKind[] = ['channel-token', 'api-key', 'generic'];

function exitWith(code: number, msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    exitWith(
      1,
      [
        'usage: bun src/cli/migrate-onecli.ts <export.json>',
        '',
        'First export from OneCLI:',
        '  onecli secrets list --json > /tmp/onecli-secrets.json',
        '',
        'Then point this CLI at the file. Master key will be created at',
        '~/.parachute/claw/master.key on first run.',
      ].join('\n'),
    );
  }

  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) exitWith(1, `file not found: ${abs}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    exitWith(1, `invalid JSON in ${abs}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) exitWith(1, `${abs} must contain a JSON array of secrets`);

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  let imported = 0;
  let skipped = 0;
  for (const raw of parsed as ImportRow[]) {
    const name = (raw.name ?? '').trim();
    const value = raw.value;
    if (!name || typeof value !== 'string') {
      // Redact the value field before logging — the migration input file
      // contains plaintext secrets and we don't want them surfacing in shell
      // captures or terminal scrollback. Name is also redacted because some
      // operators key secrets by an identifier the value would expose
      // (e.g. `MY_TOKEN_xoxb-…`).
      skipped++;
      const safe = { ...raw, name: name || '[unnamed]', value: '[REDACTED]' };
      process.stderr.write(`skipped: missing name or value (${JSON.stringify(safe).slice(0, 120)})\n`);
      continue;
    }
    let kind: SecretKind = 'generic';
    if (raw.kind && ALLOWED_KINDS.includes(raw.kind as SecretKind)) kind = raw.kind as SecretKind;
    putSecret(name, value, {
      kind,
      agent_group_id: raw.agent_group_id ?? null,
      host_pattern: raw.host_pattern ?? null,
    });
    process.stdout.write(`imported: ${name} (${kind})\n`);
    imported++;
  }
  process.stdout.write(`\nDone. Imported ${imported}, skipped ${skipped}.\n`);
}

main();
