/**
 * nuwaSkill.js — pure parser for the nuwa-skill cognitive-lens catalog.
 *
 * Upstream: alchaincyf/nuwa-skill (MIT, ~29.4k stars). The repo layout:
 *
 *   SKILL.md                      → the meta-skill ("女娲 · Skill造人术"):
 *                                   YAML frontmatter (name, description) +
 *                                   the distillation methodology body.
 *   references/                   → skill-template.md, extraction-framework.md,
 *                                   fidelity-scorecard.md (the FIDELITY rubric).
 *   examples/<person>-perspective/
 *       SKILL.md                  → one distilled perspective skill per person
 *                                   (munger, feynman, naval, …): frontmatter +
 *                                   the thinking-operating-system body.
 *       FIDELITY.md               → the per-skill fidelity scorecard.
 *       references/               → research notes (ignored for lenses).
 *
 * Every skill file becomes a candidate **system-prompt lens**: name +
 * description (the trigger contract) + body (the role-playing rules, mental
 * models, decision heuristics, expression DNA, honesty boundaries). The
 * meta-skill and the fidelity rubric become the "skill distiller" lens so an
 * architect can also ask the system to build a NEW lens from a person.
 *
 * Pure module: `parseNuwaSkill(files, { version })` takes a map of relative
 * path → text and returns a validated lens catalog.
 */

import { splitFrontmatter } from './agencyAgents.js';

const EXAMPLE_DIR = 'examples/';

/** Lens id for a perspective skill slug. */
export const lensId = (slug, source = 'nuwa-skill') => `${source}:${slug}`;

/**
 * Parse one perspective skill directory.
 * @param {Record<string,string>} files  The full checkout file map.
 * @param {string} dir  e.g. 'examples/munger-perspective' or '.' for root.
 * @param {{ version?: string, source?: string }} opts
 * @returns {object|null} Lens record.
 */
export function parseLensSkill(files, dir, { version = '', source = 'nuwa-skill' } = {}) {
  const skillPath = dir === '.' ? 'SKILL.md' : `${dir}/SKILL.md`;
  const skillText = files[skillPath];
  if (!skillText) return null;
  const slug = dir.replace(/^examples\//, '');
  const { frontmatter, body } = splitFrontmatter(skillText);
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : slug;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description || !body.trim()) return null;

  const fidelityPath = `${dir}/FIDELITY.md`;
  const fidelity = files[fidelityPath] ? String(files[fidelityPath]) : null;

  return {
    id: lensId(slug, source),
    source,
    version,
    slug,
    name,
    description,
    body,
    fidelity,
  };
}

/**
 * Parse a whole nuwa-skill checkout into a validated lens catalog.
 *
 * @param {Record<string,string>} files  Relative path → text.
 * @param {{ version?: string, source?: string }} [opts]
 * @returns {{ source: string, version: string, syncedAt: string, lenses: object[] }}
 */
export function parseNuwaSkill(files, { version = '', source = 'nuwa-skill' } = {}) {
  const lenses = [];

  // 1. The meta-skill itself (SKILL.md at the repo root).
  const meta = parseLensSkill(files, '.', { version, source });
  if (meta) {
    // FIDELITY instructions live in references/fidelity-scorecard.md — attach
    // the rubric to the distiller lens so it can grade its own output.
    meta.id = lensId('skill-distiller', source);
    meta.slug = 'skill-distiller';
    meta.name = 'Nuwa Skill Distiller';
    const scorecard = files['references/fidelity-scorecard.md'];
    if (scorecard) meta.fidelity = scorecard;
    meta._metaSkill = true;
    lenses.push(meta);
  }

  // 2. The distilled perspective skills under examples/<name>/.
  for (const [path] of Object.entries(files)) {
    if (!path.startsWith(EXAMPLE_DIR) || !path.endsWith('/SKILL.md')) continue;
    const dir = path.replace(/\/SKILL\.md$/, '');
    const lens = parseLensSkill(files, dir, { version, source });
    if (lens) lenses.push(lens);
  }

  lenses.sort((a, b) => a.name.localeCompare(b.name));
  return { source, version, syncedAt: new Date().toISOString(), lenses };
}
