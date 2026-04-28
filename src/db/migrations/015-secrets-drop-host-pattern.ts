/**
 * Drop the vestigial `host_pattern` column from `secrets`. It was added when
 * the schema mirrored an external gateway's row shape and was meant to gate
 * which outbound requests a credential could attach to. Paraclaw injects
 * secrets as env vars at container spawn time — there's no proxy in the
 * request path to enforce the glob against — so the column was never read.
 * Lying schemas mislead future readers; pull it.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'secrets-drop-host-pattern',
  up(db: Database) {
    db.exec(`ALTER TABLE secrets DROP COLUMN host_pattern;`);
  },
};
