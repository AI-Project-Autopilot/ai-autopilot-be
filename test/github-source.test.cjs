/* eslint-disable @typescript-eslint/no-require-imports -- Node tests load compiled CommonJS output. */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { GitHubSourceClient } = require('../dist/analysis/github-source.client');

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);

function source(path, content, overrides = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return {
    entry: { path, type: 'blob', mode: '100644', sha, size: bytes.length, ...overrides },
    blob: { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') },
  };
}

function mockRepository(sources, { truncated = false, metadata = {}, changeResponse } = {}) {
  const calls = [];
  global.fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.get('Authorization'), 'Bearer current-user-token');
    assert.ok(init.signal instanceof AbortSignal);
    let payload;
    if (url.pathname === '/repositories/42') {
      payload = {
        id: 42,
        full_name: 'canonical-owner/canonical-repo',
        default_branch: 'release/main',
        private: true,
        html_url: 'https://evil.example/ignored',
        url: 'http://169.254.169.254/ignored',
        ...metadata,
      };
    } else if (
      url.pathname === '/repos/canonical-owner/canonical-repo/commits/heads%2Frelease%2Fmain'
    ) {
      assert.equal(url.searchParams.get('per_page'), '1');
      payload = {
        sha: commitSha,
        commit: { tree: { sha: treeSha, url: 'https://evil.example/tree' } },
      };
    } else if (url.pathname === `/repos/canonical-owner/canonical-repo/git/trees/${treeSha}`) {
      assert.equal(url.searchParams.get('recursive'), '1');
      payload = { sha: treeSha, tree: sources.map(({ entry }) => entry), truncated };
    } else {
      const item = sources.find(({ entry }) => url.pathname.endsWith(`/git/blobs/${entry.sha}`));
      assert.ok(item, `Unexpected request: ${url.pathname}`);
      payload = item.blob;
    }
    const response = changeResponse?.(url, payload);
    return (
      response ??
      Response.json(payload, { headers: { link: '<https://evil.example>; rel="next"' } })
    );
  };
  return calls;
}

test('snapshot resolves canonical identity and pins commit, tree and blob SHAs with current token', async () => {
  const sources = [
    source('README.md', '# Example\nUse this project.\n'),
    source('src/main.ts', 'run();\n'),
  ];
  const calls = mockRepository(sources);
  const snapshot = await new GitHubSourceClient().snapshot('current-user-token', '42');
  assert.deepEqual(snapshot.repository, {
    id: '42',
    fullName: 'canonical-owner/canonical-repo',
    defaultBranch: 'release/main',
    htmlUrl: 'https://github.com/canonical-owner/canonical-repo',
    isPrivate: true,
    commitSha,
  });
  assert.equal(snapshot.files.length, 2);
  assert.equal(snapshot.totalFiles, 2);
  assert.equal(snapshot.skippedFiles, 0);
  assert.equal(snapshot.treeTruncated, false);
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(3).every(({ url }) => /\/git\/blobs\/[a-f0-9]{40}$/.test(url.pathname)));
  assert.equal(snapshot.files[0].content, '# Example\nUse this project.\n');
});

test('sensitive, generated, locked and large paths plus symlinks/submodules are never fetched', async () => {
  const paths = [
    '.env',
    '.env.production',
    '.envrc',
    '.environment/config.json',
    'nested/.env.example',
    'config/credentials.json',
    'credentials/google.json',
    'certificates/development.txt',
    'secrets.yaml',
    'service-account.json',
    'cert.pem',
    '.npmrc',
    '.aws/config',
    'node_modules/pkg/index.js',
    'vendor/lib/main.py',
    'dist/main.js',
    'src/generated/client.ts',
    'yarn.lock',
    'package-lock.json',
    'assets/logo.png',
    'src/code.min.js',
  ];
  const sources = paths.map((path) => source(path, 'DO_NOT_FETCH'));
  sources.push(source('src/symlink.ts', '/etc/passwd', { mode: '120000' }));
  sources.push(source('src/too-large.ts', 'x'.repeat(64 * 1024 + 1)));
  sources.push(source('README.md', '# Safe\n'));
  sources.push({
    entry: { path: 'submodule', type: 'commit', mode: '160000', sha: 'c'.repeat(40) },
  });
  const calls = mockRepository(sources, { truncated: true });
  const result = await new GitHubSourceClient().snapshot('current-user-token', '42');
  assert.deepEqual(
    result.files.map(({ path }) => path),
    ['README.md']
  );
  assert.equal(calls.length, 4);
  assert.equal(result.totalFiles, paths.length + 3);
  assert.equal(result.skippedFiles, result.totalFiles - 1);
  assert.equal(result.treeTruncated, true);
  assert.ok(result.warnings.some((warning) => warning.includes('incomplete')));
});

test('obvious tokens, secret literals, credentials and private keys are redacted without moving lines', async () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const text = [
    'const publicName = "project";',
    `const key = "${token}";`,
    'const clientSecret = "super-secret-literal";',
    'password: yaml-password-value',
    'url: https://username:password@example.com/db',
    '-----BEGIN RSA PRIVATE KEY-----',
    'private-material-goes-here',
    '-----END RSA PRIVATE KEY-----',
    'export const remaining = true;',
  ].join('\n');
  mockRepository([source('src/auth/config.ts', text)]);
  const result = await new GitHubSourceClient().snapshot('current-user-token', '42');
  const file = result.files[0];
  for (const secret of [
    token,
    'super-secret-literal',
    'yaml-password-value',
    'username:password',
    'private-material',
  ])
    assert.ok(!file.content.includes(secret));
  assert.equal(file.lineCount, text.split('\n').length);
  assert.equal(file.content.split('\n')[8], 'export const remaining = true;');
  assert.ok(file.content.includes('[REDACTED]'));
  assert.ok(result.warnings.some((warning) => warning.includes('redacted')));
});

test('file count, text bytes and total context are bounded with README/auth/test spread', async () => {
  const text = 'export const value = "한글";\n'.repeat(1200);
  const sources = Array.from({ length: 40 }, (_, index) =>
    source(`src/modules/module-${index}.ts`, text)
  );
  sources.push(source('README.md', '# Readme\n'));
  sources.push(source('package.json', '{"name":"example"}\n'));
  sources.push(source('src/auth/session.ts', text));
  sources.push(source('test/session.test.ts', text));
  sources.push(source('src/main.ts', text));
  const calls = mockRepository(sources);
  const result = await new GitHubSourceClient().snapshot('current-user-token', '42');
  assert.ok(result.files.length <= 16);
  assert.ok(result.files.reduce((sum, file) => sum + file.bytes, 0) <= 120 * 1024);
  assert.ok(result.files.every((file) => file.bytes <= 12 * 1024));
  assert.ok(result.files.every((file) => file.bytes === Buffer.byteLength(file.content)));
  assert.ok(result.files.every((file) => !file.content.includes('\uFFFD')));
  for (const path of [
    'README.md',
    'package.json',
    'src/auth/session.ts',
    'test/session.test.ts',
    'src/main.ts',
  ])
    assert.ok(result.files.some((file) => file.path === path));
  assert.ok(result.files.some((file) => file.truncated));
  assert.ok(calls.length <= 3 + 32);
});

test('invalid UTF-8, NUL binary and empty files are skipped rather than forwarded', async () => {
  mockRepository([
    source('src/invalid.ts', Buffer.from([0xc3, 0x28])),
    source('src/binary.ts', Buffer.from([65, 0, 66])),
    source('src/empty.ts', ''),
    source('src/main.ts', 'valid();\n'),
  ]);
  const result = await new GitHubSourceClient().snapshot('current-user-token', '42');
  assert.deepEqual(
    result.files.map(({ path }) => path),
    ['src/main.ts']
  );
  assert.equal(result.skippedFiles, 3);
});

test('small source files still stop at sixteen files without traversing more blobs', async () => {
  const sources = Array.from({ length: 50 }, (_, index) =>
    source(`src/file-${index}.ts`, `export const value = ${index};\n`)
  );
  const calls = mockRepository(sources);
  const result = await new GitHubSourceClient().snapshot('current-user-token', '42');
  assert.equal(result.files.length, 16);
  assert.equal(calls.length, 3 + 16);
  assert.equal(result.skippedFiles, 34);
  assert.ok(result.warnings.some((warning) => warning.includes('sample')));
});

test('malformed identity, tree and blob content fail safely, including a mismatched content hash', async () => {
  const item = source('src/main.ts', 'valid();\n');
  for (const changeResponse of [
    (url) =>
      url.pathname === '/repositories/42'
        ? Response.json({ id: 42, full_name: '../evil', private: true })
        : undefined,
    (url, payload) =>
      url.pathname.includes('/git/trees/')
        ? Response.json({ ...payload, sha: 'c'.repeat(40) })
        : undefined,
    (url, payload) =>
      url.pathname.includes('/git/blobs/')
        ? Response.json({ ...payload, content: Buffer.from('evil!();\n').toString('base64') })
        : undefined,
    (url, payload) =>
      url.pathname.includes('/git/blobs/')
        ? Response.json({ ...payload, content: 'invalid-base64!!' })
        : undefined,
  ]) {
    mockRepository([item], { changeResponse });
    await assert.rejects(
      new GitHubSourceClient().snapshot('current-user-token', '42'),
      (error) => error.getStatus() === 502 && !error.message.includes('current-user-token')
    );
  }
});

test('empty repositories and repositories without supported text return controlled 422', async () => {
  mockRepository([], { metadata: { default_branch: null } });
  await assert.rejects(
    new GitHubSourceClient().snapshot('current-user-token', '42'),
    (error) => error.getStatus() === 422
  );
  mockRepository([source('image.png', 'not text source')]);
  await assert.rejects(
    new GitHubSourceClient().snapshot('current-user-token', '42'),
    (error) => error.getStatus() === 422
  );
  mockRepository([], {
    changeResponse: (url) =>
      url.pathname.includes('/commits/')
        ? new Response('private empty repo details', { status: 409 })
        : undefined,
  });
  await assert.rejects(
    new GitHubSourceClient().snapshot('current-user-token', '42'),
    (error) => error.getStatus() === 422 && !error.message.includes('private')
  );
});

test('upstream error statuses and rate limits remain sanitized; arbitrary IDs cannot select a URL', async () => {
  for (const [status, headers, expected] of [
    [401, {}, 401],
    [403, {}, 403],
    [404, {}, 404],
    [429, {}, 429],
    [403, { 'x-ratelimit-remaining': '0' }, 429],
    [500, {}, 502],
    [302, { location: 'https://evil.example' }, 502],
  ]) {
    global.fetch = async () => new Response('private upstream details', { status, headers });
    await assert.rejects(
      new GitHubSourceClient().snapshot('current-user-token', '42'),
      (error) => error.getStatus() === expected && !error.message.includes('private upstream')
    );
  }
  global.fetch = async () => assert.fail('Invalid ID must not trigger a request');
  for (const id of ['https://evil.example', '../42', '42?url=evil', '0', '9007199254740992'])
    await assert.rejects(
      new GitHubSourceClient().snapshot('current-user-token', id),
      (error) => error.getStatus() === 400
    );
});

test('caller cancellation stops fetches and oversized JSON is rejected before analysis', async () => {
  const controller = new AbortController();
  controller.abort();
  global.fetch = async () => assert.fail('Cancelled snapshot must not start');
  await assert.rejects(
    new GitHubSourceClient().snapshot('current-user-token', '42', controller.signal),
    (error) => error.getStatus() === 504
  );
  global.fetch = async () => new Response('x'.repeat(256 * 1024 + 1));
  await assert.rejects(
    new GitHubSourceClient().snapshot('current-user-token', '42'),
    (error) => error.getStatus() === 502
  );
  const active = new AbortController();
  global.fetch = async (_url, init) => {
    active.abort();
    assert.equal(init.signal.aborted, true);
    throw new Error('secret cancellation details');
  };
  await assert.rejects(
    new GitHubSourceClient().snapshot('current-user-token', '42', active.signal),
    (error) => error.getStatus() === 504 && !error.message.includes('secret')
  );
});
