/**
 * schema.js — strict validators for the ecosystem catalog records.
 *
 * The upstream mirrors (agency-agents, nuwa-skill) are community repositories
 * with organic formatting: fields drift, emoji creep in, frontmatter blocks
 * go missing. The ingestion engine treats their content as *untrusted input*
 * and runs every record through these validators before anything reaches the
 * database. A record that fails validation is skipped and counted, never
 * partially persisted — the snapshot swap is all-or-nothing (see
 * CatalogService), which is what lets us keep serving the last-known-good
 * snapshot when upstream breaks.
 *
 * All validators are PURE functions of their input; no I/O, no state.
 */

/** Required frontmatter fields per record kind, with their expected JS types. */
const PERSONA_FIELDS = {
  name: 'string',
  description: 'string',
  emoji: 'string',
  color: 'string',
  vibe: 'string',
  tools: 'array',
};

const LENS_FIELDS = {
  name: 'string',
  description: 'string',
};

/** Validate one normalized persona record. Returns { ok, errors }. */
export function validatePersona(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { ok: false, errors: ['record is not an object'] };
  }
  for (const [field, type] of Object.entries(PERSONA_FIELDS)) {
    const value = record[field];
    if (value === undefined || value === null || value === '') {
      if (field === 'name' || field === 'description') {
        errors.push(`missing required field "${field}"`);
      }
      continue;
    }
    if (type === 'array' && !Array.isArray(value)) {
      errors.push(`field "${field}" must be an array`);
    } else if (type === 'string' && typeof value !== 'string') {
      errors.push(`field "${field}" must be a string`);
    }
  }
  if (typeof record.slug !== 'string' || !record.slug.trim()) {
    errors.push('missing or empty "slug"');
  }
  if (typeof record.division !== 'string' || !record.division.trim()) {
    errors.push('missing or empty "division"');
  }
  if (typeof record.body !== 'string' || record.body.trim().length === 0) {
    errors.push('missing or empty markdown "body"');
  }
  if (record.tools !== undefined && !Array.isArray(record.tools)) {
    errors.push('field "tools" must be an array of tool ids');
  } else if (Array.isArray(record.tools) && record.tools.some((t) => typeof t !== 'string')) {
    errors.push('field "tools" must contain only strings');
  }
  return { ok: errors.length === 0, errors };
}

/** Validate one normalized lens record. Returns { ok, errors }. */
export function validateLens(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { ok: false, errors: ['record is not an object'] };
  }
  for (const [field, type] of Object.entries(LENS_FIELDS)) {
    const value = record[field];
    if (value === undefined || value === null || value === '') {
      if (field === 'name' || field === 'description') {
        errors.push(`missing required field "${field}"`);
      }
      continue;
    }
    if (type === 'string' && typeof value !== 'string') {
      errors.push(`field "${field}" must be a string`);
    }
  }
  if (typeof record.slug !== 'string' || !record.slug.trim()) {
    errors.push('missing or empty "slug"');
  }
  if (typeof record.body !== 'string' || record.body.trim().length === 0) {
    errors.push('missing or empty markdown "body"');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate the divisions.json payload. Returns
 * { ok, divisions: Map<divisionId, {label, icon, color}> }.
 * A division entry must be an object carrying a display label; icon/color are
 * presentation hints and default gracefully.
 */
export function validateDivisions(raw) {
  if (!raw || typeof raw !== 'object' || !raw.divisions || typeof raw.divisions !== 'object') {
    return { ok: false, divisions: new Map(), errors: ['divisions.json missing "divisions" object'] };
  }
  const divisions = new Map();
  const errors = [];
  for (const [id, meta] of Object.entries(raw.divisions)) {
    if (!meta || typeof meta !== 'object') {
      errors.push(`division "${id}" has no metadata object`);
      continue;
    }
    if (typeof meta.label !== 'string' || !meta.label.trim()) {
      errors.push(`division "${id}" missing display label`);
      continue;
    }
    divisions.set(id, {
      label: meta.label,
      icon: typeof meta.icon === 'string' ? meta.icon : 'Boxes',
      color: typeof meta.color === 'string' ? meta.color : '#64748B',
    });
  }
  return { ok: errors.length === 0, divisions, errors };
}

/**
 * Validate the tools.json payload. Returns
 * { ok, tools: Map<toolId, {label, short}> }.
 * Tools are only used to decorate persona permission tags, so a malformed
 * entry degrades to the raw id rather than failing the whole sync.
 */
export function validateTools(raw) {
  if (!raw || typeof raw !== 'object' || !raw.tools || typeof raw.tools !== 'object') {
    return { ok: false, tools: new Map(), errors: ['tools.json missing "tools" object'] };
  }
  const tools = new Map();
  for (const [id, meta] of Object.entries(raw.tools)) {
    if (!meta || typeof meta !== 'object') continue;
    tools.set(id, {
      label: typeof meta.label === 'string' && meta.label ? meta.label : id,
      short: typeof meta.short === 'string' && meta.short ? meta.short : id,
    });
  }
  return { ok: true, tools, errors: [] };
}
