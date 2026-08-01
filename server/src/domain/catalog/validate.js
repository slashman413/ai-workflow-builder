/**
 * validate.js — validation rules for ecosystem catalog payloads.
 *
 * The nightly sync pipeline treats upstream content as untrusted input: the
 * GitHub tarballs are fetched, parsed, and ONLY written into the database
 * when this module says the payload is structurally sound. A repo that
 * renames files, ships a truncated file, or gets vandalized therefore fails
 * validation here and the sync aborts — the last-good snapshot stays
 * installed (see CatalogService).
 *
 * Rules are deliberately conservative: bounded counts, bounded field sizes,
 * required text fields, and stable id shapes. Everything the UI renders
 * passes through here first.
 */

/** Hard caps — chosen an order of magnitude above today's upstreams. */
const LIMITS = Object.freeze({
  maxAgents: 5000,
  maxLenses: 2000,
  maxDivisions: 200,
  maxTools: 500,
  maxIdLength: 128,
  maxNameLength: 200,
  maxDescriptionLength: 4000,
  maxBodyLength: 500_000, // full markdown personality / skill body
  maxVibeLength: 1000, // upstream vibes run up to ~760 chars; keep headroom
  maxColorLength: 32,
  maxEmojiLength: 16,
  maxToolTagLength: 64,
  maxPayloadBytes: 30_000_000, // whole catalog JSON, one source
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Collect violations into `errors`; returns true when the check passed. */
function check(condition, errors, message) {
  if (!condition) errors.push(message);
  return Boolean(condition);
}

/**
 * Validate a parsed agency-agents catalog.
 * @param {object} catalog  Result of parseAgencyAgents (see agencyAgents.js).
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAgencyAgents(catalog) {
  const errors = [];
  check(isPlainObject(catalog), errors, 'catalog must be an object');
  if (!isPlainObject(catalog)) return { ok: false, errors };

  check(Array.isArray(catalog.divisions), errors, 'divisions must be an array');
  check(Array.isArray(catalog.tools), errors, 'tools must be an array');
  check(Array.isArray(catalog.agents), errors, 'agents must be an array');
  if (!Array.isArray(catalog.divisions) || !Array.isArray(catalog.tools) || !Array.isArray(catalog.agents)) {
    return { ok: false, errors };
  }

  check(catalog.divisions.length <= LIMITS.maxDivisions, errors, `too many divisions (${catalog.divisions.length} > ${LIMITS.maxDivisions})`);
  check(catalog.tools.length <= LIMITS.maxTools, errors, `too many tools (${catalog.tools.length} > ${LIMITS.maxTools})`);
  check(catalog.agents.length <= LIMITS.maxAgents, errors, `too many agents (${catalog.agents.length} > ${LIMITS.maxAgents})`);

  const divisionIds = new Set();
  for (const div of catalog.divisions) {
    const idOk = isNonEmptyString(div.id, LIMITS.maxIdLength);
    const labelOk = isNonEmptyString(div.label, LIMITS.maxNameLength);
    check(idOk && labelOk, errors, `invalid division entry: ${JSON.stringify(div).slice(0, 120)}`);
    if (idOk) divisionIds.add(div.id);
    if (div.icon != null && !isNonEmptyString(div.icon, 64)) errors.push(`division ${div.id}: icon must be a short string`);
    if (div.color != null && !isNonEmptyString(div.color, LIMITS.maxColorLength)) errors.push(`division ${div.id}: color must be a short string`);
  }

  const toolIds = new Set();
  for (const tool of catalog.tools) {
    const idOk = isNonEmptyString(tool.id, LIMITS.maxToolTagLength);
    const labelOk = isNonEmptyString(tool.label, LIMITS.maxNameLength);
    check(idOk && labelOk, errors, `invalid tool entry: ${JSON.stringify(tool).slice(0, 120)}`);
    if (idOk) toolIds.add(tool.id);
  }

  const seenIds = new Set();
  for (const agent of catalog.agents) {
    if (!isPlainObject(agent)) { errors.push('agent entry is not an object'); continue; }
    const idOk = isNonEmptyString(agent.id, LIMITS.maxIdLength);
    const nameOk = isNonEmptyString(agent.name, LIMITS.maxNameLength);
    const descOk = isNonEmptyString(agent.description, LIMITS.maxDescriptionLength);
    const bodyOk = isNonEmptyString(agent.body, LIMITS.maxBodyLength);
    const divisionOk = isNonEmptyString(agent.division, LIMITS.maxIdLength);

    if (!idOk) errors.push('agent with missing/oversized id');
    else if (seenIds.has(agent.id)) errors.push(`duplicate agent id "${agent.id}"`);
    seenIds.add(agent.id);

    if (!nameOk) errors.push(`agent ${agent.id ?? '?'}: name is missing or oversized`);
    if (!descOk) errors.push(`agent ${agent.id ?? '?'}: description is missing or oversized`);
    if (!bodyOk) errors.push(`agent ${agent.id ?? '?'}: body is missing or oversized`);
    if (!divisionOk) errors.push(`agent ${agent.id ?? '?'}: division is missing or oversized`);
    if (agent.vibe != null && !isNonEmptyString(agent.vibe, LIMITS.maxVibeLength)) {
      errors.push(`agent ${agent.id ?? '?'}: vibe is oversized`);
    }
    if (agent.color != null && !isNonEmptyString(agent.color, LIMITS.maxColorLength)) {
      errors.push(`agent ${agent.id ?? '?'}: color is oversized`);
    }
    if (agent.emoji != null && !isNonEmptyString(agent.emoji, LIMITS.maxEmojiLength)) {
      errors.push(`agent ${agent.id ?? '?'}: emoji is oversized`);
    }
    if (!Array.isArray(agent.tools)) {
      errors.push(`agent ${agent.id ?? '?'}: tools must be an array`);
    } else if (agent.tools.some((t) => typeof t !== 'string' || t.length > LIMITS.maxToolTagLength)) {
      errors.push(`agent ${agent.id ?? '?'}: tools contains invalid tag(s)`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a parsed nuwa-skill lens catalog.
 * @param {object} catalog  Result of parseNuwaSkill (see nuwaSkill.js).
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateNuwaSkill(catalog) {
  const errors = [];
  check(isPlainObject(catalog), errors, 'catalog must be an object');
  if (!isPlainObject(catalog)) return { ok: false, errors };

  check(Array.isArray(catalog.lenses), errors, 'lenses must be an array');
  if (!Array.isArray(catalog.lenses)) return { ok: false, errors };

  check(catalog.lenses.length <= LIMITS.maxLenses, errors, `too many lenses (${catalog.lenses.length} > ${LIMITS.maxLenses})`);

  const seenIds = new Set();
  for (const lens of catalog.lenses) {
    if (!isPlainObject(lens)) { errors.push('lens entry is not an object'); continue; }
    const idOk = isNonEmptyString(lens.id, LIMITS.maxIdLength);
    const nameOk = isNonEmptyString(lens.name, LIMITS.maxNameLength);
    const descOk = isNonEmptyString(lens.description, LIMITS.maxDescriptionLength);
    const bodyOk = isNonEmptyString(lens.body, LIMITS.maxBodyLength);

    if (!idOk) errors.push('lens with missing/oversized id');
    else if (seenIds.has(lens.id)) errors.push(`duplicate lens id "${lens.id}"`);
    seenIds.add(lens.id);

    if (!nameOk) errors.push(`lens ${lens.id ?? '?'}: name is missing or oversized`);
    if (!descOk) errors.push(`lens ${lens.id ?? '?'}: description is missing or oversized`);
    if (!bodyOk) errors.push(`lens ${lens.id ?? '?'}: body is missing or oversized`);
    if (lens.fidelity !== undefined && lens.fidelity !== null && !isNonEmptyString(lens.fidelity, LIMITS.maxBodyLength)) {
      errors.push(`lens ${lens.id ?? '?'}: fidelity is oversized`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Serialize-size guard for the whole payload (JSON length of the catalog). */
export function fitsPayloadLimit(catalog) {
  return JSON.stringify(catalog).length <= LIMITS.maxPayloadBytes;
}

export { LIMITS };
