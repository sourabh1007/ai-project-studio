import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.js';

export interface DatabaseOptions {
  databasePath: string;
}

/** Opens (or creates) the SQLite database and ensures the schema exists. */
export function createDatabase(options: DatabaseOptions): DatabaseSync {
  const db = new DatabaseSync(options.databasePath);
  db.exec('PRAGMA foreign_keys = ON;');
  applySchema(db);
  return db;
}
