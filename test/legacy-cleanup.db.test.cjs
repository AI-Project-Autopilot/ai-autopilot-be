/* eslint-disable @typescript-eslint/no-require-imports -- Tests load CommonJS dependencies. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const migrationsPath = join(__dirname, '../prisma/migrations');
const cleanupMigration = '20261113000000_remove_legacy_tables';
const activeTables = [
  'AutopilotOAuthState',
  'AutopilotSession',
  'AutopilotUser',
  'RepositoryAnalysis',
  '_prisma_migrations',
];
const legacyTables = [
  'Comments',
  'Invitations',
  'Project_members',
  'Projects',
  'Subtasks',
  'Tags',
  'Task_files',
  'Task_tags',
  'Tasks',
  'Tokens',
  'Users',
];

function statements(name) {
  // These checked-in migrations contain plain DDL, without procedural blocks.
  // The surrounding test transaction replaces each file's BEGIN/COMMIT.
  return readFileSync(join(migrationsPath, name, 'migration.sql'), 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement && !/^(BEGIN|COMMIT)$/i.test(statement));
}

async function applyMigration(tx, name) {
  for (const statement of statements(name)) await tx.$executeRawUnsafe(statement);
}

async function tableNames(tx, schema) {
  const rows = await tx.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name).sort();
}

async function activeData(tx) {
  const result = {};
  for (const table of activeTables) {
    result[table] = await tx.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t`);
  }
  return result;
}

async function withIsolatedSchema(run) {
  require('dotenv').config({ quiet: true });
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  const schema = `legacy_cleanup_test_${randomUUID().replaceAll('-', '')}`;
  const rollback = new Error('Roll back the entire isolated migration test.');
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", pg_catalog`);
          for (const name of readdirSync(migrationsPath).sort()) {
            if (/^\d/.test(name) && name < cleanupMigration) await applyMigration(tx, name);
          }
          await tx.$executeRaw`
            INSERT INTO "AutopilotUser" (id, "githubId", login, "avatarUrl", "updatedAt")
            VALUES ('fixture-owner', 'fixture-github-id', 'fixture-login', '', CURRENT_TIMESTAMP)
          `;
          await tx.$executeRaw`
            INSERT INTO "AutopilotSession" ("tokenHash", "userId", "githubTokenEncrypted", "expiresAt")
            VALUES ('fixture-token-hash', 'fixture-owner', 'fixture-ciphertext', '2099-01-01')
          `;
          await tx.$executeRaw`
            INSERT INTO "AutopilotOAuthState" ("stateHash", "browserHash", "verifierEncrypted", "expiresAt")
            VALUES ('fixture-state', 'fixture-browser', 'fixture-verifier', '2099-01-01')
          `;
          const result = {
            analysisId: 'fixture-analysis',
            language: 'en',
            summary: 'Keep this saved analysis.',
            recommendations: [{ id: 'task-1', title: 'Keep this recommendation.' }],
          };
          await tx.$executeRaw`
            INSERT INTO "RepositoryAnalysis"
              (id, "userId", "repositoryId", goal, status, model, result, context, "updatedAt")
            VALUES ('fixture-analysis', 'fixture-owner', '123', 'Keep this goal.', 'succeeded',
              'fixture-model', ${JSON.stringify(result)}::jsonb, '{"totalFiles":1}'::jsonb, CURRENT_TIMESTAMP)
          `;
          await tx.$executeRaw`INSERT INTO "Tags" (tag) VALUES ('retired-fixture-tag')`;
          // Prisma manages this table separately from model migrations.
          await tx.$executeRaw`CREATE TABLE "_prisma_migrations" (id TEXT PRIMARY KEY, migration_name TEXT NOT NULL)`;
          await tx.$executeRaw`INSERT INTO "_prisma_migrations" VALUES ('fixture-history', 'keep-applied-history')`;
          await run(tx, schema);
          throw rollback;
        },
        { timeout: 30000 }
      ),
      (error) => error === rollback
    );
    const leftover = await db.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`;
    assert.deepEqual(leftover, [], 'Rolling back must remove the test schema and all fixtures');
  } finally {
    await db.$disconnect();
  }
}

test(
  'legacy cleanup replays from migration history and preserves all active data, types and relations',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    await withIsolatedSchema(async (tx, schema) => {
      const before = await activeData(tx);
      assert.deepEqual(await tableNames(tx, schema), [...activeTables, ...legacyTables].sort());
      await applyMigration(tx, cleanupMigration);
      assert.deepEqual(await tableNames(tx, schema), activeTables);
      assert.deepEqual(await activeData(tx), before);
      const enums = await tx.$queryRaw`
        SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ${schema} AND t.typtype = 'e' ORDER BY t.typname
      `;
      assert.deepEqual(enums, [{ typname: 'RepositoryAnalysisStatus' }]);
      const foreignKeys = await tx.$queryRaw`
        SELECT source.relname AS "table", target.relname AS "references"
        FROM pg_constraint c
        JOIN pg_class source ON source.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = source.relnamespace
        JOIN pg_class target ON target.oid = c.confrelid
        WHERE n.nspname = ${schema} AND c.contype = 'f' ORDER BY source.relname
      `;
      assert.deepEqual(foreignKeys, [
        { table: 'AutopilotSession', references: 'AutopilotUser' },
        { table: 'RepositoryAnalysis', references: 'AutopilotUser' },
      ]);
    });
  }
);

test(
  'unexpected foreign-key dependencies reject cleanup and allow every earlier drop to roll back',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    await withIsolatedSchema(async (tx, schema) => {
      await tx.$executeRaw`CREATE TABLE "UnexpectedReference" ("tagId" INTEGER REFERENCES "Tags"(id))`;
      const tablesBefore = await tableNames(tx, schema);
      const dataBefore = await activeData(tx);
      await tx.$executeRawUnsafe('SAVEPOINT cleanup_attempt');
      await assert.rejects(
        applyMigration(tx, cleanupMigration),
        (error) => error.code === 'P2010' && error.meta?.code === '2BP01'
      );
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cleanup_attempt');
      assert.deepEqual(await tableNames(tx, schema), tablesBefore);
      assert.deepEqual(await activeData(tx), dataBefore);
      assert.deepEqual(await tx.$queryRaw`SELECT tag FROM "Tags"`, [
        { tag: 'retired-fixture-tag' },
      ]);
    });
  }
);
