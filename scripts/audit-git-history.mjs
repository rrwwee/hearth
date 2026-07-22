import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
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

const objects = execFileSync("git", ["rev-list", "--objects", "HEAD"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const findings = new Map();

const commits = execFileSync("git", ["rev-list", "HEAD"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
for (const hash of commits) {
  const metadata = execFileSync(
    "git",
    ["show", "-s", "--format=%P%x00%an%x00%ae%x00%cn%x00%ce%x00%B", hash],
    { cwd: root, encoding: "utf8" },
  );
  const [parents, authorName, authorEmail, committerName, committerEmail, ...bodyParts] = metadata.split("\0");
  const body = bodyParts.join("\0");
  const githubMerge = parents.trim().split(/\s+/).length > 1
    && committerName === "GitHub"
    && committerEmail.toLowerCase() === "noreply@github.com";
  const emails = [
    ...(githubMerge ? [] : [authorEmail]),
    committerEmail,
    ...(body.match(/\b[^\s<>@]+@[^\s<>@]+\b/g) || []),
  ];
  const safeEmail = (email) => {
    const normalized = email.trim().toLowerCase();
    return normalized.endsWith("@users.noreply.github.com") || normalized === "noreply@github.com";
  };
  if (emails.some((email) => !safeEmail(email))) {
    findings.set(`non-noreply commit email\0${hash}`, {
      category: "non-noreply Git author or committer email",
      path: `commit metadata (${hash.slice(0, 7)})`,
    });
  }
  const publicMetadata = [authorName, committerName, body].join("\n");
  for (const [category, pattern] of patterns) {
    if (pattern.test(publicMetadata)) {
      findings.set(`${category}\0commit-${hash}`, { category, path: `commit metadata (${hash.slice(0, 7)})` });
    }
  }
}

for (const entry of objects) {
  const separator = entry.indexOf(" ");
  if (separator < 0) continue;
  const hash = entry.slice(0, separator);
  const path = entry.slice(separator + 1);
  if (forbiddenTrackedPaths.has(path)) {
    findings.set(`private deployment file is tracked\0${path}`, { category: "private deployment file is tracked", path });
  }
  const type = execFileSync("git", ["cat-file", "-t", hash], { cwd: root, encoding: "utf8" }).trim();
  if (type !== "blob") continue;
  const bytes = execFileSync("git", ["cat-file", "blob", hash], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [category, pattern] of patterns) {
    if (pattern.test(text)) findings.set(`${category}\0${path}`, { category, path });
  }
}

if (findings.size) {
  console.error("Git-history audit failed (matched values are intentionally redacted):");
  for (const finding of findings.values()) console.error(`- ${finding.category}: ${finding.path}`);
  process.exitCode = 1;
} else {
  console.log(`Git-history audit passed: ${objects.length} reachable objects scanned; no blocked identifiers found.`);
}
