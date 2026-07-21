import test from "node:test";
import assert from "node:assert/strict";
import {
  indexOwnTerminalJobs,
  jobStartCandidates,
  jobTerminalCandidates,
  passwordNeedForCluster,
  pruneKnownTerminalJobs,
  terminalNotification,
} from "../lib/notification-policy.js";

test("password notifications follow explicit health checks and ignore unrelated outages", () => {
  assert.equal(passwordNeedForCluster({ configured: false, reachable: false }), null);
  assert.equal(passwordNeedForCluster({
    reachable: false,
    health: { checks: [{ key: "vpn", ok: false, state: "needs password" }] },
  }), "vpn");
  assert.equal(passwordNeedForCluster({
    reachable: false,
    health: { checks: [
      { key: "vpn", ok: true, state: "ok" },
      { key: "ticket", ok: false, state: "needs password" },
    ] },
  }), "cluster");
  assert.equal(passwordNeedForCluster({
    reachable: false,
    health: { checks: [{ key: "slurm", ok: false, state: "blocked" }] },
    note: "temporary DNS failure",
  }), null);
});

test("only real transitions into RUNNING produce start candidates", () => {
  const previous = {
    "10": { id: "10", state: "PENDING" },
    "11": { id: "11", state: "RUNNING" },
  };
  const current = {
    "10": { id: "10", state: "RUNNING" },
    "11": { id: "11", state: "RUNNING" },
    "12": { id: "12", state: "PENDING" },
  };
  assert.deepEqual(jobStartCandidates(current, previous).map((job) => job.id), ["10"]);
});

test("terminal accounting events are user-scoped, classified, and deduplicated", () => {
  const cluster = {
    user: "researcher",
    accountingAvailable: true,
    terminalJobs: [
      { id: "20", user: "researcher", state: "COMPLETED", submittedAt: "2026-07-21T10:00:00", endedAt: "2026-07-21T10:05:00", name: "good" },
      { id: "21", user: "researcher", state: "OUT_OF_MEMORY", submittedAt: "2026-07-21T10:01:00", endedAt: "2026-07-21T10:04:00", name: "bad" },
      { id: "22", user: "someone-else", state: "FAILED", submittedAt: "2026-07-21T10:02:00", endedAt: "2026-07-21T10:03:00", name: "other" },
      { id: "23", user: "researcher", state: "RUNNING", submittedAt: "2026-07-21T10:03:00", name: "live" },
    ],
  };
  const indexed = indexOwnTerminalJobs(cluster);
  const completedKey = "20:2026-07-21T10:00:00";
  const candidates = jobTerminalCandidates(indexed, { [completedKey]: Date.now() });

  assert.deepEqual(candidates.map(({ job }) => job.id), ["21"]);
  assert.equal(terminalNotification(indexed[completedKey]).kind, "job.completed");
  assert.equal(terminalNotification(candidates[0].job).kind, "job.failed");
});

test("old terminal deduplication entries are pruned", () => {
  const now = Date.now();
  assert.deepEqual(pruneKnownTerminalJobs({ old: now - 1000, fresh: now }, now, 500), { fresh: now });
});
