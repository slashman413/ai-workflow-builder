import React, { useState } from 'react';

/** Feature 1: the simple prompt input that starts everything. */
export function PromptInput({ onSubmit }) {
  const [value, setValue] = useState('');
  return (
    <section className="card">
      <h2>1. Describe what you want</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <textarea
          rows={3}
          placeholder="e.g. Summarise my unread emails into a morning digest"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Prompt"
        />
        <button type="submit" disabled={!value.trim()}>
          Grill me →
        </button>
      </form>
    </section>
  );
}
