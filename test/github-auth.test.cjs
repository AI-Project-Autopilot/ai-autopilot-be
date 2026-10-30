require('reflect-metadata');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Passport } = require('passport');
// The router imports the existing JWT registration; this suite never uses its credentials.
process.env.JWT_ACCESS_TOKEN_SECRET = 'test-only-access-secret';
process.env.JWT_REFRESH_TOKEN_SECRET = 'test-only-refresh-secret';
const { GitHubAuthService } = require('../dist/auth/github-auth.service');
const { GitHubClient } = require('../dist/auth/github.client');
const { GitHubStrategy } = require('../dist/auth/strategies/github.strategy');
const { createGitHubAuthRouter } = require('../dist/auth/github-auth.route');
const { errorHandler } = require('../dist/common/filters/error-handler');
const { encrypt, decrypt, hashToken, challenge } = require('../dist/auth/github-security');
const prisma = require('../dist/prisma/prisma.service').default;
const originalFetch = global.fetch;
let restore = [];
function stub(target, key, value) {
  const old = target[key];
  target[key] = value;
  restore.push(() => (target[key] = old));
}
function unsetEnv(key) {
  const old = process.env[key];
  delete process.env[key];
  restore.push(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}
beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.GITHUB_CLIENT_ID = 'test-client';
  process.env.GITHUB_CLIENT_SECRET = 'test-secret';
  process.env.GITHUB_CALLBACK_URL = 'http://localhost:4000/api/auth/github/callback';
  process.env.AUTOPILOT_FRONTEND_URL = 'http://localhost:3000/connect/github';
  process.env.GITHUB_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
});
afterEach(() => {
  restore.reverse().forEach((fn) => fn());
  restore = [];
  global.fetch = originalFetch;
});
test('tokens encrypt with independent IVs and reject tampering', () => {
  const a = encrypt('secret');
  const b = encrypt('secret');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'secret');
  const parts = a.split('.');
  const tag = Buffer.from(parts[1], 'base64url');
  tag[0] ^= 1;
  parts[1] = tag.toString('base64url');
  assert.throws(() => decrypt(parts.join('.')));
});
test('OAuth App login requests private repo scope with PKCE and encrypted browser-bound state', async () => {
  unsetEnv('GITHUB_APP_SLUG');
  let data;
  stub(prisma.autopilotOAuthState, 'create', async (input) => {
    data = input.data;
  });
  const result = await new GitHubAuthService({}).begin();
  const url = new URL(result.url);
  assert.equal(data.stateHash, hashToken(url.searchParams.get('state')));
  assert.equal(data.browserHash, hashToken(result.browserToken));
  assert.equal(url.searchParams.get('code_challenge'), challenge(decrypt(data.verifierEncrypted)));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'repo');
});
test('legacy callback and frontend environment names remain compatible', () => {
  unsetEnv('GITHUB_CALLBACK_URL');
  unsetEnv('AUTOPILOT_FRONTEND_URL');
  stub(process.env, 'GITHUB_REDIRECT_URI', 'http://localhost:3000/auth/github/callback');
  stub(process.env, 'FRONTEND_URL', 'http://localhost:3000/connect/github');
  const config = new GitHubAuthService({}).configuration();
  assert.equal(config.redirectUri, process.env.GITHUB_REDIRECT_URI);
  assert.equal(config.frontendUrl, process.env.FRONTEND_URL);
});
test('wrong browser binding cannot consume state or exchange a code', async () => {
  stub(prisma.autopilotOAuthState, 'findUnique', async () => ({
    browserHash: hashToken('correct'),
    expiresAt: new Date(Date.now() + 10000),
  }));
  const service = new GitHubAuthService({ exchange: () => assert.fail('exchange called') });
  await assert.rejects(service.complete('code', 'state', 'wrong'), /Invalid or expired/);
});
test('expired state is rejected before token exchange', async () => {
  stub(prisma.autopilotOAuthState, 'findUnique', async () => ({
    browserHash: hashToken('browser'),
    expiresAt: new Date(0),
  }));
  await assert.rejects(
    new GitHubAuthService({}).complete('code', 'state', 'browser'),
    /Invalid or expired/
  );
});
test('atomic state consumption prevents replay', async () => {
  stub(prisma.autopilotOAuthState, 'findUnique', async () => ({
    browserHash: hashToken('browser'),
    expiresAt: new Date(Date.now() + 10000),
  }));
  stub(prisma.autopilotOAuthState, 'deleteMany', async () => ({ count: 0 }));
  await assert.rejects(
    new GitHubAuthService({}).complete('code', 'state', 'browser'),
    /already used/
  );
});
test('callback rotates session, stores encrypted token and tolerates private email', async () => {
  stub(prisma.autopilotOAuthState, 'findUnique', async () => ({
    browserHash: hashToken('browser'),
    expiresAt: new Date(Date.now() + 10000),
    verifierEncrypted: encrypt('verifier'),
  }));
  stub(prisma.autopilotOAuthState, 'deleteMany', async () => ({ count: 1 }));
  let saved;
  let removed;
  let identity;
  stub(prisma, '$transaction', async (fn) =>
    fn({
      autopilotUser: {
        upsert: async (input) => {
          identity = input;
          return { id: 'user' };
        },
      },
      autopilotSession: {
        deleteMany: async (input) => {
          removed = input;
        },
        create: async (input) => {
          saved = input.data;
        },
      },
    })
  );
  const service = new GitHubAuthService({
    exchange: async () => ({ accessToken: 'secret-token', expiresIn: 60 }),
    profile: async () => ({ id: 42, login: 'octo', name: null, avatarUrl: 'avatar' }),
  });
  const result = await service.complete('code', 'state', 'browser', 'old-session');
  assert.deepEqual(identity.where, { githubId: '42' });
  assert.equal(saved.tokenHash, hashToken(result.sessionToken));
  assert.equal(decrypt(saved.githubTokenEncrypted), 'secret-token');
  assert.equal(removed.where.tokenHash, hashToken('old-session'));
  assert.ok(result.expiresAt.getTime() <= Date.now() + 60000);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
test('expired sessions cannot read identity', async () => {
  stub(prisma.autopilotSession, 'findUnique', async () => ({ expiresAt: new Date(0) }));
  await assert.rejects(new GitHubAuthService({}).me('a'.repeat(43)), /Session expired/);
});
test('me returns only public user and session expiration', async () => {
  const service = new GitHubAuthService({});
  service.session = async () => ({
    user: { id: 'u', githubId: '42', login: 'octo', name: null, avatarUrl: 'url' },
    expiresAt: new Date(),
    githubTokenEncrypted: 'SECRET',
    tokenHash: 'HASH',
  });
  const result = await service.me('token');
  assert.equal(result.user.githubId, '42');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('repository service decrypts only the active session token and preserves pagination metadata', async () => {
  const service = new GitHubAuthService({
    repositories: async (token, page) => {
      assert.equal(token, 'user-token');
      assert.equal(page, 2);
      return { items: [], hasNextPage: true, privateRepositoriesIncluded: true };
    },
  });
  service.session = async (token) => {
    assert.equal(token, 'session');
    return { githubTokenEncrypted: encrypt('user-token') };
  };
  assert.deepEqual(await service.repositories('session', 2), {
    items: [],
    page: 2,
    perPage: 30,
    hasNextPage: true,
    privateRepositoriesIncluded: true,
  });
});
test('revoked GitHub tokens require reconnection', async () => {
  global.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(new GitHubClient().profile('secret'), /Reconnect/);
});

function memoryPersistence() {
  const states = new Map();
  const users = new Map();
  const sessions = new Map();
  stub(prisma.autopilotOAuthState, 'create', async ({ data }) => {
    states.set(data.stateHash, data);
    return data;
  });
  stub(prisma.autopilotOAuthState, 'findUnique', async ({ where }) => states.get(where.stateHash));
  stub(prisma.autopilotOAuthState, 'deleteMany', async ({ where }) => {
    const record = states.get(where.stateHash);
    const matches =
      record && record.browserHash === where.browserHash && record.expiresAt > where.expiresAt.gt;
    if (matches) states.delete(where.stateHash);
    return { count: matches ? 1 : 0 };
  });
  const removeSessions = async ({ where }) => ({ count: sessions.delete(where.tokenHash) ? 1 : 0 });
  stub(prisma.autopilotSession, 'deleteMany', removeSessions);
  stub(prisma.autopilotSession, 'findUnique', async ({ where }) => {
    const record = sessions.get(where.tokenHash);
    return record && { ...record, user: [...users.values()].find((u) => u.id === record.userId) };
  });
  // These fakes verify application state transitions; they do not emulate DB transactions.
  stub(prisma, '$transaction', async (fn) =>
    fn({
      autopilotUser: {
        upsert: async ({ where, create, update }) => {
          const existing = users.get(where.githubId);
          const user = existing
            ? { ...existing, ...update }
            : { id: `user-${users.size + 1}`, ...create };
          users.set(where.githubId, user);
          return user;
        },
      },
      autopilotSession: {
        deleteMany: removeSessions,
        create: async ({ data }) => {
          sessions.set(data.tokenHash, data);
          return data;
        },
      },
    })
  );
  return { states, users, sessions };
}

async function withServer(service, run) {
  const authenticator = new Passport();
  authenticator.use('github', new GitHubStrategy(service));
  const app = express();
  app.use(cookieParser());
  app.use(authenticator.initialize());
  app.use('/api', createGitHubAuthRouter(service, authenticator));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) =>
    originalFetch(`${base}${path}`, { redirect: 'manual', ...options });
  try {
    await run(request);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function responseCookie(response, name) {
  const line = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(line, `Expected ${name} cookie`);
  return { line, pair: line.split(';', 1)[0], value: line.split(';', 1)[0].slice(name.length + 1) };
}

function assertPrivateCookie(line, secure = false) {
  assert.match(line, /; Path=\/api(?:;|$)/i);
  assert.match(line, /; HttpOnly(?:;|$)/i);
  assert.match(line, /; SameSite=Lax(?:;|$)/i);
  assert.equal(/; Secure(?:;|$)/i.test(line), secure);
}

async function startLogin(request) {
  const response = await request('/api/auth/github?redirect_uri=https://evil.example');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const authorizeUrl = new URL(response.headers.get('location'));
  assert.equal(authorizeUrl.origin, 'https://github.com');
  assert.equal(authorizeUrl.pathname, '/login/oauth/authorize');
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), process.env.GITHUB_CALLBACK_URL);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizeUrl.searchParams.get('scope'), 'repo');
  assert.ok(authorizeUrl.searchParams.get('code_challenge'));
  const browserCookie = responseCookie(response, 'autopilot_oauth');
  assertPrivateCookie(browserCookie.line);
  assert.match(browserCookie.value, /^[A-Za-z0-9_-]{43}$/);
  return { state: authorizeUrl.searchParams.get('state'), browserCookie };
}

function repository(id = '123', overrides = {}) {
  return {
    id,
    owner: 'octo',
    name: `repository-${id}`,
    fullName: `octo/repository-${id}`,
    description: null,
    defaultBranch: 'main',
    isPrivate: true,
    htmlUrl: `https://github.com/octo/repository-${id}`,
    language: null,
    updatedAt: '2026-10-30T01:00:00Z',
    openIssueCount: 0,
    archived: false,
    ...overrides,
  };
}

function loginService() {
  const calls = { exchange: 0, repositories: [] };
  const service = new GitHubAuthService({
    exchange: async (code, verifier, clientId, clientSecret, redirectUri) => {
      calls.exchange++;
      assert.equal(code, 'valid-code');
      assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(clientId, 'test-client');
      assert.equal(clientSecret, 'test-secret');
      assert.equal(redirectUri, process.env.GITHUB_CALLBACK_URL);
      return { accessToken: 'private-github-token', expiresIn: 28800 };
    },
    // A real GitHub ID identifies the user even with no email or personal name.
    profile: async () => ({
      id: 42,
      login: 'octo',
      name: null,
      avatarUrl: 'https://avatars.example/u',
    }),
    repositories: async (token, page) => {
      calls.repositories.push({ token, page });
      assert.equal(token, 'private-github-token');
      assert.ok(page === 1 || page === 2);
      return {
        items: [repository(page === 1 ? '123' : '456')],
        hasNextPage: page === 1,
        privateRepositoriesIncluded: true,
      };
    },
  });
  return { service, calls };
}

test('OAuth login lists private repositories across pages then rotates and revokes the session', async () => {
  const db = memoryPersistence();
  const { service, calls } = loginService();
  await withServer(service, async (request) => {
    for (const path of ['/api/auth/me', '/api/github/repositories']) {
      assert.equal((await request(path)).status, 401);
    }
    const { state, browserCookie } = await startLogin(request);
    assert.equal(db.states.size, 1);
    const callback = await request(`/api/auth/github/callback?code=valid-code&state=${state}`, {
      headers: { Cookie: browserCookie.pair },
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), process.env.AUTOPILOT_FRONTEND_URL);
    assert.equal(callback.headers.get('cache-control'), 'no-store');
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    const active = responseCookie(callback, 'autopilot_session');
    assertPrivateCookie(active.line);
    assert.match(active.value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(responseCookie(callback, 'autopilot_oauth').value, '');
    assert.equal(db.states.size, 0);
    assert.equal(db.sessions.size, 1);
    const stored = db.sessions.get(hashToken(active.value));
    assert.ok(stored);
    assert.equal(decrypt(stored.githubTokenEncrypted), 'private-github-token');
    assert.ok(!JSON.stringify([...db.sessions.values()]).includes(active.value));
    const authenticated = { headers: { Cookie: active.pair } };
    const me = await request('/api/auth/me', authenticated);
    assert.equal(me.status, 200);
    const identity = await me.json();
    assert.equal(identity.user.githubId, '42');
    assert.equal(identity.user.login, 'octo');
    assert.equal(identity.user.name, null);
    assert.ok(identity.expiresAt);
    assert.deepEqual(Object.keys(identity).sort(), ['expiresAt', 'user']);
    assert.ok(!JSON.stringify(identity).includes('private-github-token'));
    assert.ok(!JSON.stringify(identity).includes('tokenHash'));
    const first = await request('/api/github/repositories', authenticated);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await first.json(), {
      items: [repository('123')],
      page: 1,
      perPage: 30,
      hasNextPage: true,
      privateRepositoriesIncluded: true,
    });
    const next = await request('/api/github/repositories?page=2', authenticated);
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), {
      items: [repository('456')],
      page: 2,
      perPage: 30,
      hasNextPage: false,
      privateRepositoriesIncluded: true,
    });
    assert.deepEqual(calls.repositories, [
      { token: 'private-github-token', page: 1 },
      { token: 'private-github-token', page: 2 },
    ]);
    // Removing the installation flow also removes these API contracts.
    assert.equal((await request('/api/github/installations', authenticated)).status, 404);
    assert.equal((await request('/api/github/install-url', authenticated)).status, 404);

    const second = await startLogin(request);
    const relogin = await request(
      `/api/auth/github/callback?code=valid-code&state=${second.state}`,
      {
        headers: { Cookie: `${second.browserCookie.pair}; ${active.pair}` },
      }
    );
    assert.equal(relogin.status, 302);
    const rotated = responseCookie(relogin, 'autopilot_session');
    assert.notEqual(rotated.value, active.value);
    assert.equal(db.sessions.size, 1);
    assert.equal((await request('/api/auth/me', authenticated)).status, 401);
    const rotatedHeaders = { Cookie: rotated.pair };
    assert.equal((await request('/api/auth/me', { headers: rotatedHeaders })).status, 200);
    const forbidden = await request('/api/auth/logout', {
      method: 'POST',
      headers: { ...rotatedHeaders, Origin: 'https://evil.example' },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(db.sessions.size, 1);
    const loggedOut = await request('/api/auth/logout', {
      method: 'POST',
      headers: { ...rotatedHeaders, Origin: 'http://localhost:3000' },
    });
    assert.equal(loggedOut.status, 204);
    assert.equal(await loggedOut.text(), '');
    const cleared = responseCookie(loggedOut, 'autopilot_session');
    assertPrivateCookie(cleared.line);
    assert.equal(cleared.value, '');
    assert.equal(db.sessions.size, 0);
    assert.equal((await request('/api/auth/me', { headers: rotatedHeaders })).status, 401);
    assert.equal(
      (await request('/api/github/repositories', { headers: rotatedHeaders })).status,
      401
    );
  });
});

test('HTTP callbacks reject wrong browser and consumed state without exchanging another token', async () => {
  memoryPersistence();
  const { service, calls } = loginService();
  await withServer(service, async (request) => {
    const { state, browserCookie } = await startLogin(request);
    const callbackPath = `/api/auth/github/callback?code=valid-code&state=${state}`;
    const wrongBrowser = await request(callbackPath, {
      headers: { Cookie: `autopilot_oauth=${'x'.repeat(43)}` },
    });
    assert.equal(wrongBrowser.status, 302);
    assert.equal(
      new URL(wrongBrowser.headers.get('location')).searchParams.get('error'),
      'github_auth_failed'
    );
    assert.equal(calls.exchange, 0);
    const valid = await request(callbackPath, { headers: { Cookie: browserCookie.pair } });
    assert.equal(valid.headers.get('location'), process.env.AUTOPILOT_FRONTEND_URL);
    assert.equal(calls.exchange, 1);
    const replay = await request(callbackPath, { headers: { Cookie: browserCookie.pair } });
    assert.equal(replay.status, 302);
    assert.equal(
      new URL(replay.headers.get('location')).searchParams.get('error'),
      'github_auth_failed'
    );
    assert.equal(calls.exchange, 1);
    assert.ok(!replay.headers.getSetCookie().some((line) => line.startsWith('autopilot_session=')));
  });
});

test('cancellation returns only a fixed error to the trusted FE connection path', async () => {
  let completed = false;
  await withServer(
    {
      frontendUrl: () => process.env.AUTOPILOT_FRONTEND_URL,
      complete: async () => {
        completed = true;
        assert.fail('Cancelled login must not exchange a code');
      },
    },
    async (request) => {
      const response = await request(
        '/api/auth/github/callback?error=access_denied&error_description=secret&redirect_uri=https://evil.example&code=private-code'
      );
      assert.equal(response.status, 302);
      const target = new URL(response.headers.get('location'));
      assert.equal(target.origin, 'http://localhost:3000');
      assert.equal(target.pathname, '/connect/github');
      assert.deepEqual([...target.searchParams], [['error', 'github_login_cancelled']]);
      assert.equal(responseCookie(response, 'autopilot_oauth').value, '');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.ok(!response.headers.get('location').includes('private-code'));
      assert.equal(completed, false);
    }
  );
});

test('callback failures return a fixed error code without exposing provider or internal messages', async () => {
  const { ForbiddenException, BadGatewayException } = require('@nestjs/common');
  for (const [failure, expected] of [
    [new ForbiddenException('private upstream denial'), 'github_access_denied'],
    [new BadGatewayException('private upstream outage'), 'github_auth_failed'],
    [new Error('private internal database credential'), 'github_auth_failed'],
  ]) {
    await withServer(
      {
        frontendUrl: () => `${process.env.AUTOPILOT_FRONTEND_URL}?from=setup`,
        complete: async () => {
          throw failure;
        },
      },
      async (request) => {
        const response = await request(
          `/api/auth/github/callback?code=valid-code&state=${'s'.repeat(43)}`,
          {
            headers: { Cookie: `autopilot_oauth=${'b'.repeat(43)}` },
          }
        );
        assert.equal(response.status, 302);
        const location = response.headers.get('location');
        const target = new URL(location);
        assert.equal(target.pathname, '/connect/github');
        assert.deepEqual(
          [...target.searchParams],
          [
            ['from', 'setup'],
            ['error', expected],
          ]
        );
        assert.ok(!location.includes('private'));
        assert.ok(
          !response.headers.getSetCookie().some((line) => line.startsWith('autopilot_session='))
        );
      }
    );
  }
});

test('malformed callbacks and pagination fail before invoking protected operations', async () => {
  let completed = 0;
  let requested = 0;
  await withServer(
    {
      frontendUrl: () => process.env.AUTOPILOT_FRONTEND_URL,
      complete: async () => {
        completed++;
        assert.fail('Malformed callback reached exchange');
      },
      repositories: async () => {
        requested++;
        assert.fail('Invalid pagination reached service');
      },
    },
    async (request) => {
      for (const [query, browserCookie] of [
        ['code=c&state=short', `autopilot_oauth=${'b'.repeat(43)}`],
        [`code=c&state=${'s'.repeat(43)}`, ''],
        [`code=c&code=duplicate&state=${'s'.repeat(43)}`, `autopilot_oauth=${'b'.repeat(43)}`],
        [`code=c&state=${'s'.repeat(43)}&state=duplicate`, `autopilot_oauth=${'b'.repeat(43)}`],
        [`code=${'c'.repeat(1025)}&state=${'s'.repeat(43)}`, `autopilot_oauth=${'b'.repeat(43)}`],
      ]) {
        const response = await request(`/api/auth/github/callback?${query}`, {
          headers: { Cookie: browserCookie },
        });
        assert.equal(response.status, 302);
        assert.equal(
          new URL(response.headers.get('location')).searchParams.get('error'),
          'github_auth_failed'
        );
      }
      for (const page of ['0', '-1', '1.5', '1000000', '1&page=2']) {
        assert.equal((await request(`/api/github/repositories?page=${page}`)).status, 400);
      }
      assert.equal(completed, 0);
      assert.equal(requested, 0);
    }
  );
});

test('session expiration blocks HTTP identity and private repository access', async () => {
  const db = memoryPersistence();
  const { service, calls } = loginService();
  const session = 's'.repeat(43);
  db.sessions.set(hashToken(session), {
    tokenHash: hashToken(session),
    userId: 'expired-user',
    githubTokenEncrypted: encrypt('private-github-token'),
    expiresAt: new Date(0),
  });
  await withServer(service, async (request) => {
    for (const path of ['/api/auth/me', '/api/github/repositories']) {
      assert.equal(
        (await request(path, { headers: { Cookie: `autopilot_session=${session}` } })).status,
        401
      );
    }
    assert.equal(calls.repositories.length, 0);
  });
});

function rawRepository(overrides = {}) {
  return {
    id: 123,
    owner: { login: 'octo' },
    name: 'repository-123',
    full_name: 'octo/repository-123',
    description: null,
    default_branch: 'main',
    private: true,
    html_url: 'https://github.com/octo/repository-123',
    language: null,
    updated_at: '2026-10-30T01:00:00Z',
    open_issues_count: 0,
    archived: false,
    ...overrides,
  };
}

test('GitHub client requests all accessible repositories and maps array responses without losing nulls', async () => {
  let requested = 0;
  global.fetch = async (input, init) => {
    requested++;
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/user/repos');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      per_page: '30',
      page: '2',
      sort: 'updated',
      direction: 'desc',
      affiliation: 'owner,collaborator,organization_member',
      visibility: 'all',
    });
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer active-session-github-token');
    assert.equal(headers.get('accept'), 'application/vnd.github+json');
    assert.equal(init.redirect, 'error');
    return Response.json(
      [
        rawRepository({ ignored_internal_field: 'not-for-browser' }),
        rawRepository({
          id: 456,
          name: 'public-project',
          full_name: 'octo/public-project',
          private: false,
          description: 'A public project',
          language: 'TypeScript',
          html_url: 'https://github.com/octo/public-project',
          open_issues_count: 3,
          archived: true,
        }),
      ],
      {
        headers: {
          link: '<https://api.github.com/user/repos?page=3>; rel="next", <https://api.github.com/user/repos?page=8>; rel="last"',
          'x-oauth-scopes': 'read:user, repo',
        },
      }
    );
  };
  const result = await new GitHubClient().repositories('active-session-github-token', 2);
  assert.deepEqual(result, {
    items: [
      repository(),
      repository('456', {
        name: 'public-project',
        fullName: 'octo/public-project',
        isPrivate: false,
        description: 'A public project',
        language: 'TypeScript',
        htmlUrl: 'https://github.com/octo/public-project',
        openIssueCount: 3,
        archived: true,
      }),
    ],
    hasNextPage: true,
    privateRepositoriesIncluded: true,
  });
  assert.equal(requested, 1, 'Pagination metadata must not trigger another upstream request');
});

test('a full final page is complete without a next Link and public_repo is not private access', async () => {
  for (const link of [
    undefined,
    '<https://api.github.com/user/repos?page=1>; rel="prev", <https://api.github.com/user/repos?page=2>; rel="last"',
  ]) {
    const headers = { 'x-oauth-scopes': 'read:user, public_repo' };
    if (link) headers.link = link;
    global.fetch = async () =>
      Response.json(
        Array.from({ length: 30 }, (_, index) => rawRepository({ id: index + 1, private: false })),
        { headers }
      );
    const result = await new GitHubClient().repositories('token', 2);
    assert.equal(result.items.length, 30);
    assert.equal(result.hasNextPage, false);
    assert.equal(result.privateRepositoriesIncluded, false);
  }
  global.fetch = async () => Response.json([]);
  assert.equal(
    (await new GitHubClient().repositories('token', 1)).privateRepositoriesIncluded,
    false
  );
});

test('simultaneous sessions list only repositories returned for each stored GitHub token', async () => {
  const db = memoryPersistence();
  const service = new GitHubAuthService(new GitHubClient());
  for (const [sessionToken, githubToken, userId, githubId] of [
    ['a'.repeat(43), 'github-token-alpha', 'user-alpha', '101'],
    ['b'.repeat(43), 'github-token-beta', 'user-beta', '202'],
  ]) {
    db.users.set(githubId, {
      id: userId,
      githubId,
      login: userId,
      name: null,
      avatarUrl: 'avatar',
    });
    db.sessions.set(hashToken(sessionToken), {
      tokenHash: hashToken(sessionToken),
      userId,
      githubTokenEncrypted: encrypt(githubToken),
      expiresAt: new Date(Date.now() + 60000),
    });
  }
  const seen = [];
  global.fetch = async (input, init) => {
    assert.equal(new URL(input).pathname, '/user/repos');
    await new Promise((resolve) => setImmediate(resolve));
    const authorization = new Headers(init.headers).get('authorization');
    seen.push(authorization);
    const id = authorization === 'Bearer github-token-alpha' ? 101 : 202;
    assert.ok(['Bearer github-token-alpha', 'Bearer github-token-beta'].includes(authorization));
    return Response.json(
      [rawRepository({ id, name: `private-${id}`, full_name: `octo/private-${id}` })],
      {
        headers: { 'x-oauth-scopes': 'repo' },
      }
    );
  };
  await withServer(service, async (request) => {
    const [alpha, beta] = await Promise.all([
      request('/api/github/repositories?token=github-token-beta&userId=user-beta', {
        headers: { Cookie: `autopilot_session=${'a'.repeat(43)}` },
      }),
      request('/api/github/repositories', {
        headers: { Cookie: `autopilot_session=${'b'.repeat(43)}` },
      }),
    ]);
    assert.equal(alpha.status, 200);
    assert.equal(beta.status, 200);
    const [alphaBody, betaBody] = await Promise.all([alpha.json(), beta.json()]);
    assert.equal(alphaBody.items[0].id, '101');
    assert.equal(betaBody.items[0].id, '202');
    assert.ok(!JSON.stringify([alphaBody, betaBody]).includes('github-token'));
    assert.deepEqual(seen.sort(), ['Bearer github-token-alpha', 'Bearer github-token-beta']);
  });
});

test('repository API preserves revoked, denied, rate limit and gateway statuses without exposing upstream text', async () => {
  const db = memoryPersistence();
  const sessionToken = 's'.repeat(43);
  db.sessions.set(hashToken(sessionToken), {
    tokenHash: hashToken(sessionToken),
    userId: 'user',
    githubTokenEncrypted: encrypt('private-token'),
    expiresAt: new Date(Date.now() + 60000),
  });
  const service = new GitHubAuthService(new GitHubClient());
  await withServer(service, async (request) => {
    for (const [status, headers, expected] of [
      [401, {}, 401],
      [403, {}, 403],
      [429, {}, 429],
      [403, { 'x-ratelimit-remaining': '0' }, 429],
      [403, { 'retry-after': '60' }, 429],
      [503, {}, 502],
    ]) {
      global.fetch = async () =>
        new Response('private upstream details private-token', { status, headers });
      const response = await request('/api/github/repositories', {
        headers: { Cookie: `autopilot_session=${sessionToken}` },
      });
      assert.equal(response.status, expected);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      assert.ok(!body.includes('private upstream'));
      assert.ok(!body.includes('private-token'));
    }
  });
});

test('malformed repository and OAuth token payloads are sanitized as gateway failures', async () => {
  for (const payload of [
    null,
    {},
    { items: [] },
    [null],
    [{}],
    [rawRepository({ id: -1 })],
    [rawRepository({ private: 'true' })],
    [rawRepository({ owner: null })],
    [rawRepository({ html_url: 'javascript:alert(1)' })],
    [rawRepository({ updated_at: 'not-a-date' })],
    [rawRepository({ open_issues_count: -1 })],
  ]) {
    global.fetch = async () => Response.json(payload);
    await assert.rejects(
      new GitHubClient().repositories('private-token', 1),
      (error) => error.getStatus() === 502 && !error.message.includes('private-token')
    );
  }
  global.fetch = async () => new Response('private broken JSON');
  await assert.rejects(
    new GitHubClient().repositories('private-token', 1),
    (error) => error.getStatus() === 502
  );
  global.fetch = async () => {
    throw new Error('private network details');
  };
  await assert.rejects(
    new GitHubClient().repositories('private-token', 1),
    (error) => error.getStatus() === 502 && !error.message.includes('private network')
  );
  global.fetch = async () => Response.json({ access_token: 'private-token', token_type: {} });
  await assert.rejects(
    new GitHubClient().exchange('code', 'verifier', 'id', 'secret', 'http://localhost/callback'),
    (error) => error.getStatus() === 502 && !error.message.includes('private-token')
  );
});
