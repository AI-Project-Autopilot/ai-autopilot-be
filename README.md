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