# ADR-0004: A deterministic grill engine, with LLMs as an optional layer

## Status
Accepted

## Context
The signature feature is "grill me": interrogating a vague prompt into a solid
spec. The obvious implementation is to send the prompt to an LLM and ask it for
clarifying questions. But an LLM-only approach is: non-deterministic (hard to
test), a hard dependency (needs a key, costs money, can rate-limit), and a
correctness risk (it might skip the questions that matter).

## Decision
The grill engine is a **pure, deterministic rule engine** over a fixed set of
spec dimensions (goal, inputs, outputs, constraints, success, edge cases). Each
dimension detects whether the prompt already addresses it and, if not, emits
predefined questions. Readiness = all *critical* dimensions covered.

LLM assistance is deliberately **not** in v0.1, but the seam is reserved: an
adapter behind the engine may later propose richer, context-specific questions —
while the deterministic engine remains the floor that guarantees the essential
dimensions are always asked.

## Consequences
- **Easier:** the feature is unit-testable in milliseconds and reproducible
  (`same prompt + answers → same questions`); it runs with no API key, no cost,
  no network; it can even run in the browser.
- **Guaranteed coverage:** the critical questions are always asked, regardless of
  what any future LLM does or doesn't surface.
- **Costs / limits:** the questions are generic, not tailored to the specific
  domain of the prompt (an LLM would phrase them better). The keyword-based
  "already covered?" detector is intentionally conservative — when unsure it
  asks — so it can over-ask on well-written prompts. Accepted for v0.1; the LLM
  layer is the planned remedy and has a clear insertion point.
