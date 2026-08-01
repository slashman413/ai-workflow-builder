#!/usr/bin/env node
/**
 * secret-scan.mjs — pre-GA secret scanning gate (Increment 4).
 *
 * Scans the working tree (excluding node_modules, .git, dist, coverage)
 * for high-signal secret patterns. Every hit is reported with file:line so
 * the operator can triage immediately. Exit code 1 when any HIGH-severity
 * pattern is found — wire into CI as a hard gate.
 *
 * This is a heuristic first pass, not a replacement for gitleaks/trufflehog
 * in the deploy pipeline — but it catches the 95% case (a committed key)
 * with zero dependencies.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const EXCLUDED = new Set([
  'node_modules', '.git', 'dist', 'coverage', '.next', 'build', '.cache', 'target',
]);

/** name → { regex, severity, hint } — ordered so longer markers match first. */
const PATTERNS = [
  { name: 'Stripe live secret', sev: 'HIGH', re: /sk_live_[0-9a-zA-Z]{16,}/g, hint: 'revoke + rotate; use STRIPE_SECRET_KEY env' },
  { name: 'Stripe restricted', sev: 'HIGH', re: /rk_live_[0-9a-zA-Z]{16,}/g, hint: 'revoke + rotate' },
  { name: 'AWS access key', sev: 'HIGH', re: /\bAKIA[0-9A-Z]{16}\b/g, hint: 'revoke in IAM' },
  { name: 'AWS secret', sev: 'HIGH', re: /(aws_secret_access_key|AWS_SECRET)\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/g, hint: 'rotate in IAM' },
  { name: 'GitHub PAT', sev: 'HIGH', re: /ghp_[0-9A-Za-z]{36,}/g, hint: 'revoke; use OAuth with repo scope' },
  { name: 'GitHub fine-grained', sev: 'HIGH', re: /github_pat_[0-9A-Za-z_]{22,}/g, hint: 'revoke in GitHub settings' },
  { name: 'OpenAI key', sev: 'HIGH', re: /sk-proj-[0-9A-Za-z_-]{20,}/g, hint: 'rotate; use the vault' },
  { name: 'Anthropic key', sev: 'HIGH', re: /sk-ant-[0-9A-Za-z_-]{20,}/g, hint: 'rotate' },
  { name: 'Private key block', sev: 'HIGH', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, hint: 'move to secrets manager' },
  { name: 'Clerk secret', sev: 'MEDIUM', re: /sk_test_[0-9A-Za-z_]{20,}/g, hint: 'test key — still rotate if committed' },
  { name: 'Google API key', sev: 'MEDIUM', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, hint: 'restrict + rotate' },
  { name: 'Slack token', sev: 'MEDIUM', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, hint: 'rotate' },
  { name: 'Generic secret assignment', sev: 'LOW', re: /(PASSWORD|PASSWD|SECRET|TOKEN)\s*[=:]\s*["'][^"']{8,}["']/gi, hint: 'verify it is a placeholder' },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (stat.size < 2_000_000) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary
  }
  const rel = relative(ROOT, file);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      const m = p.re.exec(line);
      if (m) {
        findings.push({ file: rel, line: i + 1, sev: p.sev, name: p.name, hint: p.hint, match: m[0].slice(0, 24) + '…' });
      }
    }
  }
}

const bySev = { HIGH: 0, MEDIUM: 0, LOW: 0 };
for (const f of findings) bySev[f.sev] += 1;
console.log(`secret-scan: ${findings.length} finding(s) — HIGH ${bySev.HIGH}, MEDIUM ${bySev.MEDIUM}, LOW ${bySev.LOW}`);
for (const f of findings) {
  console.log(`  [${f.sev}] ${f.file}:${f.line} ${f.name} (${f.match}) — ${f.hint}`);
}
process.exit(bySev.HIGH > 0 ? 1 : 0);
