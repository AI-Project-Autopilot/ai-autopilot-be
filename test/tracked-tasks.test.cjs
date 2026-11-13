/* eslint-disable @typescript-eslint/no-require-imports -- Tests load CommonJS build output. */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { BadGatewayException, UnauthorizedException } = require('@nestjs/common');
const { RepositoryTaskService } = require('../dist/tasks/repository-task.service');
const { RepositoryTaskRepository } = require('../dist/tasks/repository-task.repository');
const { GitHubIssueRequestError } = require('../dist/tasks/github-issue.client');
const { encrypt } = require('../dist/auth/github-security');

const analysisId = 'c' + 'a'.repeat(24);
const repositoryInfo = {
  id: '123',
  fullName: 'canonical/project',
  htmlUrl: 'https://github.com/canonical/project',
  issuesEnabled: true,
  archived: false,
};
const recommendation = {
  id: 'task-1',
  title: 'Original stored recommendation',
  priority: 'high',
  rationale: 'The source contains a clear validation boundary.',
  implementationSteps: ['Validate the exported result.'],
  acceptanceCriteria: ['Unexpected results are detected.'],
  evidence: [
    {
      path: 'src/main.ts',
      startLine: 1,
      endLine: 1,
      excerpt: 'export const run = () => true;',
      url: `https://github.com/original/project/blob/${'a'.repeat(40)}/src/main.ts#L1-L1`,
    },
  ],
};

beforeEach(() => {
  process.env.GITHUB_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
});

function fixture() {
  const rows = new Map();
  let revision = 0;
  const clone = (value) => structuredClone(value);
  const matches = (row, where) =>
    Object.entries(where).every(([key, value]) =>
      value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value
    );
  const analysis = {
    id: analysisId,
    userId: 'owner',
    repositoryId: '123',
    fullName: 'original/project',
    commitSha: 'a'.repeat(40),
    goal: 'Improve the exported function.',
    status: 'succeeded',
    result: {
      language: 'en',
      recommendations: [recommendation, { ...recommendation, id: 'task-2', title: 'Second task' }],
    },
  };
  const db = {
    repositoryAnalysis: {
      findFirst: async ({ where }) => (matches(analysis, where) ? clone(analysis) : null),
    },
    trackedTask: {
      upsert: async ({ where, create }) => {
        const found = [...rows.values()].find((row) =>
          matches(row, where.userId_analysisId_recommendationId)
        );
        if (found) return clone(found);
        const now = new Date(Date.now() + ++revision);
        const row = {
          id: 'c' + String(rows.size + 1).padStart(24, 'b'),
          ...clone(create),
          status: 'selected',
          issueNumber: null,
          issueUrl: null,
          issueState: null,
          issueStateReason: null,
          issueCreationState: 'none',
          issueCreationStartedAt: null,
          issueSyncedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        rows.set(row.id, row);
        return clone(row);
      },
      findFirst: async ({ where }) => {
        const row = [...rows.values()].find((item) => matches(item, where));
        return row ? clone(row) : null;
      },
      findMany: async ({ where, skip, take }) =>
        clone([...rows.values()].filter((row) => matches(row, where)).slice(skip, skip + take)),
      updateMany: async ({ where, data }) => {
        const selected = [...rows.values()].filter((row) => matches(row, where));
        for (const row of selected) {
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) row[key] = clone(value);
          }
          row.updatedAt = new Date(Date.now() + ++revision);
        }
        return { count: selected.length };
      },
    },
  };
  const repository = new RepositoryTaskRepository(db);
  const auth = {
    frontendUrl: () => 'http://localhost:3000/connect/github',
    session: async (session) => {
      if (!session) throw new UnauthorizedException('Login required.');
      return { userId: session, githubTokenEncrypted: encrypt('current-user-token') };
    },
  };
  const calls = [];
  let externalIssue = null;
  const github = {
    repository: async (token, id) => {
      assert.equal(token, 'current-user-token');
      assert.equal(id, '123');
      return repositoryInfo;
    },
    create: async (_token, repository, draft) => {
      calls.push({ repository, draft });
      externalIssue = {
        number: 17,
        url: 'https://github.com/canonical/project/issues/17',
        state: 'open',
        stateReason: null,
        body: draft.body,
      };
      return externalIssue;
    },
    get: async (_token, _repository, number) => {
      assert.equal(number, externalIssue.number);
      return externalIssue;
    },
    findByMarker: async (_token, _repository, marker) =>
      externalIssue?.body?.split('\n').includes(marker) ? externalIssue : null,
  };
  const service = new RepositoryTaskService(auth, repository, github);
  return {
    service,
    repository,
    github,
    rows,
    analysis,
    calls,
    reconstruct: () => new RepositoryTaskService(auth, repository, github),
    setIssue: (issue) => {
      externalIssue = issue;
    },
  };
}

test('selection uses the stored owner recommendation and reselect preserves reviewed progress', async () => {
  const f = fixture();
  const selected = await f.service.select('owner', analysisId, 'task-1');
  assert.equal(selected.title, recommendation.title);
  assert.match(selected.body, /Validate the exported result/);
  assert.match(selected.body, /Unexpected results are detected/);
  assert.match(selected.body, /src\/main.ts/);
  assert.deepEqual(f.rows.get(selected.id).source, recommendation);
  assert.equal(selected.source, undefined);
  assert.equal(selected.userId, undefined);
  assert.ok(!JSON.stringify(selected).includes('current-user-token'));
  await f.service.update('owner', selected.id, {
    title: 'Reviewed issue title',
    body: 'Reviewed issue body',
    status: 'in_progress',
  });
  const repeated = await f.service.select('owner', analysisId, 'task-1');
  assert.equal(repeated.id, selected.id);
  assert.equal(repeated.title, 'Reviewed issue title');
  assert.equal(repeated.body, 'Reviewed issue body');
  assert.equal(repeated.status, 'in_progress');
  assert.equal(f.rows.size, 1);
  assert.equal(f.calls.length, 0, 'Selecting and reviewing must not create a GitHub issue');
  await assert.rejects(
    f.service.select('owner', analysisId, 'invented'),
    (e) => e.getStatus() === 404
  );
  for (const operation of [
    () => f.service.select('other', analysisId, 'task-1'),
    () => f.service.get('other', selected.id),
    () => f.service.update('other', selected.id, { title: 'Stolen draft' }),
    () => f.service.createIssue('other', selected.id),
  ])
    await assert.rejects(operation, (e) => e.getStatus() === 404);
  assert.equal((await f.service.list('other', 1)).items.length, 0);
});

test(
  'issue creation uses reviewed content and canonical repo while repeated and concurrent requests post once',
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const selected = await f.service.select('owner', analysisId, 'task-1');
    await f.service.update('owner', selected.id, {
      title: 'Reviewed title',
      body: 'Reviewed body',
    });
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const create = f.github.create;
    f.github.create = async (...args) => {
      const issue = await create(...args);
      f.setIssue(null);
      entered();
      await pending;
      f.setIssue(issue);
      return issue;
    };
    const first = f.service.createIssue('owner', selected.id);
    await started;
    await assert.rejects(
      f.reconstruct().createIssue('owner', selected.id),
      (e) => e.getStatus() === 409
    );
    await assert.rejects(
      f.service.update('owner', selected.id, { body: 'Changed after submit' }),
      (e) => e.getStatus() === 409
    );
    await assert.rejects(
      f.service.linkIssue('owner', selected.id, 18),
      (e) => e.getStatus() === 409
    );
    release();
    const saved = await first;
    assert.equal(saved.issueNumber, 17);
    assert.equal(saved.issueCreationState, 'created');
    assert.equal(saved.fullName, repositoryInfo.fullName);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].draft.title, 'Reviewed title');
    assert.equal(f.calls[0].draft.body, `Reviewed body\n\n<!-- autopilot-task:${selected.id} -->`);
    assert.equal(f.calls[0].repository.fullName, repositoryInfo.fullName);
    assert.equal((await f.reconstruct().createIssue('owner', selected.id)).issueNumber, 17);
    assert.equal(f.calls.length, 1);
  }
);

test('definitive GitHub rejection releases the claim while ambiguous outcomes remain locked', async () => {
  for (const [failure, expectedState] of [
    [new GitHubIssueRequestError('Rejected', 422, true), 'none'],
    [new GitHubIssueRequestError('Timed out', 502, false), 'uncertain'],
    [new GitHubIssueRequestError('Server failed', 502, false), 'uncertain'],
    [new BadGatewayException('Malformed successful issue response'), 'uncertain'],
  ]) {
    const f = fixture();
    const selected = await f.service.select('owner', analysisId, 'task-1');
    let attempts = 0;
    f.github.create = async () => {
      attempts++;
      throw failure;
    };
    await assert.rejects(f.service.createIssue('owner', selected.id), (e) => e === failure);
    assert.equal(f.rows.get(selected.id).issueCreationState, expectedState);
    assert.equal(f.rows.get(selected.id).issueNumber, null);
    if (expectedState === 'uncertain') {
      await assert.rejects(
        f.reconstruct().createIssue('owner', selected.id),
        (e) => e.getStatus() === 409
      );
      assert.equal(attempts, 1, 'A retry without a matching issue must not risk a second POST');
      await assert.rejects(
        f.service.update('owner', selected.id, { title: 'New draft' }),
        (e) => e.getStatus() === 409
      );
    } else {
      await f.service.update('owner', selected.id, { title: 'Corrected draft' });
      await assert.rejects(f.service.createIssue('owner', selected.id), (e) => e === failure);
      assert.equal(attempts, 2, 'Definitively rejected requests can be reviewed and resubmitted');
    }
  }
});

test(
  'a stale manual link cannot overwrite concurrent creation even when update timestamps collide',
  { timeout: 5000 },
  async () => {
    const f = fixture();
    const selected = await f.service.select('owner', analysisId, 'task-1');
    const originalVersion = new Date(f.rows.get(selected.id).updatedAt);
    let checkingIssue;
    const checking = new Promise((resolve) => {
      checkingIssue = resolve;
    });
    let finishCheck;
    const manualResult = new Promise((resolve) => {
      finishCheck = resolve;
    });
    f.github.get = async () => {
      checkingIssue();
      return manualResult;
    };
    const linking = f.service.linkIssue('owner', selected.id, 18);
    await checking;
    let postingIssue;
    const posting = new Promise((resolve) => {
      postingIssue = resolve;
    });
    let finishPost;
    const postResult = new Promise((resolve) => {
      finishPost = resolve;
    });
    const create = f.github.create;
    f.github.create = async (...args) => {
      postingIssue();
      await postResult;
      return create(...args);
    };
    const creating = f.reconstruct().createIssue('owner', selected.id);
    await posting;
    // PostgreSQL stores millisecond timestamps; two writes can share a version.
    f.rows.get(selected.id).updatedAt = originalVersion;
    finishCheck({
      number: 18,
      url: 'https://github.com/canonical/project/issues/18',
      state: 'open',
      stateReason: null,
      body: 'Existing issue',
    });
    await assert.rejects(linking, (e) => e.getStatus() === 409);
    assert.equal(f.rows.get(selected.id).issueNumber, null);
    assert.equal(f.rows.get(selected.id).issueCreationState, 'creating');
    finishPost();
    assert.equal((await creating).issueNumber, 17);
    assert.equal(f.calls.length, 1);
  }
);

test('lost provider responses and database save failures reconcile by marker without another POST', async () => {
  for (const failureStage of ['provider-response', 'database-save']) {
    const f = fixture();
    const selected = await f.service.select('owner', analysisId, 'task-1');
    const create = f.github.create;
    const save = f.repository.saveIssue.bind(f.repository);
    const failure = new Error('private storage or provider details');
    if (failureStage === 'provider-response') {
      f.github.create = async (...args) => {
        await create(...args);
        throw failure;
      };
    } else {
      f.repository.saveIssue = async () => {
        throw failure;
      };
    }
    await assert.rejects(f.service.createIssue('owner', selected.id));
    assert.equal(f.calls.length, 1);
    assert.ok(['creating', 'uncertain'].includes(f.rows.get(selected.id).issueCreationState));
    f.repository.saveIssue = save;
    const recovered = await f.reconstruct().createIssue('owner', selected.id);
    assert.equal(recovered.issueNumber, 17);
    assert.equal(recovered.issueCreationState, 'created');
    assert.equal(f.calls.length, 1);
  }
});

test('explicit synchronization tracks completion, reopening and not-planned cancellation; manual linking avoids POST', async () => {
  const f = fixture();
  const selected = await f.service.select('owner', analysisId, 'task-1');
  await f.service.createIssue('owner', selected.id);
  for (const [state, stateReason, status] of [
    ['closed', 'completed', 'completed'],
    ['open', 'reopened', 'in_progress'],
    ['closed', 'not_planned', 'cancelled'],
  ]) {
    f.setIssue({
      number: 17,
      url: 'https://github.com/canonical/project/issues/17',
      state,
      stateReason,
      body: 'Existing issue body',
    });
    const synced = await f.reconstruct().syncIssue('owner', selected.id);
    assert.equal(synced.status, status);
    assert.equal(synced.issueState, state);
    assert.equal(synced.issueStateReason, stateReason);
    assert.ok(synced.issueSyncedAt);
  }
  const second = await f.service.select('owner', analysisId, 'task-2');
  f.setIssue({
    number: 18,
    url: 'https://github.com/canonical/project/issues/18',
    state: 'open',
    stateReason: null,
    body: 'Pre-existing issue without marker',
  });
  const linked = await f.service.linkIssue('owner', second.id, 18);
  assert.equal(linked.issueNumber, 18);
  assert.equal(linked.issueCreationState, 'created');
  assert.equal(f.calls.length, 1, 'Manual linking must only read the existing GitHub issue');
});
