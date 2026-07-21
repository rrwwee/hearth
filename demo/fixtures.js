const nowSeconds = () => Math.floor(Date.now() / 1000);

export function demoSnapshot() {
  return {
    host: "hearth-demo",
    platform: "Linux 6.12 aarch64",
    arch: "aarch64",
    timestamp: nowSeconds(),
    uptimeSeconds: 2_734_920,
    temperatureC: 42.6,
    voltage: 0.934,
    throttled: { raw: "0x0", active: false },
    cores: [
      { name: "cpu0", percent: 8.4 },
      { name: "cpu1", percent: 3.1 },
      { name: "cpu2", percent: 11.8 },
      { name: "cpu3", percent: 4.7 },
    ],
    processes: [
      { user: "hearth", pid: 1842, command: "node", cpuPercent: 1.4, memoryPercent: 2.1 },
      { user: "root", pid: 711, command: "tailscaled", cpuPercent: 0.3, memoryPercent: 2.8 },
      { user: "root", pid: 936, command: "containerd", cpuPercent: 0.1, memoryPercent: 1.2 },
      { user: "root", pid: 1088, command: "sshd", cpuPercent: 0.0, memoryPercent: 0.2 },
      { user: "ntfy", pid: 1261, command: "ntfy", cpuPercent: 0.0, memoryPercent: 0.7 },
    ],
    load: [0.28, 0.34, 0.31],
    memory: { total: 4_096_000_000, available: 3_214_000_000, usedPercent: 21.5 },
    disk: { total: 128_000_000_000, used: 18_900_000_000, free: 109_100_000_000, percent: 14.8 },
    history: [],
  };
}

export function demoNetwork() {
  const now = nowSeconds();
  return {
    cidr: "192.0.2.0/24",
    source: "demo fixture",
    timestamp: now,
    devices: [
      { ip: "192.0.2.10", nickname: "hearth", status: "online", onlineSince: now - 2_734_920, lastSeen: now },
      { ip: "192.0.2.1", nickname: "router", status: "online", onlineSince: now - 472_860, lastSeen: now },
      { ip: "192.0.2.24", nickname: "studio laptop", status: "online", onlineSince: now - 19_440, lastSeen: now },
      { ip: "192.0.2.31", nickname: "phone", status: "offline", lastSeen: now - 1_740 },
      { ip: "192.0.2.42", nickname: "media speaker", status: "offline", lastSeen: now - 7_680 },
    ],
  };
}

export function demoBluetooth() {
  return {
    available: true,
    timestamp: nowSeconds(),
    scanSeconds: 8,
    devices: [],
    note: "demo fixture",
  };
}

function demoHealth() {
  return {
    ok: true,
    checks: [
      { key: "vpn", label: "vpn", ok: true, state: "ok", detail: "private route available" },
      { key: "ticket", label: "login", ok: true, state: "ok", detail: "renewable ticket present" },
      { key: "jump", label: "jump", ok: true, state: "ok", detail: "control connection open" },
      { key: "slurm", label: "slurm", ok: true, state: "ok", detail: "scheduler answered" },
    ],
  };
}

export function demoCluster() {
  return {
    configured: true,
    reachable: true,
    scheduler: "slurm",
    user: "demo01",
    sshHost: "compute-demo",
    host: "login.demo.invalid",
    timestamp: nowSeconds(),
    partitions: [
      { name: "research", default: true, availability: "up", nodes: "3", state: "mix", cpus: "48/144/0/192" },
    ],
    jobs: [
      {
        id: "42017", user: "demo01", userName: "Ada Mensah", state: "RUNNING",
        time: "1-04:18:12", durationSeconds: 101_892, submittedAt: "2026-07-18T08:20:00",
        nodeCount: 1, nodeList: ["forge01"], reason: "forge01", cpus: 16,
        gres: "gres/gpu:h200:2", name: "latent-dynamics", friend: true,
      },
      {
        id: "42031", user: "demo02", userName: "Jun Park", state: "RUNNING",
        time: "09:42:08", durationSeconds: 34_928, submittedAt: "2026-07-19T10:00:00",
        nodeCount: 1, nodeList: ["kiln01"], reason: "kiln01", cpus: 8,
        gres: "gres/gpu:a40:1", name: "eval-sweep", friend: false,
      },
      {
        id: "42046", user: "demo03", userName: "Marta Silva", state: "PENDING",
        time: "00:00:00", durationSeconds: 0, submittedAt: "2026-07-20T08:12:00",
        submittedSort: "2026-07-20T08:12:00", nodeCount: 1, nodeList: [], reason: "Resources",
        cpus: 32, gres: "gres/gpu:h200:4", name: "representation-study", priority: 18_420,
        estimatedStart: "2026-07-20T18:40:00", friend: false,
      },
    ],
    accountingAvailable: true,
    terminalJobs: [],
    userSummaries: [
      {
        id: "demo01", name: "Ada Mensah", jobCount: 1, running: 1, pending: 0,
        longestRunningSeconds: 101_892, firstQueuedAt: null, friend: true,
        jobs: [{ id: "42017", name: "latent-dynamics", state: "RUNNING", time: "1-04:18:12", durationSeconds: 101_892, nodeList: ["forge01"], cpus: 16, gres: "gres/gpu:h200:2" }],
      },
      {
        id: "demo02", name: "Jun Park", jobCount: 1, running: 1, pending: 0,
        longestRunningSeconds: 34_928, firstQueuedAt: null, friend: false,
        jobs: [{ id: "42031", name: "eval-sweep", state: "RUNNING", time: "09:42:08", durationSeconds: 34_928, nodeList: ["kiln01"], cpus: 8, gres: "gres/gpu:a40:1" }],
      },
      {
        id: "demo03", name: "Marta Silva", jobCount: 1, running: 0, pending: 1,
        longestRunningSeconds: 0, firstQueuedAt: "2026-07-20T08:12:00", friend: false,
        jobs: [{ id: "42046", name: "representation-study", state: "PENDING", time: "00:00:00", durationSeconds: 0, nodeList: [], reason: "Resources", cpus: 32, gres: "gres/gpu:h200:4", estimatedStart: "2026-07-20T18:40:00" }],
      },
    ],
    nodes: [
      {
        name: "forge01", state: "mixed+planned", partitions: ["research"],
        cpu: { allocated: 32, total: 96, percent: 33.3, load: 28.4 },
        memory: { allocatedMb: 393_216, totalMb: 2_060_000, freeMb: 1_451_000, percent: 19.1 },
        gpu: { type: "h200", allocated: 5, total: 8, free: 3 },
        watts: 2_180, averageWatts: 1_640, jobCount: 1,
        jobs: [{ id: "42017", name: "latent-dynamics", user: "demo01", userName: "Ada Mensah", friend: true, time: "1-04:18:12", durationSeconds: 101_892, cpus: 16, gres: "gres/gpu:h200:2" }],
      },
      {
        name: "kiln01", state: "mixed", partitions: ["research"],
        cpu: { allocated: 20, total: 64, percent: 31.3, load: 14.7 },
        memory: { allocatedMb: 98_304, totalMb: 512_000, freeMb: 389_000, percent: 19.2 },
        gpu: { type: "a40", allocated: 2, total: 4, free: 2 },
        watts: 770, averageWatts: 610, jobCount: 1,
        jobs: [{ id: "42031", name: "eval-sweep", user: "demo02", userName: "Jun Park", friend: false, time: "09:42:08", durationSeconds: 34_928, cpus: 8, gres: "gres/gpu:a40:1" }],
      },
    ],
    states: { RUNNING: 2, PENDING: 1 },
    users: { demo01: 1, demo02: 1, demo03: 1 },
    health: demoHealth(),
  };
}
