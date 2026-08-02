import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { applySchema, DATABASE_GROUPS } from './schema.js';

export interface DatabaseOptions {
  databasePath: string;
}

/**
 * Attaches each non-primary database group. High-volume data is kept in sibling
 * files next to the primary database so no single file grows unbounded. When the
 * primary database is in-memory (tests) each group is attached as its own
 * in-memory database instead.
 */
function attachGroups(db: DatabaseSync, databasePath: string): void {
  const inMemory = databasePath === ':memory:';
  const directory = inMemory ? null : dirname(databasePath);
  for (const group of DATABASE_GROUPS) {
    if (group.schema === 'main' || group.file === null) {
      continue;
    }
    const target =
      directory === null ? ':memory:' : join(directory, group.file);
    db.prepare(`ATTACH DATABASE ? AS ${group.schema}`).run(target);
  }
}

/** Opens (or creates) the SQLite database and ensures the schema exists. */
export function createDatabase(options: DatabaseOptions): DatabaseSync {
  const db = new DatabaseSync(options.databasePath);
  db.exec('PRAGMA foreign_keys = ON;');
  attachGroups(db, options.databasePath);
  applySchema(db);
  return db;
}
