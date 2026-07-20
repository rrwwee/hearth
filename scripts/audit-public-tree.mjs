import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((path) => path && existsSync(new URL(path, `file://${root}/`)));

const forbiddenTrackedPaths = new Set([
  "config/devices.json",
  "pi/dashboard/config/cluster.json",
  "pi/dashboard/config/devices.json",
  "pi/dashboard/config/notifications.json",
  "pi/dashboard/config/ntfy-server.yml",
  "public/background.mp4",
]);

const patterns = new Map([
  ["private or overlay IP address", /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/],
  ["MAC address", /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i],
  ["student-style account identifier", /\bs\d{7}\b/i],
  ["Tailscale hostname", /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i],
  ["institution-specific hostname", /\b[a-z0-9.-]+\.(?:ac\.uk|edu\.au)\b/i],
  ["personal absolute home path", /\/(?:Users|home)\/(?!pi(?:\/|$)|user(?:\/|$))[a-z0-9._-]+\//i],
]);

const findings = [];
for (const path of tracked) {
  if (forbiddenTrackedPaths.has(path)) {
    findings.push({ category: "private deployment file is tracked", path });
  }
  const bytes = readFileSync(new URL(path, `file://${root}/`));
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [category, pattern] of patterns) {
    if (pattern.test(text)) findings.push({ category, path });
  }
}

if (findings.length) {
  console.error("Public-tree audit failed (matched values are intentionally redacted):");
  for (const finding of findings) console.error(`- ${finding.category}: ${finding.path}`);
  process.exitCode = 1;
} else {
  console.log(`Public-tree audit passed: ${tracked.length} tracked files scanned; no blocked identifiers found.`);
}
