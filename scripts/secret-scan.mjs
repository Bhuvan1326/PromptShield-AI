/**
 * Secret-pattern scanner — CI-safe, REDACTED output only.
 *
 * Scans tracked working-tree files for high-signal credential patterns.
 * NEVER prints a matched secret: findings show file + line + pattern name +
 * a 4-char masked prefix indicator (e.g. "AIza…"). History is NOT scanned
 * (the known historical incident is handled separately, by the owner).
 *
 * Usage: node scripts/secret-scan.mjs   (exit 1 on findings)
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { name: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "openai-key", re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "github-token", re: /(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/ },
  { name: "generic-private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "slack-token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: "stripe-key", re: /(?:sk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/ },
];

// Allowlisted files: scanners, docs and examples legitimately discuss secrets.
const SKIP = /(^|\/)(\.env\.example|docs\/|scripts\/secret-scan\.mjs|\.gitignore)/;

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !SKIP.test(f))
  .filter((f) => !/lock|\.png$|\.jpg$|\.ico$|\.woff/.test(f));

let findings = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        findings++;
        console.log(`FINDING  ${file}:${i + 1}  pattern=${p.name}  match=${m[0].slice(0, 4)}…(redacted)`);
      }
    }
  });
}
console.log(findings === 0 ? "OK — no credential patterns in tracked files" : `${findings} finding(s)`);
process.exitCode = findings === 0 ? 0 : 1;
