import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sql } from 'postgres';
import { createSql } from './postgres';
import { loadMigrationConfig } from '../config';

const schemaName = 'inception-1-test';
const quotedSchema = '"inception-1-test"';
const migrationDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertSafeMigrationSql(fileName: string, sqlText: string): void {
  const lowered = sqlText.toLowerCase();
  if (lowered.includes('public.')) {
    throw new Error(`${fileName} references public schema; migrations must target ${quotedSchema} only`);
  }
  if (/\bset\s+search_path\b/i.test(sqlText)) {
    throw new Error(`${fileName} sets search_path; all objects must be schema-qualified instead`);
  }

  const objectCreation = /\bcreate\s+(?:or\s+replace\s+)?(?:table|type|function|view|materialized\s+view)\s+(?:(?:if\s+not\s+exists)\s+)?(?<target>[^\s(]+)/gi;
  for (const match of sqlText.matchAll(objectCreation)) {
    const target = match.groups?.target ?? '';
    if (!target.startsWith(`${quotedSchema}.`)) {
      throw new Error(`${fileName} contains unqualified object creation: ${match[0]}`);
    }
  }
}

async function ensureMigrationLedger(sql: Sql): Promise<void> {
  await sql.unsafe(`create schema if not exists ${quotedSchema}`).simple();
  await sql.unsafe(`
    create table if not exists ${quotedSchema}.schema_migrations (
      name text primary key,
      content_hash text not null,
      applied_at timestamptz not null default now()
    )
  `).simple();
}

async function loadMigrationFiles(): Promise<Array<{ name: string; sql: string; hash: string }>> {
  const files = (await fs.readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  const migrations = [];
  for (const name of files) {
    const sqlText = await fs.readFile(path.join(migrationDir, name), 'utf8');
    assertSafeMigrationSql(name, sqlText);
    migrations.push({ name, sql: sqlText, hash: hashContent(sqlText) });
  }
  return migrations;
}

export async function runMigrations(): Promise<void> {
  const config = loadMigrationConfig();
  if (config.supabaseSchema !== schemaName) {
    throw new Error(`Refusing to migrate schema ${config.supabaseSchema}`);
  }

  const sql = createSql(config.databaseUrl);
  try {
    await ensureMigrationLedger(sql);
    const migrations = await loadMigrationFiles();

    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('personapulse:inception-1-test:migrations'))`;

      for (const migration of migrations) {
        const rows = await tx<{ content_hash: string }[]>`
          select content_hash
          from "inception-1-test".schema_migrations
          where name = ${migration.name}
        `;
        const existing = rows[0];

        if (existing?.content_hash === migration.hash) {
          continue;
        }
        if (existing && existing.content_hash !== migration.hash) {
          throw new Error(`Applied migration ${migration.name} has a different hash`);
        }

        await tx.unsafe(migration.sql).simple();
        await tx`
          insert into "inception-1-test".schema_migrations (name, content_hash)
          values (${migration.name}, ${migration.hash})
        `;
        console.log(`Applied migration ${migration.name}`);
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
