# ai-workflow-builder

> Turn a single natural-language prompt into a fully-tested, MIT-licensed multi-agent AI workflow — and push it to GitHub. Ambiguity is resolved up front by an interactive **Grill-Me** spec loop, not discovered later in production.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![CI](https://img.shields.io/badge/CI-ruff%20%7C%20black%20%7C%20mypy%20%7C%20pytest-informational.svg)](#)

---

## Why this exists

Building multi-agent AI pipelines today means one of two bad options: write brittle glue code by hand, or write an exhaustive spec up front before you know what you need. Ambiguous prompts get silently mis-interpreted and fail in production; on-call load and SLA breaches follow.

`ai-workflow-builder` closes that gap. You give it **one plain-language prompt**. It interrogates you (the "Grill-Me" loop) only about the parts that are genuinely ambiguous — which agents are needed, what tools they may call, latency and cost budgets — resolves those into a versioned spec, generates vetted code, runs the full reliability suite against it, and pushes the result to a GitHub repository.

## The 30-second version

```bash
pip install ai-workflow-builder            # or: pipx install ai-workflow-builder
export OPENAI_API_KEY=sk-...               # or ANTHROPIC_API_KEY / GEMINI_API_KEY
export GITHUB_TOKEN=ghp_...                # needed only to publish

awb build "Summarize a URL, translate it to Traditional Chinese, and post to Slack"
```

The CLI streams the Grill-Me questions to your terminal, applies your answers, generates the workflow, tests it, and (with `--publish`) opens a repo. Prefer HTTP? The same capability is exposed as a FastAPI service — see the [API Reference](docs/api-reference.md).

## Documentation

| Guide | Read it when you want to… |
|-------|---------------------------|
| **[Usage Guide](docs/usage-guide.md)** | Install the tool and build your first workflow, CLI + HTTP, end to end. |
| **[API Reference](docs/api-reference.md)** | Call the REST API directly, with every endpoint, request/response, and error code. |
| **[Deployment Guide](docs/deployment-guide.md)** | Run the service in Docker, configure it for production, and operate it reliably. |
| **[Contributing](docs/CONTRIBUTING.md)** | Set up a dev environment and land a change that passes CI. |
| **[openapi.yaml](openapi.yaml)** | Import the machine-readable API contract into Postman, Stoplight, or a codegen tool. |

## How it works

```
        prompt
          │
          ▼
┌──────────────────────┐     questions      ┌──────────────────────┐
│ Prompt Ingestion     │ ─────────────────▶ │  Grill-Me Spec Loop  │
│ (parse + classify)   │ ◀───────────────── │  (clarify ambiguity) │
└──────────────────────┘      answers       └──────────┬───────────┘
                                                        │ resolved, versioned spec
                                                        ▼
                                             ┌──────────────────────┐
                            selects agents   │   Agent Registry     │
                          ◀───────────────── │  (capability catalog)│
                                             └──────────┬───────────┘
                                                        ▼
                                             ┌──────────────────────┐
                                             │   Code Generator     │
                                             │ (workflow + tests)   │
                                             └──────────┬───────────┘
                                                        ▼
                                             ┌──────────────────────┐
                                             │  Reliability Engine  │
                                             │ unit/integration/fuzz│
                                             │  + static analysis   │
                                             └──────────┬───────────┘
                                                        ▼  (only if green)
                                             ┌──────────────────────┐
                                             │   Publisher          │
                                             │ (commit + push repo) │
                                             └──────────────────────┘
```

A workflow only reaches the Publisher if the Reliability Engine passes: generated code is not pushed unless it compiles, type-checks, and its generated test suite is green.

## License

MIT © [slashman413](https://github.com/slashman413). See [LICENSE](LICENSE).
