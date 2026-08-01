/**
 * schema.js - strict schema validation for catalog records.
 *
 * Used by the ingestion pipeline to validate parsed persona and lens records
 * before they reach persistence. Each record type has its own validator that
 * returns { ok: boolean, errors?: string[] }.
 */

/**
 * Validate a persona record.
 * @param {object} record
 * @returns {{ ok: boolean, errors?: string[] }}
 */
export function validatePersona(record) {
  const errors = [];

  if (!record.slug || typeof record.slug !== 'string' || record.slug.trim().length === 0) {
    errors.push('slug is required and must be a non-empty string');
  }
  if (!record.division || typeof record.division !== 'string' || record.division.trim().length === 0) {
    errors.push('division is required');
  }
  if (!record.name || typeof record.name !== 'string' || record.name.trim().length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  if (!record.description || typeof record.description !== 'string' || record.description.trim().length === 0) {
    errors.push('description is required');
  }
  if (!record.body || typeof record.body !== 'string' || record.body.trim().length === 0) {
    errors.push('body is required');
  }
  if (record.tools !== undefined && !Array.isArray(record.tools)) {
    errors.push('tools must be an array');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a lens record.
 * @param {object} record
 * @returns {{ ok: boolean, errors?: string[] }}
 */
export function validateLens(record) {
  const errors = [];

  if (!record.slug || typeof record.slug !== 'string' || record.slug.trim().length === 0) {
    errors.push('slug is required and must be a non-empty string');
  }
  if (!record.name || typeof record.name !== 'string' || record.name.trim().length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  if (!record.description || typeof record.description !== 'string' || record.description.trim().length === 0) {
    errors.push('description is required');
  }
  if (!record.body || typeof record.body !== 'string' || record.body.trim().length === 0) {
    errors.push('body is required');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate divisions.json structure.
 * @param {object} raw
 * @returns {{ ok: boolean, divisions?: Map<string, object>, errors?: string[] }}
 */
export function validateDivisions(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || !raw.divisions || typeof raw.divisions !== 'object') {
    return { ok: false, errors: ['divisions.json must contain a "divisions" object'] };
  }

  const divisions = new Map();
  for (const [id, meta] of Object.entries(raw.divisions)) {
    if (!meta || typeof meta !== 'object') {
      errors.push(`division "${id}": must be an object`);
      continue;
    }
    if (!meta.label || typeof meta.label !== 'string' || meta.label.trim().length === 0) {
      errors.push(`division "${id}": missing or empty "label"`);
      continue;
    }
    divisions.set(id, {
      id,
      label: meta.label,
      icon: typeof meta.icon === 'string' ? meta.icon : null,
      color: typeof meta.color === 'string' ? meta.color : null,
    });
  }

  return errors.length === 0
    ? { ok: true, divisions }
    : { ok: false, errors };
}

/**
 * Validate tools.json structure. Malformed entries degrade (are skipped),
 * they do not fail the whole catalog.
 * @param {object} raw
 * @returns {{ ok: boolean, tools?: Map<string, object>, errors?: string[] }}
 */
export function validateTools(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || !raw.tools || typeof raw.tools !== 'object') {
    return { ok: false, errors: ['tools.json must contain a "tools" object'] };
  }

  const tools = new Map();
  for (const [id, meta] of Object.entries(raw.tools)) {
    if (!meta || typeof meta !== 'object') {
      errors.push(`tool "${id}": malformed entry, skipping`);
      continue;
    }
    tools.set(id, {
      id,
      label: typeof meta.label === 'string' ? meta.label : id,
      short: typeof meta.short === 'string' ? meta.short : null,
      icon: typeof meta.icon === 'string' ? meta.icon : null,
    });
  }

  return errors.length === 0
    ? { ok: true, tools }
    : { ok: true, tools, warnings: errors };
}
