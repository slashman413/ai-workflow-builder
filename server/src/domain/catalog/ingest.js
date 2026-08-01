/**
 * ingest.js - filesystem ingestion pipeline for catalog mirrors.
 *
 * Reads YAML frontmatter from persona files (agency-agents) and SKILL.md
 * files (nuwa-skill), validates them against the schema, and returns parsed
 * records. Used by CatalogService to populate the database.
 *
 * Exports:
 *   parseFrontmatter(text) -> { attrs, body } | null
 *   parsePersonaFile(filename, text) -> persona record | null
 *   parseLensFile(slug, text) -> lens record | null
 *   ingestPersonas(dir, { divisions, tools }) -> { personas, skipped, errors }
 *   ingestLenses(dir) -> { lenses, skipped, errors }
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import YAML from 'yaml';
import { validatePersona, validateLens } from './schema.js';

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown document.
 * @param {string} text
 * @returns {{ attrs: object, body: string } | null}
 */
export function parseFrontmatter(text) {
  const trimmed = String(text);
  if (!trimmed.startsWith('---')) return null;

  // Find closing --- on its own line
  const secondLine = trimmed.indexOf('\n---');
  if (secondLine === -1) return null;

  const raw = trimmed.slice(3, secondLine);
  const body = trimmed.slice(secondLine + 4).replace(/^\n+/, '');

  let attrs;
  try {
    attrs = YAML.parse(raw);
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null;
  } catch {
    return null; // malformed YAML
  }

  return { attrs, body };
}

// ---------------------------------------------------------------------------
// Persona parsing
// ---------------------------------------------------------------------------

/**
 * Parse one persona markdown file.
 * @param {string} filename  e.g. 'engineering-backend-architect.md'
 * @param {string} text
 * @returns {object|null}
 */
export function parsePersonaFile(filename, text) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;

  const { attrs, body } = parsed;
  const slug = basename(filename, '.md');
  const name = typeof attrs.name === 'string' ? attrs.name.trim() : '';
  const description = typeof attrs.description === 'string' ? attrs.description.trim() : '';

  if (!name || !description || !body.trim()) return null;

  const tools = Array.isArray(attrs.tools)
    ? attrs.tools.filter(t => typeof t === 'string' && t.length > 0)
    : [];

  return {
    slug,
    name,
    description,
    body: body.trim(),
    emoji: typeof attrs.emoji === 'string' ? attrs.emoji : null,
    color: typeof attrs.color === 'string' ? attrs.color : null,
    vibe: typeof attrs.vibe === 'string' ? attrs.vibe : null,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Lens parsing
// ---------------------------------------------------------------------------

/**
 * Parse one nuwa-skill perspective file.
 * @param {string} slug  e.g. 'naval-perspective' or 'huashu-nuwa' for root
 * @param {string} text
 * @returns {object|null}
 */
export function parseLensFile(slug, text) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;

  const { attrs, body } = parsed;
  const name = typeof attrs.name === 'string' ? attrs.name.trim() : slug;
  const description = typeof attrs.description === 'string' ? attrs.description.trim() : '';

  if (!description || !body.trim()) return null;

  return {
    slug,
    name,
    description,
    body: body.trim(),
    fidelity: null, // set by ingestLenses when FIDELITY.md exists
  };
}

// ---------------------------------------------------------------------------
// Ingestion helpers
// ---------------------------------------------------------------------------

/**
 * Read a JSON file from the directory root.
 * @param {string} dir
 * @param {string} filename
 * @returns {object | null}
 */
function readJsonFile(dir, filename) {
  try {
    const path = join(dir, filename);
    if (!statSync(path).isFile()) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Ingest all persona files from an agency-agents mirror.
 * @param {string} dir  Path to the mirror root (contains divisions.json, tools.json, <division>/).
 * @param {{ divisions: Map<string, object>, tools: Map<string, object> }} opts
 * @returns {{ personas: object[], skipped: string[], errors: string[] }}
 */
export function ingestPersonas(dir, { divisions, tools }) {
  const personas = [];
  const skipped = [];
  const errors = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (!stat.isDirectory()) continue;

      // Only treat directories that exist in divisions.json as persona divisions
      if (!divisions.has(entry)) {
        skipped.push(entry);
        continue;
      }

      const files = readdirSync(fullPath);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = join(dir, entry, file);
        try {
          const text = readFileSync(filePath, 'utf8');
          const record = parsePersonaFile(file, text);

          if (!record) {
            skipped.push(`${entry}/${file}`);
            continue;
          }

          record.division = entry;

          // Decorate tool tags with upstream labels (e.g. 'python' -> 'Python')
          record.tools = record.tools.map(t => {
            const meta = tools.get(t);
            return meta ? meta.label : t;
          });

          // Validate the record
          const validation = validatePersona(record);
          if (!validation.ok) {
            errors.push(`${entry}/${file}: ${validation.errors.join('; ')}`);
            continue;
          }

          personas.push(record);
        } catch (err) {
          errors.push(`${entry}/${file}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    errors.push(`Failed to read directory ${dir}: ${err.message}`);
  }

  return { personas, skipped, errors };
}

/**
 * Ingest all lens files from a nuwa-skill mirror.
 * @param {string} dir  Path to the nuwa-skill root (contains SKILL.md, examples/, references/).
 * @returns {{ lenses: object[], skipped: string[], errors: string[] }}
 */
export function ingestLenses(dir) {
  const lenses = [];
  const skipped = [];
  const errors = [];

  // 1. Root SKILL.md (the meta-skill / skill-distiller)
  const rootSkillPath = join(dir, 'SKILL.md');
  try {
    if (statSync(rootSkillPath).isFile()) {
      const text = readFileSync(rootSkillPath, 'utf8');
      const parsed = parseFrontmatter(text);
      if (parsed) {
        const { attrs, body } = parsed;
        // Derive slug from name (lowercase, spaces-hyphens)
        const name = typeof attrs.name === 'string' ? attrs.name.trim() : 'nuwa-skill';
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const description = typeof attrs.description === 'string' ? attrs.description.trim() : '';

        if (description && body.trim()) {
          const record = {
            slug,
            name,
            description,
            body: body.trim(),
            fidelity: null,
          };

          // Attach fidelity scorecard if present
          const scorecardPath = join(dir, 'references', 'fidelity-scorecard.md');
          try {
            if (statSync(scorecardPath).isFile()) {
              record.fidelity = readFileSync(scorecardPath, 'utf8');
            }
          } catch {
            // No scorecard - fine
          }

          lenses.push(record);
        } else {
          skipped.push('SKILL.md');
        }
      } else {
        skipped.push('SKILL.md (no frontmatter)');
      }
    }
  } catch (err) {
    errors.push(`Failed to read root SKILL.md: ${err.message}`);
  }

  // 2. Example perspectives under examples/<name>/SKILL.md
  const examplesDir = join(dir, 'examples');
  try {
    if (statSync(examplesDir).isDirectory()) {
      const examples = readdirSync(examplesDir);
      for (const example of examples) {
        const examplePath = join(examplesDir, example);
        if (!statSync(examplePath).isDirectory()) continue;

        const skillPath = join(examplePath, 'SKILL.md');
        try {
          if (!statSync(skillPath).isFile()) {
            skipped.push(`${example}/SKILL.md`);
            continue;
          }

          const text = readFileSync(skillPath, 'utf8');
          const parsed = parseFrontmatter(text);
          if (!parsed) {
            skipped.push(`${example}/SKILL.md (no frontmatter)`);
            continue;
          }

          const { attrs, body } = parsed;
          const name = typeof attrs.name === 'string' ? attrs.name.trim() : example;
          const description = typeof attrs.description === 'string' ? attrs.description.trim() : '';

          if (!description || !body.trim()) {
            skipped.push(`${example}/SKILL.md (empty)`);
            continue;
          }

          const record = {
            slug: example,
            name,
            description,
            body: body.trim(),
            fidelity: null,
          };

          // Check for FIDELITY.md
          const fidelityPath = join(examplePath, 'FIDELITY.md');
          try {
            if (statSync(fidelityPath).isFile()) {
              record.fidelity = readFileSync(fidelityPath, 'utf8');
            }
          } catch {
            // No FIDELITY.md - fine
          }

          // Validate
          const validation = validateLens(record);
          if (!validation.ok) {
            errors.push(`${example}/SKILL.md: ${validation.errors.join('; ')}`);
            continue;
          }

          lenses.push(record);
        } catch (err) {
          errors.push(`${example}/SKILL.md: ${err.message}`);
        }
      }
    }
  } catch (err) {
    errors.push(`Failed to read examples directory: ${err.message}`);
  }

  return { lenses, skipped, errors };
}

// ---------------------------------------------------------------------------
// Convenience readers for divisions/tools.json
// ---------------------------------------------------------------------------

/**
 * Read divisions.json as raw JSON (pre-validation).
 * @param {string} dir
 * @returns {object | null}
 */
export function readDivisions(dir) {
  return readJsonFile(dir, 'divisions.json');
}

/**
 * Read tools.json as raw JSON (pre-validation).
 * @param {string} dir
 * @returns {object | null}
 */
export function readTools(dir) {
  return readJsonFile(dir, 'tools.json');
}