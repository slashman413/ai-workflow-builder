# ADR-0003: SQLite via the built-in `node:sqlite`

## Status
Accepted

## Context
We need durable storage for projects and workflows. The data is small,
single-user, and mostly document-shaped (JSON blobs for answers, spec, and
nodes). Constraints: keep operational cost near zero, keep the install painless,
and don't lock the domain to a storage engine.

Options considered:
1. **Postgres/MySQL** — a real server the user must run.
2. **A file-based JSON store** — trivial, but no transactions or queries.
3. **SQLite** via a native npm package (`better-sqlite3`).
4. **SQLite** via Node's built-in `node:sqlite` (Node ≥ 22.5).

## Decision
Use option 4: `node:sqlite`. Storage lives behind the `WorkflowRepository` and
`ProjectRepository` ports; document-shaped fields are stored as JSON `TEXT`
columns, with SQLite providing durability, transactions, and cascade deletes.

## Consequences
- **Easier:** no database server to run (`npm install && npm start`); no native
  build step or `node-gyp`; a real relational store when we need constraints
  (foreign keys, `ON DELETE CASCADE`) or ad-hoc queries later.
- **Costs / risks:** `node:sqlite` is an experimental built-in (emits a warning)
  and requires Node ≥ 22.5 — pinned in `engines`. If it ever proves unstable,
  the port boundary means switching to `better-sqlite3` or Postgres is a new
  adapter, not a domain change.
- **Trade-off accepted:** storing JSON in TEXT columns means we can't query
  *inside* spec/nodes at the SQL level yet. That's fine — the domain owns those
  shapes, and single-user scale doesn't need it. Revisit if reporting/queries
  across many projects become a requirement.
