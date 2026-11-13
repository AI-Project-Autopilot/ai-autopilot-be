/* eslint-disable @typescript-eslint/no-require-imports -- Tests load CommonJS build output. */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { GitHubIssueClient } = require('../dist/tasks/github-issue.client');
const realFetch = global.fetch;
const repository = {
  id: '123',
  fullName: 'canonical/project',
  htmlUrl: 'https://github.com/canonical/project',
  issuesEnabled: true,
  archived: false,
};
const marker = '<!-- autopilot-task:ctesttask -->';
function issue(overrides = {}) {
  return {
    number: 17,
    html_url: 'https://github.com/canonical/project/issues/17',
    state: 'open',
    state_reason: null,
    body: `Reviewed issue body\n\n${marker}`,
    ...overrides,
  };
}
afterEach(() => {
  global.fetch = realFetch;
});

test('issue client resolves canonical repositories by numeric ID and checks repository URLs', async () => {
  let payload = {
    id: 123,
    full_name: repository.fullName,
    html_url: repository.htmlUrl,
    has_issues: true,
    archived: false,
  };
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/repositories/123');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer private-token');
    assert.equal(init.redirect, 'error');
    return Response.json(payload);
  };
  const client = new GitHubIssueClient();
  assert.deepEqual(await client.repository('private-token', '123'), repository);
  for (const patch of [
    { id: 456 },
    { full_name: 'canonical/../project' },
    { full_name: 'canonical/..' },
    { html_url: 'https://evil.example/canonical/project' },
    { html_url: 'https://github.com/other/project' },
    { has_issues: 'true' },
  ]) {
    payload = {
      id: 123,
      full_name: repository.fullName,
      html_url: repository.htmlUrl,
      has_issues: true,
      archived: false,
      ...patch,
    };
    await assert.rejects(client.repository('private-token', '123'), (e) => e.getStatus() === 502);
  }
});

test('issue client posts the reviewed draft unchanged to the resolved repository', async () => {
  const draft = { title: 'Reviewed title', body: `Reviewed issue body\n\n${marker}` };
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/canonical/project/issues');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), draft);
    assert.equal(init.redirect, 'error');
    return Response.json(issue());
  };
  const result = await new GitHubIssueClient().create('private-token', repository, draft);
  assert.equal(result.number, 17);
  assert.equal(result.url, issue().html_url);
  assert.equal(result.body, draft.body);
});

test('issue client rejects wrong issue numbers, foreign URLs and pull requests', async () => {
  const client = new GitHubIssueClient();
  for (const patch of [
    { number: 18, html_url: 'https://github.com/canonical/project/issues/18' },
    { html_url: 'https://evil.example/issues/17' },
    { html_url: 'https://github.com/other/project/issues/17' },
    { html_url: 'https://github.com/canonical/project/issues/17?redirect=evil' },
    { pull_request: { url: 'https://api.github.com/repos/canonical/project/pulls/17' } },
    { state: 'merged' },
    { state_reason: 'private-token' },
  ]) {
    global.fetch = async () => Response.json(issue(patch));
    await assert.rejects(
      client.get('private-token', repository, 17),
      (e) => e.getStatus() === 502 && !e.message.includes('private-token')
    );
  }
});

test('issue client distinguishes definitive rejection from uncertain outcomes without exposing provider details', async () => {
  const client = new GitHubIssueClient();
  for (const [status, expected, definitive] of [
    [401, 401, true],
    [403, 403, true],
    [404, 404, true],
    [410, 410, true],
    [422, 422, true],
    [429, 429, true],
    [408, 502, false],
    [500, 502, false],
  ]) {
    global.fetch = async () => new Response('private-token private upstream body', { status });
    await assert.rejects(
      client.create('private-token', repository, { title: 'Title', body: 'Body' }),
      (e) =>
        e.getStatus() === expected &&
        e.definitiveRejection === definitive &&
        !e.message.includes('private-token') &&
        !e.message.includes('private upstream')
    );
  }
  for (const response of [
    async () => {
      throw new Error('private-token socket timed out');
    },
    async () => new Response('private-token malformed JSON'),
  ]) {
    global.fetch = response;
    await assert.rejects(
      client.create('private-token', repository, { title: 'Title', body: 'Body' }),
      (e) =>
        e.getStatus() === 502 &&
        e.definitiveRejection === false &&
        !e.message.includes('private-token')
    );
  }
});

test('marker reconciliation paginates all issues and ignores PRs and inline marker lookalikes', async () => {
  const pages = [];
  global.fetch = async (url, init) => {
    assert.equal(init.method, 'GET');
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(parsed.searchParams.get('state'), 'all');
    const page = Number(parsed.searchParams.get('page'));
    pages.push(page);
    if (page === 1) {
      const items = Array.from({ length: 100 }, () => issue({ body: 'Unrelated issue' }));
      items[0] = issue({ body: marker, pull_request: {} });
      items[1] = issue({ body: `Quoted marker ${marker}` });
      return Response.json(items, {
        headers: { Link: '<https://evil.example/steal>; rel="next"' },
      });
    }
    return Response.json([issue({ body: `Reviewed issue body\r\n\r\n${marker}\r\n` })]);
  };
  const result = await new GitHubIssueClient().findByMarker('private-token', repository, marker);
  assert.equal(result.number, 17);
  assert.deepEqual(pages, [1, 2]);
});

test('marker reconciliation reports ambiguity and bounds its search without making a POST', async () => {
  const client = new GitHubIssueClient();
  global.fetch = async () =>
    Response.json([
      issue(),
      issue({ number: 18, html_url: 'https://github.com/canonical/project/issues/18' }),
    ]);
  await assert.rejects(
    client.findByMarker('private-token', repository, marker),
    (e) => e.getStatus() === 409
  );
  let reads = 0;
  global.fetch = async (_url, init) => {
    reads++;
    assert.equal(init.method, 'GET');
    return Response.json(
      Array.from({ length: 100 }, () => issue({ body: 'Unrelated issue' })),
      {
        headers: { Link: '<https://api.github.com/next>; rel="next"' },
      }
    );
  };
  assert.equal(await client.findByMarker('private-token', repository, marker), null);
  assert.equal(reads, 10);
});
