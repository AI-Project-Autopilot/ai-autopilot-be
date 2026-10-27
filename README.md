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