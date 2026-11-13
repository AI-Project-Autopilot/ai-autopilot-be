/* eslint-disable @typescript-eslint/no-require-imports -- Tests load CommonJS build output. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { UnauthorizedException } = require('@nestjs/common');
const { createRepositoryTaskRouter } = require('../dist/tasks/repository-task.route');
const { errorHandler } = require('../dist/common/filters/error-handler');
const analysisId = 'c' + 'a'.repeat(24);
const taskId = 'c' + 'b'.repeat(24);
const taskPath = `/api/github/tasks/${taskId}`;
const selectPath = `/api/github/analyses/${analysisId}/tasks`;
const headers = {
  Origin: 'http://localhost:3000',
  Cookie: 'autopilot_session=owner-session',
  'Content-Type': 'application/json',
};

async function withServer(run, overrides = {}) {
  const calls = [];
  const service = { frontendUrl: () => 'http://localhost:3000/connect/github' };
  for (const method of [
    'select',
    'list',
    'get',
    'update',
    'createIssue',
    'syncIssue',
    'linkIssue',
  ]) {
    service[method] = async (...args) => {
      calls.push([method, ...args]);
      if (!args[0]) throw new UnauthorizedException('Login required.');
      return method === 'list'
        ? { items: [], page: args[1], perPage: 20, hasNextPage: false }
        : { id: taskId };
    };
  }
  Object.assign(service, overrides);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', createRepositoryTaskRouter(service));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await run(
      (path, method = 'GET', body, customHeaders = headers) =>
        fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method,
          headers: customHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      calls
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('task mutations require the trusted origin and validate input before invoking services', async () => {
  await withServer(async (request, calls) => {
    for (const [path, method, body] of [
      [selectPath, 'POST', { recommendationId: 'task-1' }],
      [taskPath, 'PATCH', { title: 'Reviewed' }],
      [`${taskPath}/issue`, 'POST', {}],
      [`${taskPath}/issue/sync`, 'POST', {}],
      [`${taskPath}/issue/link`, 'POST', { issueNumber: 17 }],
    ]) {
      for (const origin of [undefined, 'https://evil.example']) {
        const custom = { ...headers };
        if (origin === undefined) delete custom.Origin;
        else custom.Origin = origin;
        assert.equal((await request(path, method, body, custom)).status, 403);
      }
    }
    for (const [path, method, body] of [
      ['/api/github/analyses/bad/tasks', 'POST', { recommendationId: 'task-1' }],
      [selectPath, 'POST', {}],
      [selectPath, 'POST', { recommendationId: 'task-9' }],
      [selectPath, 'POST', { recommendationId: ['task-1'] }],
      [selectPath, 'POST', { recommendationId: 'task-1', title: 'Forged source' }],
      [taskPath, 'PATCH', {}],
      [taskPath, 'PATCH', []],
      [taskPath, 'PATCH', { title: '  ' }],
      [taskPath, 'PATCH', { title: 'x'.repeat(201) }],
      [taskPath, 'PATCH', { body: [] }],
      [taskPath, 'PATCH', { body: 'x'.repeat(30001) }],
      [taskPath, 'PATCH', { status: 'done' }],
      [taskPath, 'PATCH', { status: ['selected'] }],
      [taskPath, 'PATCH', { userId: 'other-owner' }],
      [`${taskPath}/issue`, 'POST', { title: 'Unreviewed override' }],
      [`${taskPath}/issue/sync`, 'POST', { issueNumber: 17 }],
      [`${taskPath}/issue/link`, 'POST', {}],
      ...[0, -1, 1.5, '17', 2147483648].map((issueNumber) => [
        `${taskPath}/issue/link`,
        'POST',
        { issueNumber },
      ]),
    ]) {
      const response = await request(path, method, body);
      assert.equal(
        response.status,
        400,
        `Accepted ${method} ${path}: ${JSON.stringify(body).slice(0, 100)}`
      );
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const path of [
      '/api/github/tasks/bad',
      '/api/github/tasks?page=0',
      '/api/github/tasks?page=1&page=2',
      '/api/github/tasks?repositoryId=0',
      '/api/github/tasks?analysisId=bad',
    ])
      assert.equal((await request(path)).status, 400);
    assert.equal(calls.length, 0);
  });
});

test('task routes pass authenticated owner sessions and reviewed draft fields with no cached responses', async () => {
  await withServer(async (request, calls) => {
    for (const [path, method, body, expected] of [
      [
        selectPath,
        'POST',
        { recommendationId: 'task-1' },
        ['select', 'owner-session', analysisId, 'task-1'],
      ],
      [
        taskPath,
        'PATCH',
        { title: '  Reviewed title  ', body: 'Reviewed\nbody', status: 'in_progress' },
        [
          'update',
          'owner-session',
          taskId,
          { title: 'Reviewed title', body: 'Reviewed\nbody', status: 'in_progress' },
        ],
      ],
      [`${taskPath}/issue`, 'POST', {}, ['createIssue', 'owner-session', taskId]],
      [`${taskPath}/issue/sync`, 'POST', undefined, ['syncIssue', 'owner-session', taskId]],
      [
        `${taskPath}/issue/link`,
        'POST',
        { issueNumber: 17 },
        ['linkIssue', 'owner-session', taskId, 17],
      ],
      [
        `/api/github/tasks?page=2&repositoryId=123&analysisId=${analysisId}`,
        'GET',
        undefined,
        ['list', 'owner-session', 2, '123', analysisId],
      ],
      [taskPath, 'GET', undefined, ['get', 'owner-session', taskId]],
    ]) {
      const response = await request(path, method, body);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.json();
      assert.deepEqual(calls.at(-1), expected);
    }
    const response = await request(taskPath, 'GET', undefined, {});
    assert.equal(response.status, 401);
  });
});

test('task routes hide unexpected provider or database errors', async () => {
  await withServer(
    async (request) => {
      const response = await request(`${taskPath}/issue`, 'POST', {});
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.ok(!body.includes('private-token'));
      assert.ok(!body.includes('database password'));
    },
    {
      createIssue: async () => {
        throw new Error('private-token database password');
      },
    }
  );
});
