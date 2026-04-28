import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration009: Migration = {
  version: 9,
  name: 'drop-pending-credentials',
  up: (db: Database) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_pending_credentials_status;
      DROP TABLE IF EXISTS pending_credentials;
    `);
  },
};
