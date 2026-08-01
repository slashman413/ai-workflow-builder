import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';

/**
 * MarketplaceSidebar.jsx — the Agent Marketplace + Cognitive Lens selector
 * (Increment 3).
 *
 * Data comes from the versioned ecosystem catalogs:
 *   GET /api/catalog/personas        → personas grouped by division, each
 *                                      carrying its tool permission tags
 *   GET /api/catalog/lenses          → nuwa-skill cognitive perspective lenses
 *   GET /api/skills/check-updates    → pinned catalog version report (badges)
 *
 * Interaction model:
 *   - Personas are DRAGGABLE onto the workflow canvas. Dropping embeds the
 *     immutable `persona_id` (and the currently selected `lens_id`, if any)
 *     into the new agent node — the node is a reference, not a copy.
 *   - The Cognitive Lens selector picks the lens applied to newly dropped
 *     agent nodes; clicking a lens expands its body + FIDELITY scorecard.
 *   - Version badges show the pinned catalog ref each entry came from, so
 *     the canvas nodes can carry provenance.
 *
 * Read-only for viewers (drag disabled) — the marketplace itself is global
 * public MIT data and identical for every org.
 */

const DND_MIME = 'application/x-wfb-persona';

export function MarketplaceSidebar({ canEdit, activeLensId, onSelectLens, onAddPersona }) {
  const [marketplace, setMarketplace] = useState(null); // { source, version, divisions: [{id,label,icon,color,agents:[]}] }
  const [lenses, setLenses] = useState([]);
  const [updates, setUpdates] = useState([]); // [{source, version, status, ok, summary}]
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set(['engineering']));
  const [expandedLens, setExpandedLens] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.catalog.personas(), api.catalog.lenses(), api.catalog.checkUpdates()])
      .then(([m, l, u]) => {
        if (!alive) return;
        setMarketplace(m);
        setLenses(l);
        setUpdates(u);
      })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  const personaVersion = marketplace?.version ?? null;

  const filtered = useMemo(() => {
    if (!marketplace) return [];
    const query = q.trim().toLowerCase();
    return marketplace.divisions
      .map((d) => ({
        ...d,
        agents: query
          ? d.agents.filter((a) =>
              [a.name, a.description, a.vibe ?? ''].some((f) => String(f).toLowerCase().includes(query)),
            )
          : d.agents,
      }))
      .filter((d) => d.agents.length > 0); // empty buckets never render
  }, [marketplace, q]);

  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const startDrag = (e, persona) => {
    if (!canEdit) return;
    const activeLens = lenses.find((l) => l.id === activeLensId) ?? null;
    e.dataTransfer.setData(
      DND_MIME,
      JSON.stringify({
        kind: 'persona',
        personaId: persona.id,
        name: persona.name,
        emoji: persona.emoji ?? null,
        division: persona.division,
        divisionLabel: persona.divisionLabel ?? persona.division,
        version: persona.version ?? personaVersion,
        lensId: activeLens?.id ?? null,
        lensName: activeLens?.name ?? null,
      }),
    );
    e.dataTransfer.effectAllowed = 'copy';
  };

  const updateBadge = updates.find((u) => u.source === 'agency-agents');
  const lensBadge = updates.find((u) => u.source === 'nuwa-skill');
  const shortRef = (v) => (v ? (v.startsWith('bundle-') ? 'bundle' : `${v.slice(0, 7)}…`) : '—');

  return (
    <aside className="marketplace">
      <header className="marketplace-head">
        <h2>Agent Marketplace</h2>
        {updateBadge && (
          <span className={`ver-badge ${updateBadge.ok ? 'ok' : 'stale'}`} title={`Pinned catalog version (${updateBadge.status})`}>
            📦 {shortRef(updateBadge.version)}
          </span>
        )}
      </header>

      {error && <p className="empty">Marketplace unavailable: {error}</p>}
      {!marketplace && !error && <p className="empty">Loading marketplace…</p>}

      {marketplace && (
        <>
          <input
            type="text"
            className="market-search"
            placeholder="Search personas…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search personas"
          />
          {!canEdit && <p className="readonly-note">Viewer — marketplace is read-only.</p>}

          <nav className="division-list" aria-label="Personas by division">
            {filtered.map((div) => (
              <section key={div.id} className="division">
                <button type="button" className="division-head" onClick={() => toggle(div.id)} aria-expanded={open.has(div.id)}>
                  <span className="division-caret">{open.has(div.id) ? '▾' : '▸'}</span>
                  <span className="division-name">{div.label}</span>
                  <span className="division-count">{div.agents.length}</span>
                </button>
                {open.has(div.id) && (
                  <ul className="persona-list">
                    {div.agents.map((a) => (
                      <li key={a.id}>
                        <div
                          className={`persona-card ${canEdit ? 'draggable' : ''}`}
                          draggable={canEdit}
                          onDragStart={(e) => startDrag(e, a)}
                          title={canEdit ? `Drag onto the canvas to add “${a.name}” as an agent node` : a.description}
                        >
                          <div className="persona-line">
                            <span className="persona-emoji">{a.emoji ?? '🤖'}</span>
                            <strong className="persona-name">{a.name}</strong>
                          </div>
                          <p className="persona-desc">{a.description}</p>
                          {a.tools?.length > 0 && (
                            <div className="tool-tags">
                              {a.tools.map((t) => (
                                <span key={t} className="tool-tag">{t}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </nav>

          {/* --- Cognitive Lens selector ------------------------------------ */}
          <section className="lens-section">
            <header className="lens-head">
              <h3>Cognitive Lens</h3>
              {lensBadge && (
                <span className={`ver-badge ${lensBadge.ok ? 'ok' : 'stale'}`} title={`Pinned nuwa-skill version (${lensBadge.status})`}>
                  🔭 {shortRef(lensBadge.version)}
                </span>
              )}
            </header>
            <p className="lens-hint">
              {activeLensId
                ? `New agent nodes will wear “${lenses.find((l) => l.id === activeLensId)?.name ?? activeLensId}”.`
                : 'Pick a perspective — new agent nodes will wear it as their system lens.'}
            </p>
            <ul className="lens-list">
              {lenses.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className={`lens-row ${l.id === activeLensId ? 'active' : ''}`}
                    onClick={() => onSelectLens(l.id === activeLensId ? null : l.id)}
                    title={l.description}
                  >
                    <span className="lens-name">{l.name}</span>
                    {l.fidelity && <span className="lens-fid" title="FIDELITY scorecard attached">♟</span>}
                  </button>
                  {expandedLens === l.id && (
                    <details open className="lens-detail">
                      <summary onClick={(e) => { e.preventDefault(); setExpandedLens(null); }}>hide</summary>
                      <p>{l.description}</p>
                      {l.fidelity && <pre className="config lens-fidelity">{l.fidelity.slice(0, 1200)}</pre>}
                    </details>
                  )}
                  {l.id === activeLensId && expandedLens !== l.id && (
                    <button type="button" className="lens-expand" onClick={() => setExpandedLens(l.id)}>
                      show body &amp; fidelity
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* "Add" affordance for non-drag users */}
          {canEdit && (
            <p className="market-hint">Drag a persona onto the canvas — the node embeds its immutable persona_id.</p>
          )}
        </>
      )}
    </aside>
  );
}

export { DND_MIME };
