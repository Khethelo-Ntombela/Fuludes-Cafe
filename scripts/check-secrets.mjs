// Blocks commits that contain API keys or database URLs. Run: npm run check:secrets
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const staged = process.argv.includes("--staged");
const files = execSync(staged ? "git diff --cached --name-only --diff-filter=ACM" : "git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && existsSync(f) && !/(^|\/)(node_modules|package-lock\.json)|\.(png|jpe?g|webp|ico|woff2?)$/i.test(f));

const rules = [
  ["database URL with password", /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]+@/i],
  ["Neon key", /\bnpg_[A-Za-z0-9]{8,}/],
  ["Resend key", /\bre_[A-Za-z0-9_]{16,}/],
  ["Yoco secret key", /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/],
  ["webhook secret", /\bwhsec_[A-Za-z0-9+/=_-]{8,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["secret assigned in code", /\b(?:RESEND_API_KEY|YOCO_SECRET_KEY|NEON_DATABASE_URL|VAPID_PRIVATE_KEY|ADMIN_PASSWORD|STAFF_PASSWORD|LOCATIONIQ_API_KEY)\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/],
];

let found = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [name, re] of rules) {
      if (re.test(line)) {
        found++;
        console.error(`${file}:${i + 1}  looks like a ${name}`);
      }
    }
  });
}

if (found) {
  console.error(`\n${found} possible secret(s) found. Move them to environment variables and rotate any that were committed.`);
  process.exit(1);
}
console.log("No secrets found.");
