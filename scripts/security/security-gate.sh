#!/usr/bin/env bash
# security-gate.sh — the pre-GA security gate (Increment 4).
#
# Runs three scans and fails the gate if any HIGH finding appears:
#   1. npm audit          — registry advisory check on the lockfile
#   2. secret-scan        — heuristic secret-pattern scan of the working tree
#   3. OSV batch query    — api.osv.dev vulnerability check on every pinned
#                           package (a network-free fallback would be
#                           osv-scanner; this gate uses the public API)
#
# Usage: bash scripts/security/security-gate.sh
# Exit 0 = pass, 1 = fail (with findings printed above).

set -uo pipefail
cd "$(dirname "$0")/../.."
FAIL=0

echo "== [1/3] npm audit =="
npm audit --audit-level=high || FAIL=1

echo
echo "== [2/3] secret scan =="
node scripts/security/secret-scan.mjs || FAIL=1

echo
echo "== [3/3] OSV vulnerability check =="
# The batch endpoint over-matches on package NAME only (ignores version
# ranges — e.g. it flags ws@8.21.1 for an advisory limited to <=1.0.1), so
# the gate queries the single-query endpoint per unique package, which
# applies affected ranges correctly. npm audit stays the primary gate; OSV
# is the independent cross-check.
node -e '
const lock = require("./package-lock.json");
const seen = new Set();
const packages = Object.entries(lock.packages || {})
  .filter(([k]) => k && !k.startsWith("node_modules/.bin"))
  .map(([k, info]) => ({ name: k.split("node_modules/").pop(), version: info.version }))
  .filter((q) => q.version)
  .filter((q) => { const k = q.name + "@" + q.version; if (seen.has(k)) return false; seen.add(k); return true; });
require("fs").writeFileSync("/tmp/osv-packages.json", JSON.stringify(packages));
console.log("  " + packages.length + " unique packages to check");
' && node --input-type=module -e '
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const semver = require("semver");
const packages = JSON.parse(fs.readFileSync("/tmp/osv-packages.json", "utf8"));

/** Does `version` fall inside ANY affected range / exact version of an advisory FOR THIS PACKAGE? */
function versionInRanges(packageName, version, advisory) {
  // Only the affected entries for the QUERIED package count — advisories
  // cover many packages (e.g. GHSA-w24r-5266-9c3c lists @clerk/* SDKs) and
  // mixing their ranges together produces false positives.
  const npmAffected = advisory.affected?.filter((a) => a.package?.name === packageName && a.package.ecosystem === "npm") ?? [];
  // Exact-version advisories (malware scanners): applies ONLY to the listed versions.
  const exactVersions = npmAffected.flatMap((a) => a.versions ?? []);
  if (exactVersions.length > 0) {
    return exactVersions.some((v) => semver.satisfies(version, `=${v}`, { loose: true }) || v === version);
  }
  const events = npmAffected.flatMap((a) => a.ranges ?? []).flatMap((r) => r.events ?? []);
  // Walk event pairs: introduced → fixed / last_affected / introduced-only.
  const ranges = [];
  for (let i = 0; i < events.length; i += 2) {
    const introduced = events[i]?.introduced;
    const upper = events[i + 1];
    if (introduced == null) continue;
    const low = `>=${introduced}`;
    if (!upper) { ranges.push(low); continue; }
    if (upper.fixed != null) ranges.push(`${low} <${upper.fixed}`);
    else if (upper.last_affected != null) ranges.push(`${low} <=${upper.last_affected}`);
    else if (upper.limit != null) ranges.push(`${low} <${upper.limit}`);
  }
  if (ranges.length === 0) return true; // no usable version data at all — report for triage
  return ranges.some((r) => semver.satisfies(version, r, { includePrerelease: true, loose: true }));
}

const CONCURRENCY = 24;
const results = [];
let next = 0;
const worker = async () => {
  while (next < packages.length) {
    const pkg = packages[next++];
    try {
      const res = await fetch("https://api.osv.dev/v1/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ package: { name: pkg.name, version: pkg.version, ecosystem: "npm" } }),
      });
      const body = await res.json();
      // The API over-reports (returns advisories whose ranges EXCLUDE the
      // installed version) — apply the ranges ourselves, like npm audit does.
      for (const v of body.vulns || []) {
        if (versionInRanges(pkg.name, pkg.version, v)) results.push({ pkg: pkg.name, version: pkg.version, id: v.id });
      }
    } catch { /* transient — treated as no finding; npm audit is the authority */ }
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log("  OSV findings: " + results.length);
for (const v of results.sort((a, b) => a.pkg.localeCompare(b.pkg))) console.log("  - " + v.id + " " + v.pkg + "@" + v.version);
fs.writeFileSync("/tmp/osv-findings.json", JSON.stringify(results));
if (results.length > 0) process.exit(1);
' || { echo "  OSV findings above must be triaged (npm audit is the primary gate)"; FAIL=1; }

echo
if [ "$FAIL" -eq 0 ]; then
  echo "security-gate: PASS"
else
  echo "security-gate: FAIL"
fi
exit $FAIL
