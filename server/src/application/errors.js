/**
 * errors.js — application-level errors and the tenant-identity guard.
 *
 * AppError carries an HTTP-friendly status code so the HTTP adapter can map
 * it straight to a response without any layer-specific knowledge. It is the
 * single error type the service layer throws; see routes.js.
 */

/** Domain/application error carrying an HTTP-friendly status + details. */
export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Defense-in-depth tenant guard. Every service method takes an orgId; if a
 * caller ever fails to provide one (a controller bug, a future code path, a
 * route mounted without the auth choke point), the request is rejected here
 * rather than silently landing in the empty tenant.
 */
export function assertOrg(orgId) {
  if (typeof orgId !== 'string' || orgId.trim() === '') {
    throw new AppError('ORG_REQUIRED', 'Request is not bound to an organization.', 403);
  }
}
