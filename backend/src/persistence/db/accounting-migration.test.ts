import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from './connection.js';
import { applySchema, DATABASE_GROUPS } from './schema.js';

function legacy() {
  const db = createDatabase({ databasePath: ':memory:' });
  const tables = DATABASE_GROUPS.find((group) => group.schema === 'usage')!.tables;
  for (const name of ['usage_events', 'retained_usage']) {
    db.exec(`DROP TABLE usage.${name}`);
    let ddl = tables.find((table) => table.name === name)!.ddl;
    if (name === 'usage_events') {
      ddl = ddl.replace(/    (charge_provenance TEXT|charge_unit TEXT|usd_estimate REAL|native_session_id TEXT|native_message_id TEXT),\r?\n/g, '');
    }
    ddl = ddl.replace('cost REAL,', 'cost REAL NOT NULL,').replace('credits REAL,', 'credits REAL NOT NULL,')
      .replace('nano_aiu INTEGER,', 'nano_aiu INTEGER NOT NULL,');
    db.exec(ddl.replace(`EXISTS ${name}`, `EXISTS usage.${name}`));
  }
  db.exec(`INSERT INTO usage_events(session_id,feature_id,turn_index,kind,provider,requested_model,resolved_model,
    operation,input_tokens,output_tokens,reasoning_output_tokens,cost,credits,nano_aiu,started_at,ended_at)
    VALUES('historical','f',0,'dev','agency','auto','model','chat',10,2,0,0,0,0,'2026-01-01','2026-01-01')`);
  db.exec(`INSERT INTO retained_usage(id,session_kind,scope,source,reason,provider,resolved_model,day,sessions,
    input_tokens,output_tokens,reasoning_output_tokens,cost,credits,nano_aiu,retained_at)
    VALUES('retained','dev','feature','cli','deleted','copilot','model','2026-01-01',1,10,2,0,2,2,100,'2026-01-01')`);
  return db;
}

describe('native accounting schema migration', () => {
  it('preserves historical provider, reported zero, retained amounts and supports nullable future records idempotently', () => {
    const db = legacy();
    applySchema(db);
    applySchema(db);
    expect(db.prepare('SELECT provider,cost,credits,nano_aiu,charge_provenance,charge_unit FROM usage_events').get()).toMatchObject({
      provider: 'agency', cost: 0, credits: 0, nano_aiu: 0, charge_provenance: 'reported', charge_unit: 'aic',
    });
    expect(db.prepare('SELECT provider,credits,nano_aiu FROM retained_usage').get()).toMatchObject({ provider: 'copilot', credits: 2, nano_aiu: 100 });
    db.exec('UPDATE usage_events SET cost=NULL,credits=NULL,nano_aiu=NULL');
    db.exec('UPDATE retained_usage SET cost=NULL,credits=NULL,nano_aiu=NULL');
    db.close();
  });

  it.each(['usage_events', 'retained_usage'])('rolls back %s rebuild on failure and retries without lost history', (table) => {
    const db = legacy();
    const exec = db.exec.bind(db);
    let fail = true;
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (fail && sql.includes(`INSERT INTO usage.${table} (`)) {
        fail = false;
        throw new Error('interrupted-copy');
      }
      return exec(sql);
    });
    expect(() => applySchema(db)).toThrow('interrupted-copy');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 1 });
    spy.mockRestore();
    applySchema(db);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 1 });
    db.close();
  });
});
