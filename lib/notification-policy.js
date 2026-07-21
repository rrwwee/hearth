export const TERMINAL_JOB_STATES = new Set([
  "BOOT_FAIL",
  "CANCELLED",
  "COMPLETED",
  "DEADLINE",
  "FAILED",
  "NODE_FAIL",
  "OUT_OF_MEMORY",
  "PREEMPTED",
  "REVOKED",
  "TIMEOUT",
]);

export function passwordNeedForCluster(cluster) {
  if (!cluster || cluster.reachable || cluster.configured === false) return null;

  const checks = Array.isArray(cluster.health?.checks) ? cluster.health.checks : [];
  if (checks.length) {
    const vpn = checks.find((check) => check.key === "vpn");
    if (vpn && !vpn.ok && vpn.state === "needs password") return "vpn";
    const ticket = checks.find((check) => check.key === "ticket");
    if (ticket && !ticket.ok && ticket.state === "needs password") return "cluster";
    return null;
  }

  const note = `${cluster.note || ""}`.toLowerCase();
  if (
    note.includes("network is unreachable")
    || note.includes("no route to host")
    || note.includes("connection timed out")
    || note.includes("vpn tunnel started")
  ) {
    return "vpn";
  }
  if (
    note.includes("permission denied")
    || note.includes("kerberos")
    || note.includes("ticket")
    || note.includes("refresh the configured jump connection")
  ) {
    return "cluster";
  }
  return null;
}

export function indexOwnJobs(cluster) {
  const user = cluster?.user;
  const jobs = {};
  if (!user) return jobs;
  for (const job of cluster.jobs || []) {
    if (job.user !== user) continue;
    jobs[job.id] = {
      id: job.id,
      name: job.name,
      state: job.state,
      time: job.time,
      submittedAt: job.submittedAt,
    };
  }
  return jobs;
}

export function terminalJobKey(job) {
  return `${job.id}:${job.submittedAt || job.startedAt || job.endedAt || "unknown"}`;
}

export function indexOwnTerminalJobs(cluster) {
  const user = cluster?.user;
  const jobs = {};
  if (!user || cluster.accountingAvailable !== true) return jobs;
  for (const job of cluster.terminalJobs || []) {
    if (job.user !== user || !TERMINAL_JOB_STATES.has(job.state)) continue;
    jobs[terminalJobKey(job)] = job;
  }
  return jobs;
}

export function jobStartCandidates(currentJobs, previousJobs) {
  return Object.values(currentJobs).filter((job) => (
    job.state === "RUNNING" && previousJobs[job.id]?.state !== "RUNNING"
  ));
}

export function jobTerminalCandidates(currentTerminalJobs, knownTerminalJobs) {
  return Object.entries(currentTerminalJobs)
    .filter(([key]) => !knownTerminalJobs[key])
    .map(([key, job]) => ({ key, job }))
    .sort((left, right) => `${left.job.endedAt || ""}`.localeCompare(`${right.job.endedAt || ""}`));
}

export function terminalNotification(job) {
  if (job.state === "COMPLETED") {
    return {
      kind: "job.completed",
      title: "Cluster job completed",
      message: `${job.name || "job"} (${job.id}) completed successfully.`,
      tags: "white_check_mark",
      priority: "default",
    };
  }
  if (job.state === "CANCELLED" || job.state === "REVOKED") {
    return {
      kind: "job.cancelled",
      title: "Cluster job cancelled",
      message: `${job.name || "job"} (${job.id}) ended with ${job.state}.`,
      tags: "no_entry_sign",
      priority: "default",
    };
  }
  return {
    kind: "job.failed",
    title: "Cluster job failed",
    message: `${job.name || "job"} (${job.id}) ended with ${job.state}.`,
    tags: "warning",
    priority: "high",
  };
}

export function pruneKnownTerminalJobs(knownTerminalJobs, now, retentionMs = 7 * 24 * 60 * 60 * 1000) {
  const keepAfter = now - retentionMs;
  return Object.fromEntries(
    Object.entries(knownTerminalJobs)
      .filter(([, seenAt]) => Number(seenAt) >= keepAfter)
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 2000),
  );
}
