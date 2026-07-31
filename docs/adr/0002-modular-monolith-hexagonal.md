# ADR-0002: A modular monolith with a hexagonal core

## Status
Accepted

## Context
The product has three cooperating capabilities (prompt, grill, workflow) and,
today, a single user and a single developer. We need boundaries that keep the
risky logic testable and let us swap infrastructure later, without paying the
operational tax of microservices before there is a team or a scaling reason.

Options considered:
1. **Microservices** — a service per capability.
2. **Layered monolith** — controllers → services → data, one process.
3. **Modular monolith with a hexagonal (ports & adapters) core** — one process,
   but the domain is dependency-free and infrastructure sits behind ports.

## Decision
Adopt option 3. The `domain/` layer has zero third-party imports; use-case
services in `application/` depend on the domain and on repository **ports**;
Express and SQLite are **adapters**; `index.js` is the composition root.

## Consequences
- **Easier:** unit-testing the core (no mocks, no I/O); swapping SQLite for
  Postgres (new adapter, same port); reasoning about dependency direction (it's
  greppable — the domain imports nothing external).
- **Easier later:** if a capability ever needs independent scaling, its module
  is already isolated behind an interface and can be extracted.
- **Harder / costs:** a little more indirection than a flat CRUD app (ports,
  a composition root). Justified because the grill/spec/validation logic is
  where the correctness risk lives, and that logic is exactly what the structure
  protects and isolates.
- **Rule to enforce in review:** controllers must not call repositories
  directly, and `domain/` must not import framework/DB packages.
