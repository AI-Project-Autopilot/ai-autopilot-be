# AI Project Autopilot Backend

The backend runs on NestJS and Express. NestJS owns the application lifecycle
and `/health`; existing Express routers, Passport authentication, middleware,
Swagger endpoints, and response formats remain in place for API compatibility.
Existing API routes do not use a global prefix.

## Requirements

- Node.js 20.x (`.nvmrc` and CI use Node 20; `package.json` requires Node 20 or
  newer)
- npm
- PostgreSQL for database-backed APIs

With [nvm](https://github.com/nvm-sh/nvm), select the repository's Node version:

```sh
nvm install
nvm use
```

## Local setup

```sh
npm ci
cp .env.example .env
```

Set `DATABASE_URL` to the PostgreSQL database URL and fill in the credentials
for the integrations used by your environment. `CORS_ORIGINS` is a
comma-separated list of allowed origins; the example includes
`http://localhost:3000` and the existing production frontend.

Generate the Prisma client and start the development server:

```sh
npm run prisma:generate
npm run dev
```

The server listens on port `5000` by default. Override it with `PORT`, then
check the dependency-free health endpoint:

```sh
curl -i http://localhost:5000/health
```

It responds with HTTP 200 and the plain-text body `OK` without connecting to
PostgreSQL or external services.

## GitHub OAuth login and repositories

GitHub authentication is implemented under `src/auth` and uses the existing
Express Passport setup. Register an **OAuth App** from GitHub's **Settings >
Developer settings > OAuth Apps** and configure these backend-only values:

```sh
PORT=4000
GITHUB_CLIENT_ID="github-oauth-app-client-id"
GITHUB_CLIENT_SECRET="github-oauth-app-client-secret"
GITHUB_CALLBACK_URL="http://localhost:3000/auth/github/callback"
AUTOPILOT_FRONTEND_URL="http://localhost:3000/connect/github"
GITHUB_TOKEN_ENCRYPTION_KEY="64-character-hex-key"
CORS_ORIGINS="http://localhost:3000"
```

Generate the encryption key with `openssl rand -hex 32` and retain that key
across restarts. The OAuth App's registered callback must exactly match
`GITHUB_CALLBACK_URL`. The frontend callback page redirects the browser, keeping
`code` and `state`, to `http://localhost:4000/api/auth/github/callback`.
`GITHUB_REDIRECT_URI` and `FRONTEND_URL` remain supported as fallback names for
the callback and frontend URL. The frontend uses
`NEXT_PUBLIC_API_BASE_URL=http://localhost:4000` and sends API requests with
`credentials: 'include'`.

Login requests the OAuth `repo` scope so the repository list can include private
repositories the user is permitted to access. GitHub's `repo` scope includes
repository write permissions, although this list endpoint only reads data.
Organization policies and SSO can further limit accessible repositories. After
switching from the previous login flow, sign in again to grant repository access.
OAuth scope details are documented in [GitHub's OAuth scope reference](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

The flow is login, return to `/connect/github`, fetch the user's repositories,
then select a repository in that screen. No GitHub App installation or App slug
is required. GitHub tokens remain encrypted on the backend; the frontend only
receives an HttpOnly session cookie and public response fields.

| Endpoint                              | Behavior                                                                |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `GET /api/auth/github`                | Start OAuth authorization with PKCE and browser-bound state             |
| `GET /api/auth/github/callback`       | Complete login, set the session cookie, and return to the FE            |
| `GET /api/auth/me`                    | Return the connected user and session expiration                        |
| `POST /api/auth/logout`               | Delete the session and clear its cookie; requires the FE Origin         |
| `GET /api/github/repositories?page=1` | Fetch a page of real repositories with the current session's user token |

The repository endpoint calls GitHub `GET /user/repos`, including owned,
collaborated, and organization repositories accessible to that token, sorted by
most recently updated. It returns `items`, `page`, `perPage` (30),
`hasNextPage` (from GitHub's Link header), and `privateRepositoriesIncluded`.
Each item contains `id`, `owner`, `name`, `fullName`, `description`,
`defaultBranch`, `isPrivate`, `htmlUrl`, `language`, `updatedAt`,
`openIssueCount`, and `archived`. GitHub does not supply a total count for this
endpoint. See [GitHub's repository list API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user).

An old or restricted token may return public repositories only; in that case
`privateRepositoriesIncluded` is false and the FE offers login again. The
endpoint returns 401 for missing or expired sessions and revoked GitHub tokens,
403 for denied access, 429 for rate limits, and 502 for GitHub outages or invalid
responses. Invalid or duplicate `page` values return 400. The former
`/api/github/installations` and `/api/github/install-url` routes are removed.

The existing `AutopilotUser`, `AutopilotSession`, and `AutopilotOAuthState` tables
are reused. This OAuth/repository change requires no additional migration. For
initial setup, reconcile existing database tables with migration history before
applying checked-in migrations; do not reset an existing database.

## Analyze a selected repository with Meta

Configure `MODEL_API_KEY` in the backend `.env`. `META_MODEL` defaults to
`muse-spark-1.3`, and `META_API_BASE_URL` defaults to `https://api.meta.ai/v1`.
The client uses Meta's [Chat Completions API](https://dev.meta.ai/docs/api-reference/chat-completions/create-chat-completion)
with structured JSON output. Keys and GitHub tokens never reach the frontend.

After selecting a repository on `/connect/github`, enter an optional development
goal and press **선택한 저장소 분석하기**. The request is:

```http
POST /api/github/repositories/1024822939/analysis
Origin: http://localhost:3000
Content-Type: application/json
```

```json
{ "goal": "로그인 오류 처리를 개선할 다음 작업을 추천해주세요." }
```

The request uses the session cookie, requires the configured frontend Origin,
and accepts a goal of at most 2,000 characters. The backend resolves repository
access with that user's GitHub token and pins the default branch to a commit.
It reads up to 16 selected README, manifest, configuration, source and test files,
with a 120 KiB total text budget. Generated files, dependencies, binary files,
environment files and credential files are excluded; detected credentials are
redacted. Coverage and truncation are reported in the response.

The response contains `analysisId`, `repository` (including `commitSha`), `generatedAt`,
`model`, `summary`, `recommendations`, and `context`. Each recommendation contains
`id`, `title`, `priority` (`high`, `medium`, or `low`), `rationale`,
`implementationSteps`, `acceptanceCriteria`, and `evidence`. Evidence includes
`path`, `startLine`, `endLine`, an excerpt from the analyzed source, and a GitHub
URL pinned to the same commit. Invented paths or line references are rejected.
The model selects server-issued code-block reference IDs; file paths, line
ranges, excerpts and URLs are resolved from the actual source by the backend.
`context.filesRead`, `totalFiles`, `skippedFiles`, `treeTruncated` and `warnings`
explain the actual analysis coverage. This is a code review, not executed tests.

Only one analysis per connected user runs at a time in each backend process.
Before source collection starts, the backend creates a `RepositoryAnalysis`
record linked to the current `AutopilotUser`. It saves the selected repository,
goal, pinned commit, model, source coverage, summary, recommendations and evidence.
The validated result is stored as JSON; full source files and authentication
tokens are not stored in this table. A successful POST response is returned only
after the database save completes. Each run transitions from `running` to
`succeeded`, `failed` or `cancelled`, with timestamps and a sanitized error code.
A forced server shutdown can leave an interrupted run as `running`.

Saved results can be retrieved without another GitHub or Meta request:

| Endpoint                               | Response                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/github/analyses?page=1`      | `{ items, page, perPage: 20, hasNextPage }`; newest first; optional `repositoryId` filter       |
| `GET /api/github/analyses/:analysisId` | Run metadata, `context`, and `result` (the original POST response on success; otherwise `null`) |

Both read APIs require the session cookie (`credentials: 'include'`), query only
the logged-in user's records, and send `Cache-Control: no-store`. A missing or
another user's analysis ID returns 404. The list excludes the full result JSON;
each item includes `id`, repository metadata, goal, status, model, summary,
timestamps and error code. FE can use `analysisId` from the POST response to
reload a saved result after navigation or refresh. Results generated before this
migration were never stored and are not automatically backfilled.

Apply `20261030000000_repository_analysis` with
`npm run prisma:migrate:deploy`, then run `npm run prisma:generate` before
starting the updated backend. This additive migration creates the analysis table,
status enum, user foreign key and query indexes without changing existing data.

Errors use the existing `{ "message": "..." }` format:
400 invalid input, 401 login required, 403 forbidden Origin/repository access,
404 missing repository, 409 analysis already running, 422 no readable source,
429 upstream request limit, 502 invalid/upstream analysis response, 503 missing
Meta configuration or model access, and 504 timeout. Client cancellation
propagates to GitHub and Meta requests. The analysis budget is 110 seconds and
the frontend waits up to 120 seconds. A database save failure returns 500 rather
than reporting an unsaved analysis as successful.

`npm test` runs the mocked GitHub/Meta and persistence tests. `npm run test:db`
also checks the configured development database using isolated fixtures inside a
rolled-back transaction; it makes no GitHub or Meta API calls.

## Build and run

```sh
npm run prisma:generate
npm run build
npm start
```

The build output is written to `dist/`. `npm run prisma:generate` only
generates the client; it does not apply schema changes. To apply the existing,
checked-in migrations to a configured database, run
`npm run prisma:migrate:deploy`. Do not reset the database as part of setup.

## Existing API compatibility

Existing API paths are mounted without a global prefix. Authentication remains
Passport JWT, with the existing Google OAuth routes:

- `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`
- `GET /users/me`, `PATCH /users/me`
- `/projects`, `/tasks`, `/subtasks`, `/comments`, `/invitations`, and `/files`

Most project and user routes require an access token; file upload retains its
existing middleware behavior. API success payloads, status codes, and the
existing `{ "message": "..." }` error response remain handled by the Express
controllers and error handler.

## CI verification

The CI build uses Node 20 and runs:

```sh
npm ci
npm run prisma:generate
npm run build
```

CI supplies a local-only placeholder `DATABASE_URL` for Prisma schema
validation; it does not connect to a database.
