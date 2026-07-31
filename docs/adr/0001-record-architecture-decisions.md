# ADR-0001: Record architecture decisions

## Status
Accepted

## Context
This project makes several non-obvious choices (a deterministic grill engine, a
zero-dependency domain, SQLite over a server database). Future contributors — and
future us — need the *why*, not just the *what*, to change these safely.

## Decision
We keep lightweight Architecture Decision Records in `docs/adr/`, numbered and
immutable once accepted. Superseding an ADR means writing a new one that
references the old, not editing history.

## Consequences
- Easier onboarding; decisions are discoverable next to the code.
- A small ongoing cost: meaningful decisions should come with an ADR.
- Reversing a decision leaves a visible trail rather than silent drift.
