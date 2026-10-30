const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test(
  'development DB persists analysis results, failures and cancellation with owner isolation',
  {
    skip: process.env.RUN_DB_TESTS !== '1',
  },
  async () => {
    require('dotenv').config({ quiet: true });
    const { PrismaClient } = require('@prisma/client');
    const { GatewayTimeoutException } = require('@nestjs/common');
    const {
      RepositoryAnalysisRepository,
    } = require('../dist/analysis/repository-analysis.repository');
    const { RepositoryAnalysisService } = require('../dist/analysis/repository-analysis.service');
    const { encrypt } = require('../dist/auth/github-security');
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    const db = new PrismaClient();
    const marker = `analysis-db-test-${randomUUID()}`;
    const rollback = new Error('Roll back isolated analysis fixtures.');
    let completed = false;
    const snapshot = {
      repository: {
        id: '123',
        fullName: 'fixture/project',
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/fixture/project',
        isPrivate: true,
        commitSha: 'a'.repeat(40),
      },
      files: [
        {
          path: 'src/main.ts',
          content: 'SOURCE_BODY_NOT_PERSISTED',
          bytes: 25,
          truncated: false,
          lineCount: 1,
        },
      ],
      totalFiles: 3,
      skippedFiles: 2,
      treeTruncated: false,
      warnings: ['Partial source coverage.'],
    };
    const analysis = {
      model: 'fixture-model',
      summary: '저장 및 재조회 검증',
      recommendations: [
        {
          id: 'task-1',
          title: '오류 처리 개선',
          priority: 'high',
          rationale: '예외 경계가 필요합니다.',
          implementationSteps: ['오류 경계를 추가합니다.'],
          acceptanceCriteria: ['실패 응답을 검증합니다.'],
          evidence: [
            {
              path: 'src/main.ts',
              startLine: 1,
              endLine: 1,
              excerpt: 'redacted source excerpt',
              url: `https://github.com/fixture/project/blob/${'a'.repeat(40)}/src/main.ts#L1-L1`,
            },
          ],
        },
      ],
    };
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
            const repository = new RepositoryAnalysisRepository(tx);
            const auth = {
              session: async (token) => ({
                userId: token === 'owner' ? owner.id : other.id,
                githubTokenEncrypted: encrypt('fixture-github-token'),
              }),
            };
            const source = {
              snapshot: async (token) => {
                assert.equal(token, 'fixture-github-token');
                return snapshot;
              },
            };
            const model = {
              configuration: () => ({ model: 'fixture-model' }),
              analyze: async () => analysis,
            };
            const service = new RepositoryAnalysisService(auth, source, model, repository);
            const result = await service.analyze('owner', '123', '다음 개발 작업');
            const stored = await tx.repositoryAnalysis.findUniqueOrThrow({
              where: { id: result.analysisId },
            });
            assert.equal(stored.status, 'succeeded');
            assert.equal(stored.userId, owner.id);
            assert.equal(stored.goal, '다음 개발 작업');
            assert.equal(stored.commitSha, snapshot.repository.commitSha);
            assert.equal(stored.completedAt.toISOString(), result.generatedAt);
            assert.deepEqual(stored.result, result);
            assert.deepEqual(stored.context, result.context);
            assert.ok(!JSON.stringify(stored).includes('SOURCE_BODY_NOT_PERSISTED'));
            assert.ok(!JSON.stringify(stored).includes('fixture-github-token'));
            assert.deepEqual((await service.get('owner', result.analysisId)).result, result);
            await assert.rejects(
              service.get('other', result.analysisId),
              (e) => e.getStatus() === 404
            );
            assert.equal((await service.list('other', 1)).items.length, 0);
            const history = await service.list('owner', 1, '123');
            assert.equal(history.items.length, 1);
            assert.equal(history.items[0].id, result.analysisId);
            assert.equal(history.items[0].result, undefined);
            assert.equal(history.items[0].userId, undefined);
            assert.equal((await service.list('owner', 1, '456')).items.length, 0);
            assert.equal((await service.list('owner', 2)).items.length, 0);

            const failing = new RepositoryAnalysisService(
              auth,
              source,
              {
                ...model,
                analyze: async () => {
                  throw new GatewayTimeoutException('private provider details');
                },
              },
              repository
            );
            await assert.rejects(
              failing.analyze('owner', '123', 'failure'),
              (e) => e.getStatus() === 504
            );
            const failed = await tx.repositoryAnalysis.findFirstOrThrow({
              where: { userId: owner.id, goal: 'failure' },
            });
            assert.equal(failed.status, 'failed');
            assert.equal(failed.errorCode, 'HTTP_504');
            assert.equal(failed.result, null);
            assert.ok(failed.completedAt instanceof Date);
            assert.ok(!JSON.stringify(failed).includes('private provider details'));

            const cancellation = new AbortController();
            const cancelled = new RepositoryAnalysisService(
              auth,
              source,
              {
                ...model,
                analyze: async () => {
                  cancellation.abort();
                  return analysis;
                },
              },
              repository
            );
            await assert.rejects(
              cancelled.analyze('owner', '123', 'cancellation', cancellation.signal),
              (e) => e.getStatus() === 504
            );
            const interrupted = await tx.repositoryAnalysis.findFirstOrThrow({
              where: { userId: owner.id, goal: 'cancellation' },
            });
            assert.equal(interrupted.status, 'cancelled');
            assert.equal(interrupted.errorCode, 'CANCELLED');
            assert.equal(interrupted.result, null);
            const untouched = await repository.find(other.id, result.analysisId);
            assert.equal(untouched, null);
            await assert.rejects(
              repository.succeed(result.analysisId, other.id, result),
              (e) => e.getStatus() === 409
            );
            assert.equal((await repository.find(owner.id, result.analysisId)).status, 'succeeded');
            await tx.autopilotUser.delete({ where: { id: owner.id } });
            assert.equal(await tx.repositoryAnalysis.count({ where: { userId: owner.id } }), 0);
            completed = true;
            throw rollback;
          },
          { timeout: 20000 }
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
