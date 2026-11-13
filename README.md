# AI Project Autopilot

**AI Project Autopilot helps developers decide what to build or improve next
in a GitHub project.** Instead of relying on generic suggestions, it analyzes
the project itself to create a practical, evidence-based action plan.

## How it works

1. Sign in with GitHub and choose a repository.
2. Optionally describe a development goal.
3. Get a project summary and prioritized recommendations based on the
   repository's documentation, configuration, source code, and tests.

Each recommendation includes a rationale, implementation steps, acceptance
criteria, and links to supporting code. The analysis also reports what it was
able to review and any limitations, so developers can judge the suggestions in
context.

## Current MVP

The MVP supports GitHub sign-in, repository selection, AI-powered repository
analysis, and saved analysis results. It provides development guidance; it
does not make code changes or run the suggested tasks.

**Planned next:** let users approve recommendations and create GitHub Issues
from them.

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
