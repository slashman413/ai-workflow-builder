/**
 * agencyAgents.js — pure parser for the agency-agents persona catalog.
 *
 * Upstream: msitarzewski/agency-agents (MIT, ~138k stars); production sync
 * pins the immutable fork slashman413/agency-agents. The repo layout:
 *
 *   divisions.json            → division metadata (id → { label, icon, color })
 *   tools.json                → tool allow-list (id → { label, ... })
 *   <division>/<slug>.md      → one persona per file: YAML frontmatter
 *                               (name, description, color, emoji, vibe)
 *                               + a markdown personality body
 *
 * Non-division top-level directories (scripts/, integrations/, strategy/,
 * examples/, assets/, .github/) are excluded — see EXCLUDED_DIRS. The walker
 * in githubFetcher.js applies the same filter, and this parser defensively
 * ignores any file that does not parse as a persona.
 *
 * This module is pure: `parseAgencyAgents(files, { version })` takes a map
 * of relative path → file text and returns a validated catalog object. No
 * filesystem, no network, no state — unit-testable with fixtures.
 */

import YAML from 'yaml';
import { LIMITS } from './validate.js';

/** Top-level dirs that are not persona divisions. */
export const EXCLUDED_DIRS = new Set([
  'scripts', 'integrations', 'strategy', 'examples', 'assets', '.github',
  'docs', 'tests', 'test', 'tools',
]);

/** Extract `--- yaml ---` frontmatter; returns { frontmatter, body }. */
export function splitFrontmatter(text) {
  const trimmed = String(text);
  if (!trimmed.startsWith('---')) return { frontmatter: {}, body: trimmed };
  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: trimmed };
  const raw = trimmed.slice(3, end);
  const body = trimmed.slice(end + 4).replace(/^\n+/, '');
  let frontmatter = {};
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed;
  } catch {
    frontmatter = {}; // unparseable frontmatter → treat as plain body
  }
  return { frontmatter, body };
}

/**
 * Parse one persona file.
 * @param {string} text File contents.
 * @param {{ division: string, slug: string, source: string, version: string }} ctx
 * @returns {object|null} Persona record, or null when the file is not a persona
 *   (missing frontmatter name/description, or no body).
 */
export function parsePersona(text, { division, slug, source = 'agency-agents', version = '' }) {
  const { frontmatter, body } = splitFrontmatter(text);
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!name || !description || !body.trim()) return null;

  const tools = Array.isArray(frontmatter.tools)
    ? frontmatter.tools.filter((t) => typeof t === 'string' && t.length <= LIMITS.maxToolTagLength)
    : [];

  return {
    id: `${source}:${division}/${slug}`,
    source,
    version,
    division,
    slug,
    name,
    description,
    color: typeof frontmatter.color === 'string' ? frontmatter.color.slice(0, LIMITS.maxColorLength) : null,
    emoji: typeof frontmatter.emoji === 'string' ? frontmatter.emoji.slice(0, LIMITS.maxEmojiLength) : null,
    vibe: typeof frontmatter.vibe === 'string' ? frontmatter.vibe.slice(0, LIMITS.maxVibeLength) : null,
    tools,
    body,
  };
}

/** Parse divisions.json: { divisions: { id: { label, icon, color } } }. */
export function parseDivisions(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const map = data?.divisions;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const out = [];
  for (const [id, meta] of Object.entries(map)) {
    if (!meta || typeof meta !== 'object') continue;
    out.push({
      id,
      label: typeof meta.label === 'string' ? meta.label : id,
      icon: typeof meta.icon === 'string' ? meta.icon : null,
      color: typeof meta.color === 'string' ? meta.color : null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Parse tools.json (object keyed by tool id, array, or a `{tools: {...}}` wrapper). */
export function parseTools(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  // Defensive unwrap: some tooling wraps the map as { tools: { id: meta } }.
  if (data && typeof data === 'object' && !Array.isArray(data) && data.tools && typeof data.tools === 'object' && !Array.isArray(data.tools)) {
    data = data.tools;
  }
  const entries = Array.isArray(data)
    ? data.map((t) => [t?.id ?? t?.name, t])
    : data && typeof data === 'object' && !Array.isArray(data)
      ? Object.entries(data)
      : [];
  const out = [];
  for (const [id, meta] of entries) {
    if (!id || typeof id !== 'string') continue;
    out.push({
      id,
      label: typeof meta?.label === 'string' ? meta.label : id,
      short: typeof meta?.short === 'string' ? meta.short : null,
      icon: typeof meta?.icon === 'string' ? meta.icon : null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Parse a whole agency-agents checkout into a validated catalog.
 *
 * @param {Record<string,string>} files  Relative path → text. Expected keys:
 *   'divisions.json', 'tools.json', '<division>/<slug>.md', …
 * @param {{ version?: string, source?: string }} [opts]
 * @returns {{ source: string, version: string, syncedAt: string,
 *             divisions: object[], tools: object[], agents: object[] }}
 */
export function parseAgencyAgents(files, { version = '', source = 'agency-agents' } = {}) {
  const divisions = parseDivisions(files['divisions.json'] ?? '');
  const divisionById = new Map(divisions.map((d) => [d.id, d]));
  const tools = parseTools(files['tools.json'] ?? '');

  const agents = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.md')) continue;
    const parts = path.split('/');
    if (parts.length !== 2) continue; // only <division>/<slug>.md
    const [division, filename] = parts;
    if (EXCLUDED_DIRS.has(division)) continue;
    const slug = filename.replace(/\.md$/, '');
    const persona = parsePersona(text, { division, slug, source, version });
    if (!persona) continue;
    persona.divisionLabel = divisionById.get(division)?.label ?? division;
    agents.push(persona);
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return {
    source,
    version,
    syncedAt: new Date().toISOString(),
    divisions,
    tools,
    agents,
  };
}
