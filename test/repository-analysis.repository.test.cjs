const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RepositoryAnalysisRepository } = require('../dist/analysis/repository-analysis.repository');

const analysisId = 'c' + 'a'.repeat(24);
const repository = {
  id: '123',
  fullName: 'octo/private-project',
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/octo/private-project',
  isPrivate: true,
  commitSha: 'b'.repeat(40),
};
const snapshot = {
  repository,
  files: [
    {
      path: 'src/main.ts',
      content: 'PRIVATE_FULL_SOURCE_MARKER\nconst value = 1;',
      bytes: 45,
      truncated: true,
      lineCount: 2,
    },
  ],
  totalFiles: 30,
  skippedFiles: 29,
  treeTruncated: true,
  warnings: ['Selected source files only.'],
};
const result = {
  analysisId,
  repository,
  generatedAt: '2026-10-30T06:00:00.000Z',
  model: 'muse-spark-1.3',
  summary: '실행 경계의 검증을 개선합니다.',
  recommendations: [
    {
      id: 'task-1',
      title: '실행 검증',
      priority: 'medium',
      rationale: '검증 경계가 필요합니다.',
      implementationSteps: ['검증 경계를 구현합니다.'],
      acceptanceCriteria: ['잘못된 입력을 거부합니다.'],
      evidence: [
        {
          path: 'src/main.ts',
          startLine: 2,
          endLine: 2,
          excerpt: 'const value = 1;',
          url: `https://github.com/octo/private-project/blob/${'b'.repeat(40)}/src/main.ts#L2-L2`,
        },
      ],
    },
  ],
  context: {
    filesRead: [{ path: 'src/main.ts', bytes: 45, truncated: true, lineCount: 2 }],
    totalFiles: 30,
    skippedFiles: 29,
    treeTruncated: true,
    warnings: ['Selected source files only.'],
  },
};

test('analysis repository creates an owner-bound running record without storing source input', async () => {
  let input;
  const repo = new RepositoryAnalysisRepository({
    repositoryAnalysis: {
      create: async (value) => {
        input = value;
        return { id: analysisId };
      },
    },
  });
  assert.deepEqual(await repo.start('owner-a', '123', '실행 경계 개선', 'muse-spark-1.3'), {
    id: analysisId,
  });
  assert.deepEqual(input, {
    data: {
      userId: 'owner-a',
      repositoryId: '123',
      goal: '실행 경계 개선',
      model: 'muse-spark-1.3',
      status: 'running',
    },
    select: { id: true },
  });
});

test('analysis snapshot persists commit and coverage metadata while omitting full source contents', async () => {
  let input;
  const repo = new RepositoryAnalysisRepository({
    repositoryAnalysis: {
      updateMany: async (value) => {
        input = value;
        return { count: 1 };
      },
    },
  });
  await repo.setSnapshot(analysisId, 'owner-a', snapshot);
  assert.deepEqual(input.where, { id: analysisId, userId: 'owner-a', status: 'running' });
  assert.equal(input.data.commitSha, repository.commitSha);
  assert.equal(input.data.isPrivate, true);
  assert.deepEqual(input.data.context, result.context);
  const serialized = JSON.stringify(input.data);
  assert.ok(!serialized.includes('PRIVATE_FULL_SOURCE_MARKER'));
  assert.ok(!serialized.includes('"content"'));
  assert.equal(input.data.files, undefined);
});

test('analysis success stores validated result and coverage atomically for the running owner record', async () => {
  let input;
  const repo = new RepositoryAnalysisRepository({
    repositoryAnalysis: {
      updateMany: async (value) => {
        input = value;
        return { count: 1 };
      },
    },
  });
  await repo.succeed(analysisId, 'owner-a', result);
  assert.deepEqual(input.where, { id: analysisId, userId: 'owner-a', status: 'running' });
  assert.equal(input.data.status, 'succeeded');
  assert.equal(input.data.summary, result.summary);
  assert.equal(input.data.errorCode, null);
  assert.deepEqual(input.data.result, result);
  assert.deepEqual(input.data.context, result.context);
  assert.equal(input.data.completedAt.toISOString(), result.generatedAt);
  assert.ok(!JSON.stringify(input.data).includes('PRIVATE_FULL_SOURCE_MARKER'));
});

test('analysis updates reject records not owned by the caller or no longer running', async () => {
  const inputs = [];
  const repo = new RepositoryAnalysisRepository({
    repositoryAnalysis: {
      updateMany: async (input) => {
        inputs.push(input);
        return { count: 0 };
      },
    },
  });
  await assert.rejects(
    repo.setSnapshot(analysisId, 'owner-b', snapshot),
    (error) => error.getStatus() === 409
  );
  await assert.rejects(
    repo.succeed(analysisId, 'owner-b', result),
    (error) => error.getStatus() === 409
  );
  assert.ok(
    inputs.every((input) => input.where.userId === 'owner-b' && input.where.status === 'running')
  );
});

test('analysis failures only terminate the running owner record and save a compact error code', async () => {
  const inputs = [];
  const repo = new RepositoryAnalysisRepository({
    repositoryAnalysis: {
      updateMany: async (input) => {
        inputs.push(input);
        return { count: 1 };
      },
    },
  });
  await repo.fail(analysisId, 'owner-a', 'failed', 'HTTP_502');
  await repo.fail(analysisId, 'owner-a', 'cancelled', 'CANCELLED');
  for (const input of inputs) {
    assert.deepEqual(input.where, { id: analysisId, userId: 'owner-a', status: 'running' });
    assert.deepEqual(Object.keys(input.data).sort(), ['completedAt', 'errorCode', 'status']);
    assert.ok(input.data.completedAt instanceof Date);
  }
  assert.equal(inputs[0].data.status, 'failed');
  assert.equal(inputs[0].data.errorCode, 'HTTP_502');
  assert.equal(inputs[1].data.status, 'cancelled');
  assert.equal(inputs[1].data.errorCode, 'CANCELLED');
});

test('analysis history pagination filters by authenticated owner and omits result/source payloads', async () => {
  let input;
  let count = 21;
  const repo = new RepositoryAnalysisRepository({
    repositoryAnalysis: {
      findMany: async (value) => {
        input = value;
        return Array.from({ length: count }, (_, index) => ({
          id: `analysis-${index}`,
          status: 'succeeded',
        }));
      },
    },
  });
  const page = await repo.list('owner-a', 2, '123');
  assert.deepEqual(input.where, { userId: 'owner-a', repositoryId: '123' });
  assert.deepEqual(input.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(input.skip, 20);
  assert.equal(input.take, 21);
  assert.equal(input.select.userId, undefined);
  assert.equal(input.select.result, undefined);
  assert.equal(input.select.context, undefined);
  assert.equal(page.items.length, 20);
  assert.equal(page.page, 2);
  assert.equal(page.perPage, 20);
  assert.equal(page.hasNextPage, true);
  count = 20;
  assert.equal((await repo.list('owner-b', 1)).hasNextPage, false);
  assert.deepEqual(input.where, { userId: 'owner-b' });
});

test('analysis detail queries include owner in the database filter and project only API fields', async () => {
  let input;
  const repo = new RepositoryAnalysisRepository({
    repositoryAnalysis: {
      findFirst: async (value) => {
        input = value;
        return null;
      },
    },
  });
  assert.equal(await repo.find('owner-b', analysisId), null);
  assert.deepEqual(input.where, { id: analysisId, userId: 'owner-b' });
  assert.equal(input.select.userId, undefined);
  assert.equal(input.select.user, undefined);
  assert.equal(input.select.result, true);
  assert.equal(input.select.context, true);
});

test('analysis repository rejects missing ownership and invalid list pages before database work', async () => {
  const repo = new RepositoryAnalysisRepository({
    repositoryAnalysis: new Proxy({}, { get: () => () => assert.fail('Unexpected database call') }),
  });
  for (const action of [
    () => repo.start('', '123', '', 'model'),
    () => repo.setSnapshot(analysisId, '', snapshot),
    () => repo.succeed(analysisId, '', result),
    () => repo.fail(analysisId, '', 'failed', 'HTTP_502'),
    () => repo.list('', 1),
    () => repo.find('', analysisId),
  ]) {
    await assert.rejects(action(), (error) => error.getStatus() === 401);
  }
  for (const page of [0, -1, 1.5, 1000000, NaN]) {
    await assert.rejects(repo.list('owner-a', page), (error) => error.getStatus() === 400);
  }
});
