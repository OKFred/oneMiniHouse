// Read-only catalog verification; before mode also writes reversible COMMENT SQL.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { databaseOptions } from '../src/database.ts';

const mode = process.argv[2];
assert.ok(mode === 'before' || mode === 'after', 'Usage: audit-comments.ts before|after');
const dir = process.env.COMMENT_EVIDENCE_DIR ?? '/app/data/evidence/pg-comments-20260920';
mkdirSync(dir, { recursive: true });
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const literal = (s: string | null) => s === null ? 'NULL' : "'" + s.replaceAll("'", "''") + "'";
const chinese = (s: unknown) => typeof s === 'string' && /[\u4e00-\u9fff]/.test(s);
const reports = [];
for (const target of loadConfig().targets) {
  const client = new pg.Client(databaseOptions(target));
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const schema = (await client.query("SELECT obj_description(oid,'pg_namespace') AS comment FROM pg_namespace WHERE nspname='iot'")).rows[0];
    const relations = (await client.query(`SELECT c.relname,c.relkind,c.relowner::text,c.relacl::text,c.reloptions,c.relrowsecurity,c.relforcerowsecurity,
      CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid,true) END AS definition,obj_description(c.oid,'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='iot' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname`)).rows;
    const columns = (await client.query(`SELECT c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_value,col_description(c.oid,a.attnum) AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='iot' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname,a.attnum`)).rows;
    const policies = (await client.query("SELECT * FROM pg_policies WHERE schemaname='iot' ORDER BY tablename,policyname")).rows;
    const indexes = (await client.query("SELECT * FROM pg_indexes WHERE schemaname='iot' ORDER BY tablename,indexname")).rows;
    await client.query('ROLLBACK');
    const snapshot = { schema, relations, columns, policies, indexes };
    const stem = join(dir, target.id);
    if (mode === 'before') {
      writeFileSync(stem + '-before.json', JSON.stringify(snapshot, null, 2), { flag: 'wx' });
      const rollback = ['BEGIN;', "SET LOCAL lock_timeout='5s';", `COMMENT ON SCHEMA iot IS ${literal(schema.comment)};`,
        ...relations.map(r => `COMMENT ON ${r.relkind === 'v' ? 'VIEW' : 'TABLE'} iot.${quote(r.relname)} IS ${literal(r.comment)};`),
        ...columns.map(c => `COMMENT ON COLUMN iot.${quote(c.relname)}.${quote(c.attname)} IS ${literal(c.comment)};`), 'COMMIT;'];
      writeFileSync(stem + '-rollback.sql', rollback.join('\n')+'\n', { flag: 'wx' });
    } else {
      const before = JSON.parse(readFileSync(stem + '-before.json', 'utf8'));
      const noComments = (rows: Record<string, unknown>[]) => rows.map(({ comment: _comment, ...rest }) => rest);
      assert.deepEqual(noComments(relations), noComments(before.relations), `${target.id}: relation definition or access changed`);
      assert.deepEqual(noComments(columns), noComments(before.columns), `${target.id}: columns changed`);
      assert.deepEqual(policies, before.policies, `${target.id}: policies changed`);
      assert.deepEqual(indexes, before.indexes, `${target.id}: indexes changed`);
      assert.ok(chinese(schema.comment), `${target.id}: schema lacks Chinese comment`);
      for (const r of relations) assert.ok(chinese(r.comment), `${target.id}: missing relation comment: ${r.relname}`);
      for (const c of columns) assert.ok(chinese(c.comment), `${target.id}: missing column comment: ${c.relname}.${c.attname}`);
      writeFileSync(stem + '-after.json', JSON.stringify(snapshot, null, 2));
    }
    reports.push({ target: target.id, relations: relations.length, columns: columns.length,
      chinese_relations: relations.filter(r => chinese(r.comment)).length, chinese_columns: columns.filter(c => chinese(c.comment)).length });
  } finally { await client.end(); }
}
console.log(JSON.stringify({ mode, passed: true, reports, evidence_dir: dir }));
