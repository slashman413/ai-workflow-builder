/**
 * catalogParsers.test.js — the pure domain parsers for the ecosystem catalogs.
 *
 * Fixtures mirror the REAL upstream formats verified on disk:
 *   - agency-agents: divisions.json ({ divisions: { id: {label,icon,color} } }),
 *     tools.json (flat map keyed by tool id), <division>/<slug>.md personas
 *     with YAML frontmatter (name, description, color, emoji, vibe, tools).
 *   - nuwa-skill: SKILL.md (meta), references/fidelity-scorecard.md,
 *     examples/<name>/SKILL.md (+ FIDELITY.md for some).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgencyAgents, parsePersona, splitFrontmatter, EXCLUDED_DIRS } from '../src/domain/catalog/agencyAgents.js';
import { parseNuwaSkill, lensId } from '../src/domain/catalog/nuwaSkill.js';
import { validateAgencyAgents, validateNuwaSkill, fitsPayloadLimit, LIMITS } from '../src/domain/catalog/validate.js';

const AGENT_SAMPLE = `---
name: Backend Architect
description: Senior backend architect specializing in scalable system design.
color: blue
emoji: 🏗️
vibe: Designs the systems that hold everything up.
tools: [python, github, supabase]
---

# Backend Architect Agent Personality

You are **Backend Architect**...
`;

test('splitFrontmatter extracts YAML frontmatter and body', () => {
  const { frontmatter, body } = splitFrontmatter(AGENT_SAMPLE);
  assert.equal(frontmatter.name, 'Backend Architect');
  assert.equal(frontmatter.color, 'blue');
  assert.ok(body.startsWith('# Backend Architect'));
});

test('splitFrontmatter tolerates files without frontmatter', () => {
  const { frontmatter, body } = splitFrontmatter('# Plain README\nno frontmatter here');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, '# Plain README\nno frontmatter here');
});

test('parsePersona builds a stable id and keeps tools as tags', () => {
  const persona = parsePersona(AGENT_SAMPLE, { division: 'engineering', slug: 'backend-architect', version: 'abc123' });
  assert.equal(persona.id, 'agency-agents:engineering/backend-architect');
  assert.equal(persona.division, 'engineering');
  assert.deepEqual(persona.tools, ['python', 'github', 'supabase']);
  assert.equal(persona.version, 'abc123');
});

test('parsePersona returns null for non-persona files (no frontmatter/body)', () => {
  assert.equal(parsePersona('# Playbook\nno frontmatter', { division: 'strategy', slug: 'x' }), null);
});

test('parseAgencyAgents walks division dirs, excludes non-division dirs', () => {
  const files = {
    'divisions.json': JSON.stringify({
      divisions: {
        engineering: { label: 'Engineering', icon: 'Code', color: '#3B82F6' },
        design: { label: 'Design', icon: 'PenTool', color: '#EC4899' },
      },
    }),
    'tools.json': JSON.stringify({
      python: { label: 'Python' },
      github: { label: 'GitHub' },
    }),
    'engineering/engineering-backend-architect.md': AGENT_SAMPLE,
    'design/design-product-designer.md': AGENT_SAMPLE,
    'scripts/convert.sh.md': AGENT_SAMPLE, // excluded dir → must be ignored
    'README.md': 'not a persona', // not <division>/<slug>.md → ignored
  };
  const catalog = parseAgencyAgents(files, { version: 'sha123' });
  assert.equal(catalog.agents.length, 2);
  assert.ok(catalog.agents.every((a) => !EXCLUDED_DIRS.has(a.division)));
  const eng = catalog.agents.find((a) => a.division === 'engineering');
  assert.equal(eng.divisionLabel, 'Engineering'); // label decorated from divisions.json
  assert.equal(catalog.tools.length, 2);
  assert.equal(catalog.version, 'sha123');
});

test('validateAgencyAgents rejects broken catalogs (missing fields, oversized)', () => {
  const good = {
    source: 'agency-agents', version: 'v1', syncedAt: new Date().toISOString(),
    divisions: [{ id: 'engineering', label: 'Engineering' }],
    tools: [{ id: 'python', label: 'Python' }],
    agents: [{ id: 'a:1', source: 'agency-agents', version: 'v1', division: 'engineering', name: 'A', description: 'd', body: 'b', tools: [] }],
  };
  assert.equal(validateAgencyAgents(good).ok, true);

  const broken = {
    ...good,
    agents: [
      { id: 'a:1', division: 'engineering', name: '', description: 'd', body: 'b', tools: [] }, // no name
      { id: 'a:2', division: 'engineering', name: 'B', description: 'x'.repeat(LIMITS.maxDescriptionLength + 10), body: 'b', tools: [] },
      { id: 'a:1', division: 'engineering', name: 'C', description: 'd', body: 'b', tools: [] }, // duplicate id
    ],
  };
  const result = validateAgencyAgents(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('name is missing')));
  assert.ok(result.errors.some((e) => e.includes('duplicate agent id')));
});

const LENS_SAMPLE = `---
name: munger-perspective
description: 查理·芒格的思维框架。逆向思考、认知偏误、跨学科分析。
---

# 查理·芒格 · 思维操作系统

## 核心心智模型
1. 多元思维模型
2. 逆向思考
`;

test('parseNuwaSkill distills the meta skill + example perspectives into lenses', () => {
  const files = {
    'SKILL.md': LENS_SAMPLE,
    'references/fidelity-scorecard.md': '# 保真度评分卡\nrubric text',
    'examples/munger-perspective/SKILL.md': LENS_SAMPLE,
    'examples/munger-perspective/FIDELITY.md': '# 保真度\n88/100',
    'examples/feynman-perspective/SKILL.md': LENS_SAMPLE,
    'examples/notes.md': 'ignored', // not in a lens dir
  };
  const catalog = parseNuwaSkill(files, { version: 'sha456' });
  assert.equal(catalog.lenses.length, 3); // meta distiller + munger + feynman
  const munger = catalog.lenses.find((l) => l.id === lensId('munger-perspective'));
  assert.ok(munger);
  assert.equal(munger.fidelity, '# 保真度\n88/100');
  const distiller = catalog.lenses.find((l) => l.id === lensId('skill-distiller'));
  assert.ok(distiller);
  assert.equal(distiller.name, 'Nuwa Skill Distiller');
  assert.ok(distiller.fidelity.includes('评分卡')); // rubric attached to the distiller
});

test('validateNuwaSkill rejects empty or malformed lens catalogs', () => {
  assert.equal(validateNuwaSkill({ source: 'nuwa-skill', version: 'v1', syncedAt: '', lenses: [] }).ok, true);
  const bad = {
    source: 'nuwa-skill', version: 'v1', syncedAt: '',
    lenses: [{ id: 'nuwa-skill:x', name: '', description: '', body: '' }],
  };
  assert.equal(validateNuwaSkill(bad).ok, false);
});

test('fitsPayloadLimit bounds the whole catalog JSON', () => {
  assert.equal(fitsPayloadLimit({ agents: [] }), true);
  const huge = { lenses: [{ body: 'x'.repeat(LIMITS.maxPayloadBytes) }] };
  assert.equal(fitsPayloadLimit(huge), false);
});
