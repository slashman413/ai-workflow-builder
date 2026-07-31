# Contributing to ai-workflow-builder

Thanks for helping build the most reliable prompt-to-workflow tool. This project ships an MIT-licensed core that other teams depend on in production, so the bar for changes is high: **every change ships with tests and passes CI, and code without docs is incomplete.** This guide gets you from a fork to a merged PR.

By contributing you agree that your contributions are licensed under the [MIT License](../LICENSE).

---

## Ways to contribute

- **Add or improve an agent** in the Agent Registry (the most common and welcome contribution).
- **Improve the Grill-Me spec loop** — better question generation, fewer redundant questions.
- **Harden the Reliability Engine** — new fuzz strategies, more static checks.
- **Fix bugs** — start from an issue; if none exists, open one first.
- **Improve docs** — see [Documentation](#documentation).

If your change is large or user-facing, **open an issue to discuss it before writing code.** It saves everyone a wasted review cycle.

---

## Development setup

**Prerequisites:** Python 3.11+, [Poetry](https://python-poetry.org/) 1.7+, and `git`.

```bash
# 1. Fork on GitHub, then clone your fork
git clone https://github.com/<you>/ai-workflow-builder.git
cd ai-workflow-builder

# 2. Install everything, including dev tools
poetry install

# 3. Install the pre-commit hooks (runs the linters on staged files)
poetry run pre-commit install

# 4. Confirm a clean baseline before you change anything
poetry run poe check    # runs ruff + black --check + mypy + pytest
```

If `poe check` is green on a fresh clone, your environment is correct. If it isn't, fix that before writing code — don't build on a red baseline.

## Branching & commits

- Branch off `main`: `git checkout -b feat/add-notion-agent` (or `fix/…`, `docs/…`).
- Keep each PR focused on one thing.
- Use **[Conventional Commits](https://www.conventionalcommits.org/)**:

  ```
  feat(agents): add Notion page-writer agent
  fix(grill): stop re-asking answered single-choice questions
  docs(api): document the Idempotency-Key header
  test(reliability): add fuzz cases for empty prompts
  ```

  The type prefix drives the changelog and version bump, so it isn't optional.

## Quality gates (what CI enforces)

Your PR must pass all of these — they run in GitHub Actions on every push, and they're the same commands you can run locally:

| Gate | Command | Rule |
|------|---------|------|
| Lint | `poetry run ruff check .` | No lint errors. |
| Format | `poetry run black --check .` | Code is `black`-formatted. |
| Types | `poetry run mypy .` | No type errors; new code is fully typed. |
| Tests | `poetry run pytest` | All tests pass. |
| Coverage | `poetry run pytest --cov` | Coverage does not decrease; new code is covered. |

Run everything at once with `poetry run poe check`. **CI is not a way to find out whether your code works — run the gates locally first.**

## Testing standards

This project's whole value proposition is reliability, so tests are not optional garnish.

- **Every new feature and every bug fix ships with a test.** For a bug fix, add the test that fails without your change and passes with it.
- **Unit tests** live in `tests/unit/`, **integration tests** in `tests/integration/`.
- **Don't call real model providers or GitHub in tests.** Use the provided fakes in `tests/fakes/` (`FakeModelProvider`, `FakeGitHub`). Tests must be deterministic and runnable offline.
- If you touch the Reliability Engine, add cases to the fuzz corpus in `tests/fuzz/`.

```bash
poetry run pytest tests/unit/test_grill_loop.py -q      # one file
poetry run pytest -k publish                            # by keyword
```

## Adding a new agent (worked example)

Agents are the registry's building blocks. To add one:

1. **Implement it** in `src/ai_workflow_builder/agents/<name>.py`, subclassing `BaseAgent` and declaring its `capabilities`, `inputs`, and `outputs`.
2. **Register it** by adding it to the registry manifest in `src/ai_workflow_builder/agents/__init__.py` (the registry is discovered from this list).
3. **Test it** in `tests/unit/agents/test_<name>.py` — cover its happy path and at least one failure/edge case, using `FakeModelProvider` if it calls a model.
4. **Document it** — add a row to the agent catalog in `docs/agents.md` (capability, inputs, outputs, one-line description).

```python
# src/ai_workflow_builder/agents/notion_writer.py
from ai_workflow_builder.agents.base import BaseAgent, AgentResult

class NotionWriterAgent(BaseAgent):
    id = "notion_writer"
    capabilities = ["publish"]
    inputs = ["text", "page_id"]
    outputs = ["url"]

    def run(self, text: str, page_id: str) -> AgentResult:
        # ... call the Notion API via the injected client ...
        return AgentResult(outputs={"url": created_url})
```

A new agent is "done" only when all four steps above are complete — code without its registry entry, test, and catalog row will not merge.

## Documentation

Docs live in `docs/` and are part of the definition of done:

- A **new feature** updates the relevant guide (usage, API, or deployment) in the same PR.
- A **breaking change** ships a migration note before release.
- **Code examples must run.** If you add or change one, execute it against the current code first.
- Voice: second person ("you"), present tense, active voice. One concept per section.

## Opening the pull request

1. Rebase on the latest `main` and make sure `poetry run poe check` is green.
2. Push your branch and open a PR against `slashman413/ai-workflow-builder:main`.
3. Fill in the PR template: **what** changed, **why**, and **how you tested it**. Link the issue (`Closes #123`).
4. Confirm the checklist: tests added, docs updated, CI green, one focused change.

Reviews aim to respond within **2 business days**. A maintainer will look at correctness, test coverage, reliability impact, and docs. Address feedback with follow-up commits (don't force-push over a review in progress unless asked); the branch is squash-merged.

## Reporting bugs & security issues

- **Bugs:** open a GitHub issue with the prompt used, the observed vs. expected behavior, the workflow state, and the version (`awb --version`). A minimal reproducing prompt is worth a thousand words.
- **Security vulnerabilities:** do **not** open a public issue. Email the maintainers (see `SECURITY.md`) with details and reproduction steps; you'll get an acknowledgment within 48 hours.

## Code of conduct

Be respectful and constructive. Assume good faith, keep discussion technical, and help newcomers. Harassment of any kind is not tolerated.

---

Thanks again — reliable tooling is built one well-tested, well-documented PR at a time.
