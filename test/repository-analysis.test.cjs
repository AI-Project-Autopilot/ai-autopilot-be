const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { MetaAnalysisClient } = require('../dist/analysis/meta.client');
const { RepositoryAnalysisService } = require('../dist/analysis/repository-analysis.service');
const { createRepositoryAnalysisRouter } = require('../dist/analysis/repository-analysis.route');
const { encrypt } = require('../dist/auth/github-security');
const { errorHandler } = require('../dist/common/filters/error-handler');
const {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
  UnauthorizedException,
} = require('@nestjs/common');
const realFetch = global.fetch;

const snapshot = {
  repository: {
    id: '123',
    fullName: 'octo/project',
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/octo/project',
    isPrivate: true,
    commitSha: 'a'.repeat(40),
  },
  files: [
    {
      path: 'src/main.ts',
      content: 'export function run() {\n  return true;\n}',
      bytes: 41,
      truncated: false,
      lineCount: 3,
    },
  ],
  totalFiles: 20,
  skippedFiles: 19,
  treeTruncated: false,
  warnings: ['Only selected source files were read.'],
};

function modelResult() {
  return {
    summary: '주요 실행 함수를 확인했습니다.',
    recommendations: [
      {
        title: '실행 함수 검증 추가',
        priority: 'high',
        rationale: '실행 결과를 검증할 명확한 경계가 있습니다.',
        implementationSteps: ['실행 함수의 입력과 출력을 검증합니다.'],
        acceptanceCriteria: ['정상 실행 결과를 검증할 수 있습니다.'],
        evidence: [{ referenceId: 'source-1' }],
      },
    ],
  };
}

beforeEach(() => {
  process.env.MODEL_API_KEY = 'test-meta-key';
  process.env.META_MODEL = 'muse-spark-1.3';
  process.env.META_API_BASE_URL = 'https://api.meta.ai/v1';
  process.env.GITHUB_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
});
afterEach(() => {
  global.fetch = realFetch;
});

test('Meta client sends selected source and goal, treats repository content as data, and verifies citations', async () => {
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://api.meta.ai/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-meta-key');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'muse-spark-1.3');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.store, false);
    assert.match(body.messages[0].content, /untrusted data/);
    const context = JSON.parse(body.messages[1].content);
    assert.equal(context.goal, '다음 개발 작업');
    assert.equal(context.files[0].referenceId, 'source-1');
    assert.match(context.files[0].content, /1: export function run/);
    assert.ok(!init.body.includes('test-meta-key'));
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelResult()) } }],
    });
  };
  const result = await new MetaAnalysisClient().analyze(snapshot, '다음 개발 작업');
  assert.equal(result.recommendations[0].id, 'task-1');
  assert.equal(result.recommendations[0].evidence[0].excerpt, snapshot.files[0].content);
  assert.equal(
    result.recommendations[0].evidence[0].url,
    `https://github.com/octo/project/blob/${'a'.repeat(40)}/src/main.ts#L1-L3`
  );
});

test('Meta citation IDs resolve to server-defined source blocks rather than model supplied line numbers', async () => {
  const content = Array.from(
    { length: 45 },
    (_, index) => `const value${index + 1} = ${index + 1};`
  ).join('\n');
  const input = { ...snapshot, files: [{ ...snapshot.files[0], content, lineCount: 45 }] };
  global.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const supplied = JSON.parse(request.messages[1].content).files;
    assert.equal(supplied[1].startLine, 21);
    assert.equal(supplied[1].endLine, 40);
    const result = modelResult();
    result.recommendations[0].evidence = [
      { referenceId: 'source-2', startLine: 999, url: 'https://evil.example' },
    ];
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    });
  };
  const result = await new MetaAnalysisClient().analyze(input, '');
  const reference = result.recommendations[0].evidence[0];
  assert.equal(reference.startLine, 21);
  assert.equal(reference.endLine, 40);
  assert.match(reference.excerpt, /^const value21/);
  assert.ok(reference.url.endsWith('#L21-L40'));
});

test('Meta client rejects invented references, bad priorities, missing steps and incomplete output', async () => {
  for (const mutate of [
    (r) => {
      r.recommendations[0].evidence[0].referenceId = 'invented-file';
    },
    (r) => {
      r.recommendations[0].evidence[0] = { path: 'src/main.ts', startLine: 1, endLine: 999 };
    },
    (r) => {
      r.recommendations[0].priority = 'urgent';
    },
    (r) => {
      r.recommendations[0].implementationSteps = [];
    },
    (r) => {
      r.recommendations = [];
    },
  ]) {
    const invalid = modelResult();
    mutate(invalid);
    global.fetch = async () =>
      Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(invalid) } }],
      });
    await assert.rejects(
      new MetaAnalysisClient().analyze(snapshot, ''),
      (error) => error.getStatus() === 502
    );
  }
  global.fetch = async () =>
    Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] });
  await assert.rejects(
    new MetaAnalysisClient().analyze(snapshot, ''),
    (error) => error.getStatus() === 502
  );
});

test('Meta upstream failures do not expose key/provider details or misreport user authentication', async () => {
  for (const [status, expected] of [
    [401, 503],
    [403, 503],
    [429, 429],
    [500, 502],
  ]) {
    global.fetch = async () => new Response('private provider secret test-meta-key', { status });
    await assert.rejects(
      new MetaAnalysisClient().analyze(snapshot, ''),
      (error) => error.getStatus() === expected && !error.message.includes('test-meta-key')
    );
  }
  const cancelled = new AbortController();
  cancelled.abort();
  global.fetch = async () => {
    throw new Error('private connection error');
  };
  await assert.rejects(
    new MetaAnalysisClient().analyze(snapshot, '', cancelled.signal),
    (error) => error.getStatus() === 504
  );
  delete process.env.MODEL_API_KEY;
  delete process.env.META_API_KEY;
  await assert.rejects(
    new MetaAnalysisClient().analyze(snapshot, ''),
    (error) => error.getStatus() === 503
  );
});

test('analysis service uses current user token, blocks concurrent duplicate analysis, and omits raw source', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const service = new RepositoryAnalysisService(
    { session: async () => ({ userId: 'u', githubTokenEncrypted: encrypt('current-user-token') }) },
    {
      snapshot: async (token, id) => {
        assert.equal(token, 'current-user-token');
        assert.equal(id, '123');
        return snapshot;
      },
    },
    {
      configuration: () => ({ model: 'muse-spark-1.3' }),
      analyze: async () => {
        await pending;
        return { model: 'muse-spark-1.3', ...modelResult() };
      },
    },
    {
      start: async () => ({ id: 'c' + 'a'.repeat(24) }),
      setSnapshot: async () => {},
      succeed: async () => {},
      fail: async () => assert.fail('Successful analysis must not persist failure'),
    }
  );
  const first = service.analyze('session', '123', 'goal');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    service.analyze('session', '123', 'goal'),
    (error) => error.getStatus() === 409
  );
  finish();
  const result = await first;
  assert.equal(result.analysisId, 'c' + 'a'.repeat(24));
  assert.equal(result.repository.commitSha, snapshot.repository.commitSha);
  assert.equal(result.context.filesRead[0].content, undefined);
  assert.ok(!JSON.stringify(result).includes('current-user-token'));
  assert.equal((await service.analyze('session', '123', 'goal')).model, 'muse-spark-1.3');
});

test('HTTP analysis route validates origin, identity and goal before any repository/model work', async () => {
  let calls = 0;
  const service = {
    frontendUrl: () => 'http://localhost:3000/connect/github',
    analyze: async (token, id, goal) => {
      calls++;
      if (!token) throw new UnauthorizedException('Login required.');
      assert.equal(token, 'session');
      assert.equal(id, '123');
      assert.equal(goal, '개선');
      return { model: 'muse-spark-1.3', repository: snapshot.repository, ...modelResult() };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createRepositoryAnalysisRouter(service));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/github/repositories`;
    const headers = {
      Origin: 'http://localhost:3000',
      'Content-Type': 'application/json',
      Cookie: 'autopilot_session=session',
    };
    let response = await realFetch(`${url}/123/analysis`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://evil.example' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
    for (const [id, body] of [
      ['bad', {}],
      ['123', { goal: ['wrong'] }],
      ['123', { goal: 'x'.repeat(2001) }],
    ]) {
      response = await realFetch(`${url}/${id}/analysis`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.equal(calls, 0);
    }
    response = await realFetch(`${url}/123/analysis`, {
      method: 'POST',
      headers: { Origin: headers.Origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401);
    response = await realFetch(`${url}/123/analysis`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ goal: ' 개선 ' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).repository.id, '123');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function resolvedAnalysis() {
  return {
    model: 'muse-spark-1.3',
    summary: '실행 함수의 결과 검증을 개선할 수 있습니다.',
    recommendations: [
      {
        id: 'task-1',
        title: '실행 결과 검증',
        priority: 'high',
        rationale: '실행 결과를 확인할 수 있는 경계가 있습니다.',
        implementationSteps: ['실행 결과 검증을 추가합니다.'],
        acceptanceCriteria: ['잘못된 실행 결과를 감지합니다.'],
        evidence: [
          {
            path: 'src/main.ts',
            startLine: 2,
            endLine: 2,
            excerpt: '  return true;',
            url: `https://github.com/octo/project/blob/${'a'.repeat(40)}/src/main.ts#L2-L2`,
          },
        ],
      },
    ],
  };
}

function analysisFixture(overrides = {}) {
  const events = [];
  const failures = [];
  const saved = [];
  let sequence = 0;
  const repository = {
    start: async (userId, repositoryId, goal, model) => {
      events.push('start');
      assert.equal(userId, 'owner-a');
      assert.equal(repositoryId, '123');
      assert.equal(goal, 'goal');
      assert.equal(model, 'muse-spark-1.3');
      return { id: 'c' + String(++sequence).padStart(24, 'a') };
    },
    setSnapshot: async (_id, userId, captured) => {
      events.push('snapshot-saved');
      assert.equal(userId, 'owner-a');
      assert.equal(captured, snapshot);
    },
    succeed: async (id, userId, result) => {
      events.push('succeeded');
      saved.push({ id, userId, result });
    },
    fail: async (...args) => {
      events.push('failed');
      failures.push(args);
    },
    ...overrides.repository,
  };
  const service = new RepositoryAnalysisService(
    {
      session: async () => {
        events.push('authenticated');
        return { userId: 'owner-a', githubTokenEncrypted: encrypt('current-owner-token') };
      },
      frontendUrl: () => 'http://localhost:3000/connect/github',
      ...overrides.auth,
    },
    {
      snapshot: async (token, repositoryId) => {
        events.push('snapshot');
        assert.equal(token, 'current-owner-token');
        assert.equal(repositoryId, '123');
        return snapshot;
      },
      ...overrides.source,
    },
    {
      configuration: () => {
        events.push('configured');
        return { model: 'muse-spark-1.3' };
      },
      analyze: async () => {
        events.push('model');
        return resolvedAnalysis();
      },
      ...overrides.model,
    },
    repository
  );
  return { service, repository, events, failures, saved };
}

test('analysis success waits for database persistence and keeps the per-user lock while saving', async () => {
  let saveStarted;
  let finishSave;
  const saving = new Promise((resolve) => {
    saveStarted = resolve;
  });
  const saveComplete = new Promise((resolve) => {
    finishSave = resolve;
  });
  const captured = [];
  const { service, events, failures } = analysisFixture({
    repository: {
      succeed: async (...args) => {
        captured.push(args);
        saveStarted();
        await saveComplete;
        events.push('database-committed');
      },
    },
  });
  let settled = false;
  const pending = service.analyze('session-a', '123', 'goal');
  pending.then(() => {
    settled = true;
  });
  await saving;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'Success must not escape before the database acknowledges the save');
  await assert.rejects(
    service.analyze('session-a', '123', 'goal'),
    (error) => error.getStatus() === 409
  );
  assert.equal(captured[0][1], 'owner-a');
  assert.equal(captured[0][2].analysisId, captured[0][0]);
  assert.equal(captured[0][2].context.filesRead[0].content, undefined);
  assert.ok(!JSON.stringify(captured).includes('current-owner-token'));
  finishSave();
  const result = await pending;
  assert.equal(result.analysisId, captured[0][0]);
  assert.deepEqual(events.slice(0, 6), [
    'authenticated',
    'configured',
    'start',
    'snapshot',
    'snapshot-saved',
    'model',
  ]);
  assert.equal(events.at(-1), 'database-committed');
  assert.deepEqual(failures, []);
});

test('database save failure rejects the analysis, records failure, and releases the user lock', async () => {
  const storageError = new Error('private database credential current-owner-token');
  let attempts = 0;
  const { service, failures } = analysisFixture({
    repository: {
      succeed: async () => {
        if (++attempts === 1) throw storageError;
      },
    },
  });
  await assert.rejects(
    service.analyze('session-a', '123', 'goal'),
    (error) => error === storageError
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0][1], 'owner-a');
  assert.equal(failures[0][2], 'failed');
  assert.equal(failures[0][3], 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(failures).includes('credential'));
  assert.ok(!JSON.stringify(failures).includes('current-owner-token'));
  const retry = await service.analyze('session-a', '123', 'goal');
  assert.ok(retry.analysisId);
  assert.equal(attempts, 2);
});

test('source and model failures are persisted without reporting a successful analysis', async () => {
  for (const stage of ['source', 'model']) {
    const failure = new BadGatewayException('private upstream source or provider details');
    const overrides =
      stage === 'source'
        ? {
            source: {
              snapshot: async () => {
                throw failure;
              },
            },
          }
        : {
            model: {
              analyze: async () => {
                throw failure;
              },
            },
          };
    const { service, failures, saved, events } = analysisFixture(overrides);
    await assert.rejects(service.analyze('session-a', '123', 'goal'), (error) => error === failure);
    assert.equal(saved.length, 0);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].slice(1), ['owner-a', 'failed', 'HTTP_502']);
    assert.ok(!JSON.stringify(failures).includes('private upstream'));
    assert.ok(events.includes('start'));
    if (stage === 'source') assert.ok(!events.includes('snapshot-saved'));
    else assert.ok(events.includes('snapshot-saved'));
  }
});

test('client cancellation and provider timeout receive distinct persisted terminal statuses', async () => {
  const controller = new AbortController();
  let reachedModel;
  let rejectModel;
  const inModel = new Promise((resolve) => {
    reachedModel = resolve;
  });
  const provider = new Promise((_resolve, reject) => {
    rejectModel = reject;
  });
  const { service, failures, saved } = analysisFixture({
    model: {
      analyze: async (_snapshot, _goal, signal) => {
        assert.equal(signal.aborted, false);
        reachedModel();
        return provider;
      },
    },
  });
  const pending = service.analyze('session-a', '123', 'goal', controller.signal);
  await inModel;
  controller.abort();
  rejectModel(new GatewayTimeoutException('private interrupted provider request'));
  await assert.rejects(pending, (error) => error.getStatus() === 504);
  assert.deepEqual(failures[0].slice(1), ['owner-a', 'cancelled', 'CANCELLED']);
  assert.equal(saved.length, 0);

  const timedOut = analysisFixture({
    model: {
      analyze: async () => {
        throw new GatewayTimeoutException('private provider timeout');
      },
    },
  });
  await assert.rejects(
    timedOut.service.analyze('session-a', '123', 'goal'),
    (error) => error.getStatus() === 504
  );
  assert.deepEqual(timedOut.failures[0].slice(1), ['owner-a', 'failed', 'HTTP_504']);
});

test('unauthenticated or unconfigured analysis never starts persistence or sends repository data', async () => {
  const denied = analysisFixture({
    auth: {
      session: async () => {
        throw new UnauthorizedException('Login required.');
      },
    },
  });
  await assert.rejects(
    denied.service.analyze(undefined, '123', 'goal'),
    (error) => error.getStatus() === 401
  );
  assert.deepEqual(denied.events, []);
  assert.deepEqual(denied.failures, []);
  const unconfigured = analysisFixture({
    model: {
      configuration: () => {
        throw new ServiceUnavailableException('Model unavailable.');
      },
    },
  });
  await assert.rejects(
    unconfigured.service.analyze('session-a', '123', 'goal'),
    (error) => error.getStatus() === 503
  );
  assert.deepEqual(unconfigured.events, ['authenticated']);
  assert.deepEqual(unconfigured.failures, []);
});

test('analysis history uses authenticated owner for list/detail and hides inaccessible analyses as 404', async () => {
  const analysisId = 'c' + 'a'.repeat(24);
  const calls = [];
  const row = {
    id: analysisId,
    repositoryId: '123',
    status: 'succeeded',
    result: { summary: 'Saved result' },
    context: { filesRead: [] },
  };
  const { service } = analysisFixture({
    auth: {
      session: async (token) => {
        if (!token) throw new UnauthorizedException('Login required.');
        return { userId: token };
      },
    },
    repository: {
      list: async (...args) => {
        calls.push(['list', ...args]);
        return {
          items: args[0] === 'owner-a' ? [row] : [],
          page: args[1],
          perPage: 20,
          hasNextPage: false,
        };
      },
      find: async (...args) => {
        calls.push(['find', ...args]);
        return args[0] === 'owner-a' && args[1] === analysisId ? row : null;
      },
    },
  });
  assert.deepEqual((await service.list('owner-a', 2, '123')).items, [row]);
  assert.deepEqual(calls[0], ['list', 'owner-a', 2, '123']);
  assert.deepEqual(await service.get('owner-a', analysisId), row);
  assert.equal((await service.get('owner-a', analysisId)).userId, undefined);
  await assert.rejects(service.get('owner-b', analysisId), (error) => error.getStatus() === 404);
  assert.deepEqual((await service.list('owner-b', 1)).items, []);
  const before = calls.length;
  await assert.rejects(service.list(undefined, 1), (error) => error.getStatus() === 401);
  await assert.rejects(service.get(undefined, analysisId), (error) => error.getStatus() === 401);
  assert.equal(calls.length, before);
});

async function withAnalysisServer(service, run) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createRepositoryAnalysisRouter(service));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await run((path, options = {}) => realFetch(`${base}${path}`, options));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP history validates query/analysis IDs and authenticates owner-scoped reads without caching', async () => {
  const id = 'c' + 'a'.repeat(24);
  const calls = [];
  await withAnalysisServer(
    {
      list: async (token, page, repositoryId) => {
        calls.push(['list', token, page, repositoryId]);
        if (!token) throw new UnauthorizedException('Login required.');
        return {
          items: [{ id, repositoryId: '123', status: 'succeeded' }],
          page,
          perPage: 20,
          hasNextPage: false,
        };
      },
      get: async (token, analysisId) => {
        calls.push(['get', token, analysisId]);
        if (!token) throw new UnauthorizedException('Login required.');
        return { id: analysisId, status: 'succeeded', result: { summary: 'Saved analysis' } };
      },
    },
    async (request) => {
      const headers = { Cookie: 'autopilot_session=owner-session' };
      for (const query of [
        'page=0',
        'page=-1',
        'page=1.5',
        'page=1000000',
        'page=1&page=2',
        'repositoryId=0',
        'repositoryId=abc',
        'repositoryId=123&repositoryId=456',
      ]) {
        const response = await request(`/api/github/analyses?${query}`, { headers });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      for (const invalid of [
        'bad',
        'c' + 'a'.repeat(23),
        'c' + 'a'.repeat(25),
        'C' + 'a'.repeat(24),
      ]) {
        assert.equal((await request(`/api/github/analyses/${invalid}`, { headers })).status, 400);
      }
      assert.equal(calls.length, 0);
      assert.equal((await request('/api/github/analyses')).status, 401);
      assert.equal((await request(`/api/github/analyses/${id}`)).status, 401);
      let response = await request('/api/github/analyses?page=2&repositoryId=123', { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).page, 2);
      assert.deepEqual(calls.at(-1), ['list', 'owner-session', 2, '123']);
      response = await request(`/api/github/analyses/${id}`, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).result.summary, 'Saved analysis');
      assert.deepEqual(calls.at(-1), ['get', 'owner-session', id]);
    }
  );
});

test('HTTP analysis returns 500 when result persistence fails instead of returning unsaved model output', async () => {
  const { service, failures } = analysisFixture({
    repository: {
      succeed: async () => {
        throw new Error('private database credential');
      },
    },
  });
  await withAnalysisServer(service, async (request) => {
    const response = await request('/api/github/repositories/123/analysis', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        'Content-Type': 'application/json',
        Cookie: 'autopilot_session=owner-session',
      },
      body: JSON.stringify({ goal: 'goal' }),
    });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.ok(!body.includes('private database'));
    assert.ok(!body.includes('실행 함수의 결과 검증'));
    assert.deepEqual(failures[0].slice(1), ['owner-a', 'failed', 'INTERNAL_ERROR']);
  });
});
