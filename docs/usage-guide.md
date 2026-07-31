# Usage Guide

This guide takes you from nothing to a generated, tested multi-agent workflow in about 10 minutes. You'll use the CLI for the fast path, then see the equivalent HTTP calls so you can automate the same flow.

**What you'll do**
- Install `ai-workflow-builder` and set your keys
- Build your first workflow from a one-line prompt
- Answer the Grill-Me questions that resolve ambiguity
- Inspect the generated code and test report
- (Optional) Publish it to a GitHub repo

**Prerequisites**
- [ ] Python 3.11+ (`python --version`)
- [ ] At least one model-provider API key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`
- [ ] A GitHub personal access token with `repo` scope — **only** if you want to publish

---

## Step 1: Install

```bash
pipx install ai-workflow-builder   # recommended — isolated CLI
# or
pip install ai-workflow-builder
```

Verify:

```bash
awb --version
# ai-workflow-builder 1.0.0
```

> **If `awb: command not found`** after `pipx`, run `pipx ensurepath` and open a new shell.

## Step 2: Configure your keys

The builder reads keys from the environment. Set the provider you have, and (optionally) a GitHub token:

```bash
export OPENAI_API_KEY=sk-...          # any one provider is enough
export GITHUB_TOKEN=ghp_...           # only needed to publish
```

To make this permanent, add those lines to your shell profile (`~/.bashrc`, `~/.zshrc`) or use a `.env` file — the CLI reads `.env` from the current directory automatically.

## Step 3: Build your first workflow

Give the builder one plain sentence describing what you want:

```bash
awb build "Summarize a URL, translate it to Traditional Chinese, and post to Slack"
```

You'll see it ingest the prompt, then pause to ask you only about the ambiguous parts:

```
✔ Prompt ingested (wf_9f2a7c1b)
? Which target language variant should the translator use?
  › zh-Hant (Traditional)
    zh-Hans (Simplified)
? Which Slack channel should the result be posted to?  #daily-digest
```

This is the **Grill-Me loop**. It asks about things it genuinely cannot infer — never trivia. Answer each question; the builder re-resolves the spec and asks follow-ups only if your answers introduced new ambiguity.

## Step 4: Watch it generate and test

Once the spec resolves, the builder generates the workflow code and runs the Reliability Engine automatically:

```
✔ Spec resolved (v2): url-summary-translate-slack
✔ Generated 4 files
⟳ Testing…  unit 18/18 · integration 5/5 · fuzz 500/500 · coverage 100%
✔ All checks passed in 41.7s
```

Generated code is written to `./out/wf_9f2a7c1b/` by default (override with `--out <dir>`):

```
out/wf_9f2a7c1b/
├── workflow.py            # the orchestrated multi-agent pipeline
├── tests/test_workflow.py # the generated test suite
├── pyproject.toml
└── README.md
```

Run the generated workflow locally:

```bash
cd out/wf_9f2a7c1b
pip install -e .
python -m workflow --url https://example.com/article
```

## Step 5: Publish (optional)

If `GITHUB_TOKEN` is set, push the tested workflow to a new repo:

```bash
awb publish wf_9f2a7c1b --name url-digest-bot --public
# ✔ Published → https://github.com/slashman413/url-digest-bot (commit e83c516)
```

A workflow can only be published after its tests pass — the builder refuses to push code it couldn't verify.

---

## Non-interactive mode

For scripts and CI, run without prompts. The builder makes documented best-effort assumptions instead of asking, and records each one in the spec's `assumptions[]` so nothing is silent:

```bash
awb build "Summarize a URL and email me the result" \
  --non-interactive \
  --auto-publish --name url-emailer --private
```

Review the assumptions afterward:

```bash
awb spec wf_XXXX --show-assumptions
```

## The same flow over HTTP

Everything above is also available from the REST API. Start the server (see the [Deployment Guide](deployment-guide.md)), then:

```bash
export AWB=http://localhost:8000 KEY=<API_KEY>

# 1. Submit the prompt
wf=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"Summarize a URL, translate it to Traditional Chinese, and post to Slack"}' \
  $AWB/api/v1/workflows | python -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 2. Read the Grill-Me questions
curl -s -H "Authorization: Bearer $KEY" $AWB/api/v1/workflows/$wf/questions

# 3. Answer them
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"answers":[{"question_id":"q_agents","value":"zh-Hant (Traditional)"},
                  {"question_id":"q_slack_channel","value":"#daily-digest"}]}' \
  $AWB/api/v1/workflows/$wf/answers

# 4. Poll until tested, then publish
curl -s -H "Authorization: Bearer $KEY" $AWB/api/v1/workflows/$wf
curl -s -X POST -H "Authorization: Bearer $KEY" $AWB/api/v1/workflows/$wf/publish
```

See the full [API Reference](api-reference.md) for every field and error.

---

## Writing prompts that work well

The builder handles vague prompts by asking — but a little structure means fewer questions and a better first result.

- **Name the steps in order.** "Fetch X, then do Y, then send to Z" maps cleanly to agents.
- **Say where inputs come from and outputs go.** "…post to Slack" is answerable; "…notify the team" triggers a clarification.
- **Mention constraints if they matter.** "…keep it under $0.02 per run" or "…must finish in 10s" sets budgets in the spec.
- **One workflow per prompt.** If you describe two unrelated jobs, build two workflows.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Error: no model provider configured` | No provider key in the environment. | `export OPENAI_API_KEY=…` (or Anthropic/Gemini). |
| Grill-Me keeps asking follow-ups | Each answer introduces new ambiguity. | Give more specific answers, or restart with a more precise prompt. |
| `publish failed: PUBLISH_TOKEN_MISSING` | No `GITHUB_TOKEN`. | Export a token with `repo` scope, then re-run `awb publish`. |
| Tests fail (`test_failed`) | The generated workflow didn't pass the reliability suite. | Run `awb test-report wf_XXXX` to see failures; refine the prompt and rebuild. Failed workflows are never published. |
| `awb: command not found` | CLI not on `PATH`. | `pipx ensurepath` and reopen the shell. |

## Next steps

- [API Reference](api-reference.md) — automate builds programmatically.
- [Deployment Guide](deployment-guide.md) — run the service for a team.
- [Contributing](CONTRIBUTING.md) — add a new agent to the registry.
