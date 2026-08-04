/**
 * sqliteRepos.js — SQLite implementations of the repository ports.
 *
 * Uses `node:sqlite` (built into Node 22+) so there is no native-build
 * dependency to install. JSON-heavy fields (answers, spec, workflow nodes) are
 * stored as TEXT columns holding JSON — SQLite is the durable key/value store,
 * the domain owns the shape. See docs/adr/0003 for the trade-off.
 *
 * Multi-tenant isolation (Increment 2): every repository method takes an
 * `orgId` and every SQL statement scopes by it — `WHERE org_id = ?` on reads,
 * the owning org written into `org_id` on writes, and org checks on upserts.
 * A row that belongs to another tenant is indistinguishable from a row that
 * does not exist (queries return null/empty → the service answers 404). This
 * is the storage-layer half of the auth choke point.
 *
 * Catalog (Increment 3): GLOBAL public MIT data, deliberately NOT org-scoped.
 * Writes happen only through `replaceSnapshot` / `recordVersion` (the sync
 * path) inside one transaction; a validation failure upstream never reaches
 * the data rows.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { runMigrations } from './migrate.js';

/**
 * @param {string} [filename] Path to the db file, or ':memory:' for ephemeral.
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] Progress sink for the migration runner.
 * @returns {{ db: import('node:sqlite').DatabaseSync, projects: any, workflows: any, grillSessions: any, vaultKeys: any, catalogs: any, ping: () => {ok: boolean, latencyMs?: number, error?: string} }}
 */
export function createSqliteRepos(filename = ':memory:', { log } = {}) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  // Schema lives in server/migrations/*.sql; the runner applies pending files
  // once, in order. This is the single source of schema truth for both the
  // running server and the in-memory test databases.
  runMigrations(db, log ? { log } : undefined);

  const projectRepo = {
    create({ orgId, prompt, answers = {}, spec = null }) {
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare(
        'INSERT INTO projects (id, org_id, prompt, answers, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, orgId, prompt, JSON.stringify(answers), spec ? JSON.stringify(spec) : null, now, now);
      return this.get(orgId, id);
    },
    get(orgId, id) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?').get(id, orgId);
      return row ? rowToProject(row) : null;
    },
    list(orgId) {
      const rows = db.prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY updated_at DESC').all(orgId);
      return rows.map(rowToProject);
    },
    update(orgId, id, patch) {
      const existing = this.get(orgId, id);
      if (!existing) return null;
      const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      db.prepare(
        'UPDATE projects SET prompt = ?, answers = ?, spec = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      ).run(
        next.prompt,
        JSON.stringify(next.answers ?? {}),
        next.spec ? JSON.stringify(next.spec) : null,
        next.updatedAt,
        id,
        orgId,
      );
      return this.get(orgId, id);
    },
    remove(orgId, id) {
      const info = db.prepare('DELETE FROM projects WHERE id = ? AND org_id = ?').run(id, orgId);
      return info.changes > 0;
    },
  };

  const workflowRepo = {
    save(orgId, projectId, workflow) {
      const existing = db.prepare('SELECT org_id FROM workflows WHERE project_id = ?').get(projectId);
      if (existing && existing.org_id !== orgId) return null;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO workflows (project_id, org_id, workflow, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET org_id = excluded.org_id, workflow = excluded.workflow, updated_at = excluded.updated_at`,
      ).run(projectId, orgId, JSON.stringify(workflow), now);
      return this.getByProject(orgId, projectId);
    },
    getByProject(orgId, projectId) {
      const row = db.prepare('SELECT workflow FROM workflows WHERE project_id = ? AND org_id = ?').get(projectId, orgId);
      return row ? JSON.parse(row.workflow) : null;
    },
  };

  const grillSessionsRepo = {
    record(orgId, projectId, { round, answers = {}, coverage = 0, ready = false, turns = 0, tokensUsed = 0 } = {}) {
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO grill_sessions (id, org_id, project_id, round, answers, coverage, ready, turns, tokens_used, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, orgId, projectId, round, JSON.stringify(answers), coverage, ready ? 1 : 0, turns, tokensUsed, now, now);
      return this.getLatest(orgId, projectId);
    },
    listByProject(orgId, projectId) {
      const rows = db
        .prepare('SELECT * FROM grill_sessions WHERE org_id = ? AND project_id = ? ORDER BY round ASC')
        .all(orgId, projectId);
      return rows.map(rowToSession);
    },
    getLatest(orgId, projectId) {
      const row = db
        .prepare('SELECT * FROM grill_sessions WHERE org_id = ? AND project_id = ? ORDER BY round DESC LIMIT 1')
        .get(orgId, projectId);
      return row ? rowToSession(row) : null;
    },
    /** Cumulative guardrail counters for the project's grill session. */
    usage(orgId, projectId) {
      const row = db
        .prepare('SELECT turns, tokens_used FROM grill_sessions WHERE org_id = ? AND project_id = ? ORDER BY round DESC LIMIT 1')
        .get(orgId, projectId);
      return row ? { turns: row.turns, tokensUsed: row.tokens_used } : null;
    },
  };

  const vaultKeysRepo = {
    insert({ id, orgId, provider, label, keyHandle, maskedKey, wrappedDek, wrappedKey }) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO vault_keys (id, org_id, provider, label, key_handle, masked_key, wrapped_dek, wrapped_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, orgId, provider, label, keyHandle, maskedKey, wrappedDek, wrappedKey, now, now);
      return this.getByOrg(orgId, id);
    },
    listByOrg(orgId) {
      const rows = db.prepare('SELECT * FROM vault_keys WHERE org_id = ? ORDER BY updated_at DESC').all(orgId);
      return rows.map(rowToVaultKey);
    },
    getByOrg(orgId, id) {
      const row = db.prepare('SELECT * FROM vault_keys WHERE org_id = ? AND id = ?').get(orgId, id);
      return row ? rowToVaultKey(row) : null;
    },
    getByKeyHandle(orgId, keyHandle) {
      const row = db.prepare('SELECT * FROM vault_keys WHERE org_id = ? AND key_handle = ?').get(orgId, keyHandle);
      return row ? rowToVaultKey(row) : null;
    },
    removeByOrg(orgId, id) {
      const info = db.prepare('DELETE FROM vault_keys WHERE org_id = ? AND id = ?').run(orgId, id);
      return info.changes > 0;
    },
  };

  // ---------------------------------------------------------------------------
  // Catalog (Increment 3) — GLOBAL public MIT data, NOT org-scoped.
  // Uses the 0005 schema: catalog_versions + personas + lenses tables.
  // Mirrors the in-memory adapter's contract exactly (see ports.js):
  // replaceAll / recordFailure / restore / getSnapshot / listSnapshots /
  // listDivisions / listAgents / getAgent / listLenses / getLens / hasCatalog.
  // ---------------------------------------------------------------------------
  /** Latest GOOD version row for a source (ok or partial status only). */
  const getLatestGoodVersion = (source) => {
    const row = db
      .prepare("SELECT * FROM catalog_versions WHERE source = ? AND status IN ('ok', 'partial') ORDER BY created_at DESC LIMIT 1")
      .get(source);
    return row ? rowToCatalogVersion(row) : null;
  };

  /** Division metadata (label/icon/color) from the latest good payload. */
  const divisionMeta = (source) => {
    const good = getLatestGoodVersion(source);
    if (!good?.payload) return new Map();
    try {
      const payload = JSON.parse(good.payload);
      return new Map((payload.divisions ?? []).map((d) => [d.id, d]));
    } catch {
      return new Map();
    }
  };

  const catalogRepo = {
    /**
     * Atomically replace the live catalog for one source with parsed records.
     * Inserts (or replaces) the version row FIRST — its payload is the full
     * installed catalog JSON — then swaps personas/lenses inside one
     * transaction. If any statement fails, the whole thing rolls back and the
     * last-good catalog stays installed.
     */
    replaceAll(payload) {
      const { source, version } = payload;
      const now = new Date().toISOString();
      const versionId = `${source}@${version}`;
      const counts = {
        agents: payload.agents?.length ?? 0,
        lenses: payload.lenses?.length ?? 0,
        divisions: payload.divisions?.length ?? 0,
        tools: payload.tools?.length ?? 0,
      };

      db.exec('BEGIN');
      try {
        // Version row (INSERT OR REPLACE: same id re-installs over itself and
        // cascades the old data rows).
        db.prepare(
          `INSERT OR REPLACE INTO catalog_versions (id, source, version, status, counts, error, payload, created_at)
           VALUES (?, ?, ?, 'ok', ?, NULL, ?, ?)`,
        ).run(versionId, source, version, JSON.stringify(counts), JSON.stringify(payload), now);

        // Replace personas (delete old + insert new for the same version).
        db.prepare('DELETE FROM personas WHERE version_id = ?').run(versionId);
        const insertPersona = db.prepare(
          `INSERT INTO personas (id, source, version_id, division, slug, name, description, emoji, color, vibe, tools, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const p of payload.agents ?? []) {
          insertPersona.run(
            p.id, source, versionId, p.division, p.slug,
            p.name, p.description, p.emoji ?? null, p.color ?? null, p.vibe ?? null,
            JSON.stringify(p.tools ?? []), p.body, now,
          );
        }

        // Replace lenses.
        db.prepare('DELETE FROM lenses WHERE version_id = ?').run(versionId);
        const insertLens = db.prepare(
          `INSERT INTO lenses (id, source, version_id, slug, name, description, fidelity, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const l of payload.lenses ?? []) {
          insertLens.run(
            l.id, source, versionId, l.slug, l.name, l.description,
            l.fidelity ?? null, l.body, now,
          );
        }

        // Prune superseded version rows (cascades their data rows).
        db.prepare('DELETE FROM catalog_versions WHERE source = ? AND id != ?').run(source, versionId);

        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      return this.getSnapshot(source);
    },

    /** Record a failed sync attempt (no data rows are touched). */
    recordFailure(source, version, error) {
      const now = new Date().toISOString();
      const versionId = `${source}@${version}`;
      db.prepare(
        `INSERT INTO catalog_versions (id, source, version, status, counts, error, payload, created_at)
         VALUES (?, ?, ?, 'failed', '{}', ?, NULL, ?)`,
      ).run(versionId, source, version, String(error).slice(0, 2000), now);
      return this.getSnapshot(source);
    },

    /** Manual rollback: re-install a stored 'ok' snapshot's payload. */
    restore(snapshotId) {
      const row = db.prepare('SELECT * FROM catalog_versions WHERE id = ?').get(snapshotId);
      if (!row || row.status !== 'ok' || !row.payload) return null;
      let payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        return null;
      }
      this.replaceAll(payload);
      return this.getSnapshot(row.source);
    },

    /** Latest snapshot row for a source (any status) — provenance view. */
    getSnapshot(source) {
      return this.listSnapshots(source)[0] ?? null;
    },

    listSnapshots(source) {
      const rows = db
        .prepare('SELECT * FROM catalog_versions WHERE source = ? ORDER BY created_at DESC LIMIT 20')
        .all(source);
      return rows.map(rowToSnapshot);
    },

    listDivisions() {
      const good = getLatestGoodVersion('agency-agents');
      if (!good) return [];
      const meta = divisionMeta('agency-agents');
      if (meta.size > 0) {
        return [...meta.values()]
          .map((d) => ({ id: d.id, label: d.label ?? d.id, icon: d.icon ?? null, color: d.color ?? null }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      // Fallback: distinct divisions present on persona rows.
      const rows = db
        .prepare('SELECT DISTINCT division FROM personas WHERE version_id = ? ORDER BY division')
        .all(good.id);
      return rows.map((r) => ({ id: r.division, label: r.division }));
    },

    listAgents({ division = null, q = null, limit = 100 } = {}) {
      const good = getLatestGoodVersion('agency-agents');
      if (!good) return [];
      const meta = divisionMeta('agency-agents');
      const query = String(q ?? '').trim();
      const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

      const clauses = ['version_id = ?'];
      const params = [good.id];
      if (division) { clauses.push('division = ?'); params.push(division); }
      if (query) {
        clauses.push('(name LIKE ? OR description LIKE ? OR vibe LIKE ?)');
        const like = `%${query}%`;
        params.push(like, like, like);
      }
      params.push(safeLimit);

      const rows = db
        .prepare(`SELECT * FROM personas WHERE ${clauses.join(' AND ')} ORDER BY name LIMIT ?`)
        .all(...params);
      return rows.map((r) => rowToPersona(r, good, meta));
    },

    getAgent(id) {
      const good = getLatestGoodVersion('agency-agents');
      if (!good) return null;
      const row = db.prepare('SELECT * FROM personas WHERE id = ? AND version_id = ?').get(id, good.id);
      return row ? rowToPersona(row, good, divisionMeta('agency-agents')) : null;
    },

    listLenses() {
      const good = getLatestGoodVersion('nuwa-skill');
      if (!good) return [];
      const rows = db.prepare('SELECT * FROM lenses WHERE version_id = ? ORDER BY name').all(good.id);
      return rows.map((r) => rowToLens(r, good));
    },

    getLens(id) {
      const good = getLatestGoodVersion('nuwa-skill');
      if (!good) return null;
      const row = db.prepare('SELECT * FROM lenses WHERE id = ? AND version_id = ?').get(id, good.id);
      return row ? rowToLens(row, good) : null;
    },

    hasCatalog(source) {
      return Boolean(getLatestGoodVersion(source));
    },

    /** Global tool allow-list from the latest good agency-agents payload. */
    listTools() {
      const good = getLatestGoodVersion('agency-agents');
      if (!good?.payload) return [];
      try {
        const payload = JSON.parse(good.payload);
        return (payload.tools ?? [])
          .map((t) => (typeof t === 'string' ? { id: t } : { id: t?.id, label: t?.label, short: t?.short, icon: t?.icon }))
          .filter((t) => t.id)
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      } catch {
        return [];
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Billing (Increment 4) — one row per org (tenant-scoped), plus the
  // webhook idempotency ledger. `recordEvent` inserts the event id as PRIMARY
  // KEY: the second delivery of the same event fails the insert (returns
  // false) so its side effects never run twice.
  // ---------------------------------------------------------------------------
  const billingRepo = {
    getByOrg(orgId) {
      const row = db.prepare('SELECT * FROM billing WHERE org_id = ?').get(orgId);
      return row ? rowToBilling(row) : null;
    },
    upsert(orgId, record) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO billing (org_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, trial_end, cancel_at_period_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           stripe_customer_id = COALESCE(excluded.stripe_customer_id, billing.stripe_customer_id),
           stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, billing.stripe_subscription_id),
           plan = excluded.plan,
           status = excluded.status,
           current_period_end = COALESCE(excluded.current_period_end, billing.current_period_end),
           trial_end = COALESCE(excluded.trial_end, billing.trial_end),
           cancel_at_period_end = excluded.cancel_at_period_end,
           updated_at = excluded.updated_at`,
      ).run(
        orgId,
        record.stripeCustomerId ?? null,
        record.stripeSubscriptionId ?? null,
        record.plan ?? 'free',
        record.status ?? 'none',
        record.currentPeriodEnd ?? null,
        record.trialEnd ?? null,
        record.cancelAtPeriodEnd ? 1 : 0,
        now,
        now,
      );
      return this.getByOrg(orgId);
    },
    listEvents(orgId) {
      return db
        .prepare('SELECT * FROM billing_events WHERE org_id = ? ORDER BY received_at ASC')
        .all(orgId)
        .map(rowToBillingEvent);
    },
    /** @returns {boolean} true when the event was NEW (side effects should run). */
    recordEvent({ eventId, eventType, orgId = null }) {
      try {
        db.prepare('INSERT INTO billing_events (event_id, event_type, org_id, received_at) VALUES (?, ?, ?, ?)').run(
          eventId,
          eventType,
          orgId,
          new Date().toISOString(),
        );
        return true;
      } catch {
        return false; // PRIMARY KEY collision — the event was already processed
      }
    },
  };

  // ---------------------------------------------------------------------------
  // GitHub publishing (Increment 4) — OAuth connections (token sealed with
  // the vault's envelope key) and the publication ledger.
  // ---------------------------------------------------------------------------
  const githubConnectionsRepo = {
    get(orgId) {
      const row = db.prepare('SELECT * FROM github_connections WHERE org_id = ?').get(orgId);
      return row ? rowToGithubConnection(row) : null;
    },
    upsert(orgId, { login, tokenSealed, scopes }) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO github_connections (org_id, login, token_sealed, scopes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           login = excluded.login,
           token_sealed = excluded.token_sealed,
           scopes = excluded.scopes,
           updated_at = excluded.updated_at`,
      ).run(orgId, login, tokenSealed, JSON.stringify(scopes ?? []), now, now);
      return this.get(orgId);
    },
    remove(orgId) {
      const info = db.prepare('DELETE FROM github_connections WHERE org_id = ?').run(orgId);
      return info.changes > 0;
    },
  };

  const publicationsRepo = {
    record(record) {
      const now = new Date().toISOString();
      const id = record.id ?? randomUUID();
      db.prepare(
        `INSERT INTO publications (id, org_id, project_id, repo_owner, repo_name, repo_url, private, file_count, latency_ms, workflow_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        record.orgId,
        record.projectId,
        record.repoOwner,
        record.repoName,
        record.repoUrl,
        record.private ? 1 : 0,
        record.fileCount,
        record.latencyMs,
        record.workflowHash,
        record.createdAt ?? now,
      );
      return this.listByOrg(record.orgId)[0] ?? null;
    },
    listByOrg(orgId) {
      return db
        .prepare('SELECT * FROM publications WHERE org_id = ? ORDER BY created_at DESC')
        .all(orgId)
        .map(rowToPublication);
    },
    listByProject(orgId, projectId) {
      return db
        .prepare('SELECT * FROM publications WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC')
        .all(orgId, projectId)
        .map(rowToPublication);
    },
  };

  // ---------------------------------------------------------------------------
  // Increment 4 (continuation): monthly usage quotas + local privacy-safe
  // telemetry log (migration 0008). Billing + webhook idempotency live in
  // `billingRepo`; GitHub connections + publications in their own repos.
  // ---------------------------------------------------------------------------
  const usageRepo = {
    /** Increment a monthly counter (upsert) and return the new total. */
    increment(orgId, metric, period, amount = 1) {
      db.prepare(
        `INSERT INTO usage_events (id, org_id, metric, period, amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, metric, period) DO UPDATE SET amount = amount + excluded.amount`,
      ).run(randomUUID(), orgId, metric, period, amount, new Date().toISOString());
      return this.count(orgId, metric, period);
    },
    count(orgId, metric, period) {
      const row = db
        .prepare('SELECT amount FROM usage_events WHERE org_id = ? AND metric = ? AND period = ?')
        .get(orgId, metric, period);
      return row ? row.amount : 0;
    },
  };

  const telemetryRepo = {
    insert({ orgHash, event, props = {} }) {
      db.prepare(
        'INSERT INTO telemetry_events (id, org_hash, event, props, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(randomUUID(), orgHash, event, JSON.stringify(props), new Date().toISOString());
      return true;
    },
  };

  // ---------------------------------------------------------------------------
  // Execution (Increment 5) — the run ledger (executions), per-step logs
  // (execution_steps), and one-click deploys (deployments). All org-scoped:
  // a foreign-org lookup is indistinguishable from a missing row, matching the
  // tenancy contract of every other repository here.
  // ---------------------------------------------------------------------------
  const executionsRepo = {
    create(record) {
      const now = new Date().toISOString();
      const id = record.id ?? `exec_${randomUUID()}`;
      db.prepare(
        `INSERT INTO executions (id, org_id, project_id, workflow_id, status, started_at, finished_at, duration_ms, error_message, retry_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        record.orgId,
        record.projectId,
        record.workflowId ?? '',
        record.status ?? 'queued',
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.durationMs ?? null,
        record.errorMessage ?? null,
        record.retryOf ?? null,
        now,
      );
      return this.get(record.orgId, id);
    },
    get(orgId, id) {
      const row = db.prepare('SELECT * FROM executions WHERE id = ? AND org_id = ?').get(id, orgId);
      return row ? rowToExecution(row) : null;
    },
    listByProject(orgId, projectId) {
      const rows = db
        .prepare('SELECT * FROM executions WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC')
        .all(orgId, projectId);
      return rows.map(rowToExecution);
    },
    latestForProject(orgId, projectId) {
      const row = db
        .prepare('SELECT * FROM executions WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(orgId, projectId);
      return row ? rowToExecution(row) : null;
    },
    update(orgId, id, patch) {
      const existing = this.get(orgId, id);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      db.prepare(
        `UPDATE executions SET status = ?, started_at = ?, finished_at = ?, duration_ms = ?, error_message = ? WHERE id = ? AND org_id = ?`,
      ).run(
        next.status ?? existing.status,
        next.startedAt ?? existing.startedAt,
        next.finishedAt ?? existing.finishedAt,
        next.durationMs ?? existing.durationMs,
        next.errorMessage ?? existing.errorMessage,
        id,
        orgId,
      );
      return this.get(orgId, id);
    },
  };

  const executionStepsRepo = {
    insert(record) {
      const now = new Date().toISOString();
      const id = record.id ?? randomUUID();
      db.prepare(
        `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, input_data, output_data, error_message, attempts, duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        record.executionId,
        record.nodeId,
        record.nodeType,
        record.status ?? 'queued',
        record.inputData != null ? JSON.stringify(record.inputData) : null,
        record.outputData != null ? JSON.stringify(record.outputData) : null,
        record.errorMessage ?? null,
        record.attempts ?? 1,
        record.durationMs ?? null,
        now,
        now,
      );
      return this.get(record.orgId, id);
    },
    get(orgId, id) {
      const row = db
        .prepare('SELECT s.* FROM execution_steps s JOIN executions e ON e.id = s.execution_id WHERE s.id = ? AND e.org_id = ?')
        .get(id, orgId);
      return row ? rowToExecutionStep(row) : null;
    },
    listByExecution(orgId, executionId) {
      const rows = db
        .prepare('SELECT s.* FROM execution_steps s JOIN executions e ON e.id = s.execution_id WHERE s.execution_id = ? AND e.org_id = ? ORDER BY s.created_at ASC')
        .all(executionId, orgId);
      return rows.map(rowToExecutionStep);
    },
    update(orgId, id, patch) {
      const existing = this.get(orgId, id);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      db.prepare(
        `UPDATE execution_steps SET status = ?, input_data = ?, output_data = ?, error_message = ?, attempts = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
      ).run(
        next.status ?? existing.status,
        next.inputData != null ? JSON.stringify(next.inputData) : null,
        next.outputData != null ? JSON.stringify(next.outputData) : null,
        next.errorMessage ?? existing.errorMessage,
        next.attempts ?? existing.attempts,
        next.durationMs ?? existing.durationMs,
        new Date().toISOString(),
        id,
      );
      return this.get(orgId, id);
    },
  };

  const deploymentsRepo = {
    create(record) {
      const now = new Date().toISOString();
      const id = record.id ?? `dep_${randomUUID()}`;
      db.prepare(
        `INSERT INTO deployments (id, org_id, project_id, platform, status, config, url, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        record.orgId,
        record.projectId,
        record.platform,
        record.status ?? 'deploying',
        record.config != null ? JSON.stringify(record.config) : '{}',
        record.url ?? null,
        record.errorMessage ?? null,
        now,
      );
      return this.get(record.orgId, id);
    },
    get(orgId, id) {
      const row = db.prepare('SELECT * FROM deployments WHERE id = ? AND org_id = ?').get(id, orgId);
      return row ? rowToDeployment(row) : null;
    },
    listByProject(orgId, projectId) {
      const rows = db
        .prepare('SELECT * FROM deployments WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC')
        .all(orgId, projectId);
      return rows.map(rowToDeployment);
    },
    update(orgId, id, patch) {
      const existing = this.get(orgId, id);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      db.prepare(
        'UPDATE deployments SET status = ?, config = ?, url = ?, error_message = ? WHERE id = ? AND org_id = ?',
      ).run(
        next.status ?? existing.status,
        next.config != null ? JSON.stringify(next.config) : JSON.stringify(existing.config ?? {}),
        next.url ?? existing.url,
        next.errorMessage ?? existing.errorMessage,
        id,
        orgId,
      );
      return this.get(orgId, id);
    },
  };

  return {
    db,
    projects: projectRepo,
    workflows: workflowRepo,
    grillSessions: grillSessionsRepo,
    vaultKeys: vaultKeysRepo,
    catalog: catalogRepo,
    billing: billingRepo,
    githubConnections: githubConnectionsRepo,
    publications: publicationsRepo,
    usage: usageRepo,
    telemetry: telemetryRepo,
    executions: executionsRepo,
    executionSteps: executionStepsRepo,
    deployments: deploymentsRepo,
    /**
     * Readiness probe for GET /api/health — one cheap round-trip. Never
     * throws: a broken database reports `{ ok: false, error }` so the health
     * endpoint can answer 503 instead of crashing the probe.
     */
    ping() {
      const t0 = performance.now();
      try {
        db.prepare('SELECT 1').get();
        return { ok: true, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

// --- Row-to-object mappers -------------------------------------------------

function rowToProject(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    prompt: row.prompt,
    answers: JSON.parse(row.answers || '{}'),
    spec: row.spec ? JSON.parse(row.spec) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    round: row.round,
    answers: JSON.parse(row.answers || '{}'),
    coverage: row.coverage,
    ready: row.ready === 1,
    turns: row.turns ?? 0,
    tokensUsed: row.tokens_used ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVaultKey(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    label: row.label,
    keyHandle: row.key_handle,
    maskedKey: row.masked_key,
    wrappedDek: row.wrapped_dek,
    wrappedKey: row.wrapped_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCatalogVersion(row) {
  return {
    id: row.id,
    source: row.source,
    version: row.version,
    status: row.status,
    counts: row.counts ? JSON.parse(row.counts) : {},
    error: row.error,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

/** Snapshot row as exposed to the service layer (provenance UI). */
function rowToSnapshot(row) {
  const counts = row.counts ? JSON.parse(row.counts) : {};
  let summary = 'sync failed';
  if (row.status === 'ok' || row.status === 'partial') {
    summary = counts.lenses
      ? `${counts.lenses} lenses`
      : `${counts.agents ?? 0} agents, ${counts.divisions ?? 0} divisions, ${counts.tools ?? 0} tools`;
  }
  return {
    id: row.id,
    source: row.source,
    version: row.version,
    status: row.status,
    summary,
    error: row.error,
    syncedAt: row.created_at,
  };
}

function rowToPersona(row, versionRow, divisionMeta = new Map()) {
  return {
    id: row.id,
    source: row.source,
    version: versionRow?.version ?? null,
    versionId: row.version_id,
    division: row.division,
    divisionLabel: divisionMeta.get(row.division)?.label ?? row.division,
    slug: row.slug,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    color: row.color,
    vibe: row.vibe,
    tools: JSON.parse(row.tools || '[]'),
    body: row.body,
    createdAt: row.created_at,
  };
}

function rowToLens(row, versionRow) {
  return {
    id: row.id,
    source: row.source,
    version: versionRow?.version ?? null,
    versionId: row.version_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    fidelity: row.fidelity,
    body: row.body,
    createdAt: row.created_at,
  };
}

function rowToBilling(row) {
  return {
    orgId: row.org_id,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    plan: row.plan,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    trialEnd: row.trial_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBillingEvent(row) {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    orgId: row.org_id,
    receivedAt: row.received_at,
  };
}

function rowToGithubConnection(row) {
  return {
    orgId: row.org_id,
    login: row.login,
    tokenSealed: row.token_sealed,
    scopes: JSON.parse(row.scopes || '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPublication(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoUrl: row.repo_url,
    private: row.private === 1,
    fileCount: row.file_count,
    latencyMs: row.latency_ms,
    workflowHash: row.workflow_hash,
    createdAt: row.created_at,
  };
}

function rowToExecution(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    retryOf: row.retry_of,
    createdAt: row.created_at,
  };
}

function rowToExecutionStep(row) {
  return {
    id: row.id,
    executionId: row.execution_id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    status: row.status,
    inputData: row.input_data ? JSON.parse(row.input_data) : null,
    outputData: row.output_data ? JSON.parse(row.output_data) : null,
    errorMessage: row.error_message,
    attempts: row.attempts ?? 1,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDeployment(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    platform: row.platform,
    status: row.status,
    config: row.config ? JSON.parse(row.config) : {},
    url: row.url,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}