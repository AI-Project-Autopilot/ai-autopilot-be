/* eslint-disable @typescript-eslint/no-require-imports -- Tests load CommonJS build output. */
require('reflect-metadata');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.AUTOPILOT_FRONTEND_URL = 'http://localhost:3000/connect/github';

// Exercise the same app factory as the production entry point, rather than
// mounting the individual routers in an otherwise unrelated Express app.
const { createApp } = require('../dist/main');
const { githubAuthService } = require('../dist/auth/github-auth.service');
const { repositoryAnalysisService } = require('../dist/analysis/repository-analysis.service');

let app;
let baseUrl;
before(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});
after(async () => {
  if (app) await app.close();
});

const request = (path, options = {}) =>
  fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options });

test('production app serves Nest health and the mounted GitHub session endpoint with CORS', async () => {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'OK');

  const response = await request('/api/auth/me', {
    headers: { Origin: 'http://localhost:3000' },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { message: 'Login required.' });
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('production app no longer exposes legacy authentication, user, or project routes', async () => {
  for (const [method, path] of [
    ['POST', '/auth/register'],
    ['POST', '/auth/login'],
    ['POST', '/auth/refresh'],
    ['GET', '/auth/google'],
    ['GET', '/users/me'],
    ['POST', '/projects'],
    ['GET', '/projects/1'],
  ]) {
    const response = await request(path, { method });
    assert.equal(response.status, 404, `${method} ${path} must be retired`);
  }
});

test('production app starts GitHub OAuth and completes it using the browser cookie', async (t) => {
  const browserToken = 'b'.repeat(43);
  const state = 's'.repeat(43);
  const previousSession = 'p'.repeat(43);
  const sessionToken = 'n'.repeat(43);
  const frontendUrl = 'http://localhost:3000/connect/github';
  const authorizationUrl = `https://github.com/login/oauth/authorize?state=${state}`;
  t.mock.method(githubAuthService, 'begin', async () => ({
    url: authorizationUrl,
    browserToken,
  }));
  const complete = t.mock.method(githubAuthService, 'complete', async (...args) => {
    assert.deepEqual(args, ['test-code', state, browserToken, previousSession]);
    return { sessionToken, expiresAt: new Date(Date.now() + 60_000), frontendUrl };
  });

  const login = await request('/api/auth/github');
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), authorizationUrl);
  const browserCookie = login.headers.get('set-cookie');
  assert.match(browserCookie, new RegExp(`^autopilot_oauth=${browserToken};`));
  assert.match(browserCookie, /Path=\/api/);
  assert.match(browserCookie, /HttpOnly/);

  const callback = await request(`/api/auth/github/callback?code=test-code&state=${state}`, {
    headers: {
      Cookie: `${browserCookie.split(';')[0]}; autopilot_session=${previousSession}`,
    },
  });
  assert.equal(complete.mock.callCount(), 1);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), frontendUrl);
  const cookies = callback.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith('autopilot_oauth=;')));
  const sessionCookie = cookies.find((cookie) => cookie.startsWith('autopilot_session='));
  assert.match(sessionCookie, new RegExp(`^autopilot_session=${sessionToken};`));
  assert.match(sessionCookie, /Path=\/api/);
  assert.match(sessionCookie, /HttpOnly/);
});

test('production app parses analysis JSON before invoking the mounted router', async (t) => {
  const sessionToken = 'a'.repeat(43);
  const result = { repository: { id: '123' }, summary: 'Test analysis' };
  const analyze = t.mock.method(
    repositoryAnalysisService,
    'analyze',
    async (token, id, goal, signal) => {
      assert.equal(token, sessionToken);
      assert.equal(id, '123');
      assert.equal(goal, 'Improve login');
      assert.ok(signal instanceof AbortSignal);
      return result;
    }
  );

  const response = await request('/api/github/repositories/123/analysis', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      Cookie: `autopilot_session=${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ goal: '  Improve login  ' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(analyze.mock.callCount(), 1);
});
