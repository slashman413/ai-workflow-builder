import React from 'react';

/** PlatformSelector — pick the deploy target (Cloudflare / Fly / Docker). */
const PLATFORMS = [
  { id: 'cloudflare', label: '☁️ Cloudflare Workers' },
  { id: 'fly', label: '🪰 Fly.io' },
  { id: 'docker', label: '🐳 Docker' },
];

export function PlatformSelector({ value, onChange, disabled }) {
  return (
    <div className="platform-selector" role="radiogroup" aria-label="Deploy platform">
      {PLATFORMS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          className={`platform-option ${value === p.id ? 'active' : ''}`}
          onClick={() => onChange(p.id)}
          disabled={disabled}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
