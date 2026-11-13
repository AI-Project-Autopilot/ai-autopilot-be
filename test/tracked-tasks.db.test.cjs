/* eslint-disable @typescript-eslint/no-require-imports -- Tests load CommonJS build output. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test(
  'tracked tasks persist reviewed drafts, issue state and ownership with real DB constraints',
  { skip: process.env.RUN_DB_TESTS !== '1' },
  async () => {
    require('dotenv').config({ quiet: true });
    const { PrismaClient } = require('@prisma/client');
    const { RepositoryTaskService } = require('../dist/tasks/repository-task.service');
    const { RepositoryTaskRepository } = require('../dist/tasks/repository-task.repository');
    const { encrypt } = require('../dist/auth/github-security');
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    const db = new PrismaClient();
    const marker = `tracked-task-test-${randomUUID()}`;
    const rollback = new Error('Roll back isolated tracked task fixtures.');
    let completed = false;
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            const owner = await tx.autopilotUser.create({
              data: { githubId: `${marker}-owner`, login: marker, avatarUrl: '' },
            });
            const other = await tx.autopilotUser.create({
              data: { githubId: `${marker}-other`, login: marker, avatarUrl: '' },
            });
            const recommendations = ['task-1', 'task-2'].map((id) => ({
              id,
              title: `Stored recommendation ${id}`,
              priority: 'high',
              rationale: 'A source-backed change.',
              implementationSteps: ['Implement the change.'],
              acceptanceCriteria: ['Verify the behavior.'],
              evidence: [
                {
                  path: 'src/main.ts',
                  startLine: 1,
                  endLine: 1,
                  excerpt: 'export const value = 1;',
                  url: `https://github.com/fixture/project/blob/${'a'.repeat(40)}/src/main.ts#L1-L1`,
                },
              ],
            }));
            const analysis = await tx.repositoryAnalysis.create({
              data: {
                userId: owner.id,
                repositoryId: '123',
                goal: 'Improve source behavior.',
                status: 'succeeded',
                fullName: 'fixture/project',
                commitSha: 'a'.repeat(40),
                model: 'fixture-model',
                result: {
                  language: 'en',
                  repository: { id: '123', fullName: 'fixture/project' },
                  recommendations,
                },
              },
            });
            const auth = {
              session: async (token) => ({
                userId: token === 'owner' ? owner.id : other.id,
                githubTokenEncrypted: encrypt('fixture-token'),
              }),
            };
            let posts = 0;
            let currentIssue;
            const github = {
              repository: async (token, id) => {
                assert.equal(token, 'fixture-token');
                assert.equal(id, '123');
                return {
                  id,
                  fullName: 'fixture/project',
                  htmlUrl: 'https://github.com/fixture/project',
                  issuesEnabled: true,
                  archived: false,
                };
              },
              findByMarker: async () => null,
              create: async (_token, _repository, draft) => {
                posts++;
                assert.equal(draft.title, 'Reviewed title');
                assert.match(draft.body, /^Reviewed issue body/);
                currentIssue = {
                  number: 17,
                  url: 'https://github.com/fixture/project/issues/17',
                  state: 'open',
                  stateReason: null,
                  body: draft.body,
                };
                return currentIssue;
              },
              get: async () => currentIssue,
            };
            const repository = new RepositoryTaskRepository(tx);
            const service = new RepositoryTaskService(auth, repository, github);
            const selected = await service.select('owner', analysis.id, 'task-1');
            assert.equal(selected.title, recommendations[0].title);
            assert.equal(selected.status, 'selected');
            assert.equal(selected.userId, undefined);
            await service.update('owner', selected.id, {
              title: 'Reviewed title',
              body: 'Reviewed issue body',
              status: 'in_progress',
            });
            const repeated = await service.select('owner', analysis.id, 'task-1');
            assert.equal(repeated.id, selected.id);
            assert.equal(repeated.title, 'Reviewed title');
            assert.equal(repeated.body, 'Reviewed issue body');
            assert.equal(repeated.status, 'in_progress');
            const stored = await tx.trackedTask.findUniqueOrThrow({ where: { id: selected.id } });
            assert.equal(stored.userId, owner.id);
            assert.deepEqual(stored.source, recommendations[0]);
            await assert.rejects(service.get('other', selected.id), (e) => e.getStatus() === 404);
            await assert.rejects(
              service.select('other', analysis.id, 'task-1'),
              (e) => e.getStatus() === 404
            );
            assert.equal((await service.list('other', 1)).items.length, 0);

            await service.createIssue('owner', selected.id);
            assert.equal(posts, 1);
            assert.match(currentIssue.body, new RegExp(`<!-- autopilot-task:${selected.id} -->`));
            const reloaded = new RepositoryTaskService(
              auth,
              new RepositoryTaskRepository(tx),
              github
            );
            const saved = await reloaded.get('owner', selected.id);
            assert.equal(saved.issueNumber, 17);
            assert.equal(saved.issueCreationState, 'created');
            assert.equal(saved.body, 'Reviewed issue body');
            assert.equal((await reloaded.list('owner', 1, '123', analysis.id)).items.length, 1);
            await reloaded.createIssue('owner', selected.id);
            assert.equal(posts, 1, 'Reconstructed services must not repost a saved issue');
            currentIssue = { ...currentIssue, state: 'closed', stateReason: 'completed' };
            assert.equal((await reloaded.syncIssue('owner', selected.id)).status, 'completed');

            const second = await service.select('owner', analysis.id, 'task-2');
            async function rejectsConstraint(operation, code) {
              await tx.$executeRawUnsafe('SAVEPOINT expected_constraint');
              await assert.rejects(operation, (error) => error.code === code);
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT expected_constraint');
            }
            const duplicate = {
              userId: owner.id,
              analysisId: analysis.id,
              recommendationId: 'task-1',
              repositoryId: '123',
              fullName: 'fixture/project',
              language: 'en',
              title: 'Duplicate selection',
              body: 'Draft',
              priority: 'high',
              source: recommendations[0],
            };
            await rejectsConstraint(() => tx.trackedTask.create({ data: duplicate }), 'P2002');
            await rejectsConstraint(
              () => tx.trackedTask.update({ where: { id: second.id }, data: { issueNumber: 17 } }),
              'P2002'
            );
            await rejectsConstraint(
              () =>
                tx.trackedTask.create({
                  data: { ...duplicate, userId: 'missing-owner', recommendationId: 'task-missing' },
                }),
              'P2003'
            );
            await tx.repositoryAnalysis.delete({ where: { id: analysis.id } });
            assert.equal(await tx.trackedTask.count({ where: { userId: owner.id } }), 0);
            assert.ok(await tx.autopilotUser.findUnique({ where: { id: owner.id } }));
            completed = true;
            throw rollback;
          },
          { timeout: 30000 }
        ),
        (error) => error === rollback
      );
      assert.equal(completed, true);
      assert.equal(await db.autopilotUser.count({ where: { login: marker } }), 0);
    } finally {
      await db.$disconnect();
    }
  }
);
