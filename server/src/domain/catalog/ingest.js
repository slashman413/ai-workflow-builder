/**
 * ingest.js — parse + normalize ecosystem mirror content into catalog records.
 *
 * Two upstream shapes are supported:
 *
 *   agency-agents (personas): one markdown file per persona with a YAML
 *     frontmatter block (name, description, emoji, color, vibe, tools...).
 *     Files live in per-division directories (engineering/, sales/, ...); the
 *     division set itself comes from divisions.json. tools.json decorates the
 *     permission tags.
 *
 *   nuwa-skill (lenses): one SKILL.md per distilled perspective, again with
 *     YAML frontmatter (name, description), optionally accompanied by a
 *     FIDELITY.md. The repository root SKILL.md (huashu-nuwa) is itself a
 *     lens; the examples/{name}/SKILL.md files are the distilled perspectives.
 *
 * Everything here is pure: given paths + text it returns records or skip
 * reasons. Persistence decisions (what counts as a failed sync) live in
 * CatalogService; this module never touches the filesystem itself.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { validatePersona, validateLens } from './schema.js';

/** Split `---`-delimited YAML frontmatter off a markdown document. */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return null;
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const yamlBlock = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n+/, '');
  try {
    const attrs = YAML.parse(yamlBlock);
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null;
    return { attrs, body };
  } catch {
    return null; // malformed YAML — caller counts this as a skip, not a crash
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Coerce a frontmatter attribute to a trimmed string, or undefined. */
function str(attrs, key) {
  const v = attrs?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Parse one agency-agents persona file into a normalized record. Returns
 * null when the file has no usable frontmatter (READMEs, playbooks, etc.).
 */
export function parsePersonaFile(filePath, text) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const { attrs, body } = parsed;
  const slug = filePath.replace(/\.md$/i, '').split(/[\\/]/).pop();
  const tools = Array.isArray(attrs.tools) ? attrs.tools.filter((t) => typeof t === 'string') : [];
  const record = {
    slug,
    name: str(attrs, 'name'),
    description: str(attrs, 'description'),
    emoji: str(attrs, 'emoji'),
    color: str(attrs, 'color'),
    vibe: str(attrs, 'vibe'),
    tools,
    body,
  };
  // Division is filled in by the caller (ingestPersonas) from the directory
  // layout; full strict validation happens there too.
  return record;
}

/**
 * Parse one nuwa-skill SKILL.md into a normalized lens record. Returns null
 * when the file has no usable frontmatter.
 */
export function parseLensFile(filePath, text) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const { attrs, body } = parsed;
  return {
    slug: filePath.replace(/\.md$/i, '').split(/[\\/]/).pop(),
    name: str(attrs, 'name'),
    description: str(attrs, 'description'),
    body,
  };
}

/**
 * Ingest a whole agency-agents mirror directory.
 *
 * @param {string} dir Absolute path of the mirror checkout.
 * @param {object} deps
 * @param {Map<string, {label:string, icon:string, color:string}>} deps.divisions
 *   Division id -> metadata, from divisions.json (only these dirs are scanned).
 * @param {Map<string, {label:string}>} deps.tools  tool id -> metadata.
 * @returns {{ personas: object[], skipped: string[], errors: string[] }}
 *   `personas` are validated, normalized records ready for persistence.
 *   `skipped` lists files that yielded no record (missing/malformed
 *   frontmatter); `errors` lists files that failed strict validation.
 */
export function ingestPersonas(dir, { divisions, tools }) {
  const personas = [];
  const skipped = [];
  const errors = [];

  for (const division of divisions.keys()) {
    const divisionDir = join(dir, division);
    let entries;
    try {
      entries = readdirSync(divisionDir, { withFileTypes: true });
    } catch {
      skipped.push(`${division}/ (directory missing)`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = join(divisionDir, entry.name);
      let text;
      try {
        text = readFileSync(filePath, 'utf8');
      } catch (err) {
        skipped.push(`${division}/${entry.name} (unreadable: ${err.message})`);
        continue;
      }
      const record = parsePersonaFile(entry.name, text);
      if (!record) {
        skipped.push(`${division}/${entry.name} (no frontmatter)`);
        continue;
      }
      record.division = division;
      // Decorate permission tags with upstream tool labels (fall back to id).
      record.tools = record.tools.map((id) => tools.get(id)?.label ?? id);
      const check = validatePersona(record);
      if (!check.ok) {
        errors.push(`${division}/${entry.name} (${check.errors.join('; ')})`);
        continue;
      }
      personas.push(record);
    }
  }
  return { personas, skipped, errors };
}

/**
 * Ingest the cognitive perspective lenses from a nuwa-skill checkout.
 * Lenses = the root SKILL.md plus every examples/{name}/SKILL.md.
 *
 * @param {string} dir Absolute path of the nuwa-skill checkout.
 * @returns {{ lenses: object[], skipped: string[], errors: string[] }}
 */
export function ingestLenses(dir) {
  const lenses = [];
  const skipped = [];
  const errors = [];

  const candidates = [];
  const rootSkill = join(dir, 'SKILL.md');
  if (exists(rootSkill)) candidates.push({ path: rootSkill, slug: 'huashu-nuwa' });

  let examples = [];
  try {
    examples = readdirSync(join(dir, 'examples'), { withFileTypes: true });
  } catch {
    /* no examples dir — root skill only */
  }
  for (const entry of examples) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, 'examples', entry.name, 'SKILL.md');
    if (exists(skillPath)) candidates.push({ path: skillPath, slug: entry.name });
  }

  for (const { path, slug } of candidates) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      skipped.push(`${slug} (unreadable: ${err.message})`);
      continue;
    }
    const record = parseLensFile(slug, text);
    if (!record) {
      skipped.push(`${slug} (no frontmatter)`);
      continue;
    }
    record.slug = slug;
    // FIDELITY.md sits next to each distilled skill when present.
    const fidelityPath = join(path, '..', 'FIDELITY.md');
    if (exists(fidelityPath)) {
      try {
        record.fidelity = readFileSync(fidelityPath, 'utf8');
      } catch {
        record.fidelity = null;
      }
    }
    const check = validateLens(record);
    if (!check.ok) {
      errors.push(`${slug} (${check.errors.join('; ')})`);
      continue;
    }
    lenses.push(record);
  }
  return { lenses, skipped, errors };
}

function exists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read + validate the divisions.json of a mirror (may be absent in tests). */
export function readDivisions(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'divisions.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Read + validate the tools.json of a mirror (may be absent in tests). */
export function readTools(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8'));
  } catch {
    return null;
  }
}
