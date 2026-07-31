# Contributing

Thanks for your interest! This is an early-stage project with a deliberately
small, well-tested core.

## Setup

```bash
npm install
npm test        # must pass before you push
npm run lint
```

Requires Node.js ≥ 22.5.

## Architectural ground rules

These keep the codebase maintainable — PRs are reviewed against them:

1. **`domain/` imports nothing external.** No Express, no `node:sqlite`, no npm
   packages. If you need I/O, you're in the wrong layer. Check with:
   `grep -rE "express|node:sqlite|require\(" server/src/domain` (should be empty).
2. **Controllers don't touch repositories.** HTTP handlers call `ProjectService`;
   the service calls repositories through ports.
3. **New infrastructure = a new adapter behind a port**, wired only in
   `server/src/index.js` (the composition root).
4. **Every workflow-mutating path validates** via `validateWorkflow` before persisting.
5. **Tests use `node:test`** (no Jest). Keep the domain suite dependency-free so
   it runs on a bare checkout.

## Making a change

1. Add or update a test first where it makes sense (the domain is easy to TDD).
2. If you're changing a significant decision, add an ADR in `docs/adr/`.
3. Keep modules single-purpose and comments focused on *why*, not *what*.
4. Update `docs/API.md` / `docs/DOMAIN.md` if you change the API or vocabulary.

## Commit style

Conventional commits are appreciated (`feat:`, `fix:`, `docs:`, `refactor:`,
`test:`), but clarity matters more than ceremony.
