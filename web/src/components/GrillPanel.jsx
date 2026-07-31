import React, { useState } from 'react';

/**
 * Feature 2: the "grill me" panel. Renders the current batch of clarifying
 * questions, tracks a coverage bar, and only enables "Build" once the spec is
 * ready (though the user can force-build an incomplete spec).
 */
export function GrillPanel({ grill, onSubmit, onBuild }) {
  const [draft, setDraft] = useState({});

  const pct = Math.round((grill.coverage ?? 0) * 100);
  const allAnswered = grill.questions.every((q) => (draft[q.id] ?? '').trim());

  return (
    <section className="card">
      <h2>2. Grill me for a spec</h2>

      <div className="coverage" aria-label={`Spec coverage ${pct}%`}>
        <div className="coverage-bar" style={{ width: `${pct}%` }} />
        <span>{pct}% of critical spec covered</span>
      </div>

      {grill.questions.length === 0 ? (
        <p className="done">No open questions — your spec is ready.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(draft);
            setDraft({});
          }}
        >
          {grill.questions.map((q) => (
            <label key={q.id} className="question">
              <span>
                {q.prompt}
                {q.critical && <em className="req"> *</em>}
              </span>
              <input
                type="text"
                value={draft[q.id] ?? ''}
                onChange={(e) => setDraft({ ...draft, [q.id]: e.target.value })}
              />
            </label>
          ))}
          <button type="submit" disabled={!allAnswered}>
            Save answers
          </button>
        </form>
      )}

      <div className="actions">
        <button className={grill.ready ? 'primary' : 'ghost'} onClick={onBuild}>
          {grill.ready ? '3. Build workflow →' : 'Force build (spec incomplete)'}
        </button>
      </div>
    </section>
  );
}
