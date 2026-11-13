# AI Project Autopilot

**AI Project Autopilot helps developers decide what to build or improve next
in a GitHub project.** Instead of relying on generic suggestions, it analyzes
the project itself to create a practical, evidence-based action plan.

## How it works

1. Sign in with GitHub and choose a repository.
2. Optionally describe a development goal.
3. Get a project summary and prioritized recommendations based on the
   repository's documentation, configuration, source code, and tests.
4. Select a recommendation, review its saved task draft, and create or link a
   GitHub issue. Reopen the task later to track progress and refresh issue status.

Each recommendation includes a rationale, implementation steps, acceptance
criteria, and links to supporting code. The analysis also reports what it was
able to review and any limitations, so developers can judge the suggestions in
context.

## Current MVP

The MVP supports GitHub sign-in, repository selection, AI-powered repository
analysis, saved analysis results, and persistent tracking of selected
recommendations with GitHub issue links. It provides development guidance; it
does not make code changes or run the suggested tasks.

## Built with Meta

Meta Model API, powered by **Muse Spark 1.3**, analyzes a bounded snapshot of
the selected repository together with the user's optional goal. It generates
structured summaries and recommendations, while the backend checks each code
reference against the source actually analyzed. This helps keep suggestions
specific to the project and their supporting evidence verifiable.

Meta API credentials stay on the backend and are never exposed to the browser.
The NestJS backend provides the API and analysis workflow; the Next.js frontend
handles repository selection and result display.

## Analysis language

The frontend can select the language when creating an analysis:

```http
POST /api/github/repositories/:repositoryId/analysis
Content-Type: application/json

{
  "goal": "Improve login reliability",
  "language": "en"
}
```

`goal` and `language` are optional. `language` accepts `"ko"` (Korean) or `"en"`
(English), and defaults to `"ko"` when omitted. Other values, including `null`,
return HTTP 400. The existing session cookie and frontend Origin header are
required.

The selected language applies to the AI-generated summary, recommendation titles,
rationales, implementation steps, and acceptance criteria, even when the goal or
repository content uses another language. JSON keys, priority values
(`high`, `medium`, `low`), and source evidence remain unchanged.

The response includes `language`, which is also saved with the analysis result
and returned as `result.language` when fetching a saved analysis through
`GET /api/github/analyses/:analysisId`. Older saved results may omit this field
and can be treated as Korean. Changing the frontend language does not translate
existing saved results; create a new analysis with the desired language.

## Selected tasks and GitHub issues

Selecting a recommendation saves an owner-scoped task derived from a successful
saved analysis. Selecting the same recommendation again opens the existing task
and preserves edits. The draft includes the goal, rationale, implementation steps,
acceptance criteria, and links to code at the analyzed commit. Review and edit
the title and Markdown body before explicitly creating an issue.

| Method | Endpoint under `/api/github` | Purpose |
| --- | --- | --- |
| POST | `/analyses/:analysisId/tasks` | Select `{ "recommendationId": "task-1" }` |
| GET | `/tasks` | List tasks; optional `repositoryId`, `analysisId`, and `page` filters |
| GET | `/tasks/:taskId` | Reopen a saved task |
| PATCH | `/tasks/:taskId` | Save `title`, `body`, or `status` changes |
| POST | `/tasks/:taskId/issue` | Create an issue from the saved draft or reconcile a pending creation |
| POST | `/tasks/:taskId/issue/sync` | Refresh the linked GitHub issue state |
| POST | `/tasks/:taskId/issue/link` | Link an existing issue using `{ "issueNumber": 123 }` |

Requests require the current session cookie; mutations also require the trusted
frontend Origin header. Titles are limited to 200 characters and bodies to 30,000
characters. Content editing is locked once issue creation starts; task status can
still be updated after linking. The existing GitHub OAuth `repo` authorization
is used, and the repository must allow issues and the account must have access.

Task states are `selected`, `in_progress`, `completed`, and `cancelled`. Refreshing
a closed issue marks the task completed, or cancelled when GitHub reports
`not_planned`. A reopened issue returns the task to `in_progress`. These states
track the work and GitHub issue lifecycle; they are not proof that the code or
tests satisfy the acceptance criteria.

Issue creation uses a persisted claim and a server-generated task marker to avoid
duplicate writes. If GitHub times out or the response cannot be confirmed, the
task stays pending/uncertain. Subsequent attempts search for the existing marker
instead of sending another create request. If necessary, link the known existing
issue number. Changing a task's status does not edit or close the GitHub issue.

## Database

The current application uses five PostgreSQL tables:

- `AutopilotUser`: GitHub accounts.
- `AutopilotSession`: encrypted GitHub credentials and browser sessions.
- `AutopilotOAuthState`: browser-bound login state and PKCE verifiers.
- `RepositoryAnalysis`: submitted goals, analysis status, and saved results.
- `TrackedTask`: selected recommendation drafts, progress, and GitHub issue links.

Prisma also maintains `_prisma_migrations` for migration history. Set
`DATABASE_URL`, then prepare the client and apply pending migrations:

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
```

Migration `20261113000000_remove_legacy_tables` removes the retired project
management tables (`Users`, `Tokens`, `Projects`, `Invitations`,
`Project_members`, `Tasks`, `Task_tags`, `Tags`, `Subtasks`, `Comments`, and
`Task_files`) and their two enums. Back up the target database before applying
this migration in another environment. The migration runs in a transaction
without `CASCADE`, so unexpected dependencies stop the cleanup. Applied migration
files remain in version control so a new database can reproduce the schema.

The old `/auth`, `/users`, and `/projects` APIs and demo seed were retired with
these tables. Current authentication remains under `/api/auth`, and repository
analysis remains under `/api/github`. Accounts are created by GitHub sign-in.
Local database backups belong in the Git-ignored `.local-backups/` directory.

Run the optional database integration checks against a local development database:

```bash
npm run test:db
```

These checks roll back their fixtures, including an isolated-schema test of the
legacy cleanup migration and preservation of the current application's data.
