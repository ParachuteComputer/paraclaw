/**
 * Denormalize `provider` onto `app_connections` for query speed and to
 * avoid a join+lookup for every list-connection / single-get call. The
 * source of truth stays `app_configs.provider`; this column is filled
 * at upsert time from the parent config.
 *
 * On apply: backfill any existing rows by joining to app_configs. New
 * rows from this point set it directly.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration022: Migration = {
  version: 22,
  name: 'app-connections-provider',
  up(db: Database) {
    db.exec(`
      ALTER TABLE app_connections ADD COLUMN provider TEXT NOT NULL DEFAULT '';
      UPDATE app_connections
         SET provider = (SELECT provider FROM app_configs WHERE app_configs.id = app_connections.app_config_id)
       WHERE provider = '';
      CREATE INDEX IF NOT EXISTS idx_app_connections_provider ON app_connections(provider);
    `);
  },
};
