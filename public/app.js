const els = {
  temperature: document.querySelector("#temperature"),
  statusText: document.querySelector("#statusText"),
  statusLight: document.querySelector("#statusLight"),
  statusStrip: document.querySelector("#statusStrip"),
  uptime: document.querySelector("#uptime"),
  voltage: document.querySelector("#voltage"),
  load: document.querySelector("#load"),
  systemCapacity: document.querySelector("#systemCapacity"),
  coreList: document.querySelector("#coreList"),
  processList: document.querySelector("#processList"),
  refreshButton: document.querySelector("#refreshButton"),
  deviceList: document.querySelector("#deviceList"),
  clusterStatus: document.querySelector("#clusterStatus"),
  authForm: document.querySelector("#authForm"),
  authLabel: document.querySelector("#authLabel"),
  authTarget: document.querySelector("#authTarget"),
  authPassword: document.querySelector("#authPassword"),
  authButton: document.querySelector("#authButton"),
  authStatus: document.querySelector("#authStatus"),
  modeBadge: document.querySelector("#modeBadge"),
};

function formatBytes(bytes) {
  if (bytes == null) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const clock = [hours, minutes, secs]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
    .join(":");
  return days ? `${days}-${clock}` : clock;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 0 : 1)}%` : "--";
}

function capacityTrack(fraction, title = "") {
  const track = document.createElement("span");
  const safeFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  track.className = "capacity-track";
  track.style.setProperty("--capacity-fill", `${(safeFraction * 100).toFixed(2)}%`);
  track.title = title;
  track.setAttribute("aria-hidden", "true");
  return track;
}

function logarithmicFraction(value, maximum) {
  const safeValue = Math.max(0, Number(value) || 0);
  const safeMaximum = Math.max(safeValue, Number(maximum) || 0);
  return safeMaximum > 0 ? Math.log1p(safeValue) / Math.log1p(safeMaximum) : 0;
}

function placeLabel(text, label) {
  const value = String(label ?? "");
  if (!value) return text;
  if (!text.length) return "";
  if (value.length >= text.length) return value.slice(0, text.length);
  return `${text.slice(0, text.length - value.length)}${value}`;
}

function visualBar({
  total,
  hot = 0,
  warm = 0,
  hotLabel = "",
  warmLabel = "",
  endLabel = "",
  width = 24,
  title = "",
  className = "",
}) {
  const safeTotal = Math.max(1, total || 0);
  const hotCells = Math.round((Math.max(0, Math.min(hot, safeTotal)) / safeTotal) * width);
  const warmCells = Math.round((Math.max(0, Math.min(warm, safeTotal - hot)) / safeTotal) * width);
  const emptyCells = Math.max(0, width - hotCells - warmCells);
  const hotText = placeLabel("█".repeat(hotCells), hotLabel);
  const warmText = placeLabel("░".repeat(warmCells), warmLabel);
  const emptyText = placeLabel("░".repeat(emptyCells), endLabel);
  return `<span class="term-bar ${className}" title="${title}" style="--bar-cells:${width}"><span class="bar-fill bar-hot">${hotText}</span><span class="bar-fill bar-warm">${warmText}</span><span class="bar-fill bar-empty">${emptyText}</span></span>`;
}

function userBar({ running, pending, maxJobs, width = 30 }) {
  const total = running + pending;
  const safeMax = Math.max(1, maxJobs || total || 1);
  const visibleCells = total > 0
    ? Math.max(1, Math.round((Math.log1p(total) / Math.log1p(safeMax)) * width))
    : 0;
  const runCells = running > 0
    ? Math.max(1, Math.round((Math.log1p(running) / Math.log1p(total)) * visibleCells))
    : 0;
  const queueCells = Math.max(0, visibleCells - runCells);
  const emptyCells = Math.max(0, width - visibleCells);
  const runText = "█".repeat(runCells);
  const queueText = "░".repeat(queueCells);
  const emptyText = "░".repeat(emptyCells);
  return `<span class="user-bar-wrap" title="${running} running; ${pending} pending; ${total} total; log scaled against ${safeMax}"><span class="bar-running-label">${running ?? 0}</span><span class="term-bar user-bar" style="--bar-cells:${width}"><span class="bar-fill bar-hot">${runText}</span><span class="bar-fill bar-warm">${queueText}</span><span class="bar-pending-label">${total ? ` ${total}` : ""}</span><span class="bar-fill bar-empty">${emptyText}</span></span></span>`;
}

function nodeBar({ allocated, total, width = 30 }) {
  return `<span class="node-bar-wrap" title="${allocated} allocated; ${total} total"><span class="bar-running-label">${allocated ?? ""}</span>${visualBar({
    total,
    hot: allocated,
    width,
    title: "GPU capacity allocated",
  })}<span class="bar-total-label">${total ?? ""}</span></span>`;
}

function metricBar({ label, current, capacity, totalLabel, value, width = 24, title = "" }) {
  return `<span class="node-metric" title="${title}"><span class="node-metric-label">${label}</span><span class="bar-running-label">${value}</span>${visualBar({ total: capacity, hot: current, width })}<span class="bar-total-label">${totalLabel}</span></span>`;
}

function readingMetric({ label, value, comparisonLabel, comparisonValue, title = "" }) {
  return `<span class="node-metric node-reading" title="${title}"><span class="node-metric-label">${label}</span><span class="bar-running-label">${value}</span><span class="node-reading-label">${comparisonLabel}</span><span class="bar-total-label">${comparisonValue}</span></span>`;
}

function systemBar({ label, current, total, title }) {
  return `<span class="system-bar" title="${title}"><span>${label}</span><span>${formatBytes(current)}</span>${visualBar({ total, hot: current, width: 30 })}<span>${formatBytes(total)}</span></span>`;
}

function setStatus(kind, text) {
  els.statusLight.classList.toggle("is-live", kind === "live");
  els.statusLight.classList.toggle("is-error", kind === "error");
  els.statusText.textContent = text;
  els.statusStrip.hidden = text.length === 0;
}

function heatFromTemp(temp) {
  if (!Number.isFinite(temp)) return 0.18;
  return Math.min(1, Math.max(0.08, (temp - 24) / 46));
}

function render(snapshot, piHost) {
  const temp = snapshot.temperatureC;
  const tempDisplay = temp == null ? "--.-" : temp.toFixed(1);
  const heat = heatFromTemp(temp);

  els.temperature.textContent = tempDisplay;
  document.documentElement.style.setProperty("--heat", heat.toFixed(3));
  els.voltage.textContent = snapshot.voltage == null ? "--.--v" : `${snapshot.voltage.toFixed(3)}v`;
  els.uptime.textContent = formatUptime(snapshot.uptimeSeconds);
  els.load.textContent = snapshot.load?.[0]?.toFixed(2) ?? "--";
  const memoryUsed = Math.max(0, (snapshot.memory?.total || 0) - (snapshot.memory?.available || 0));
  els.systemCapacity.innerHTML = `
    ${systemBar({ label: "mem", current: memoryUsed, total: snapshot.memory?.total || 1, title: "Memory in use" })}
    ${systemBar({ label: "disk", current: snapshot.disk?.used || 0, total: snapshot.disk?.total || 1, title: "Root disk in use" })}
  `;
  renderCores(snapshot.cores || []);
  renderProcesses(snapshot.processes || []);

  setStatus("live", "");
}

function renderCores(cores) {
  els.coreList.replaceChildren(
    ...cores.map((core) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      const value = document.createElement("strong");
      name.textContent = core.name;
      value.textContent = formatPercent(core.percent);
      li.append(
        name,
        capacityTrack((Number(core.percent) || 0) / 100, `${formatPercent(core.percent)} CPU`),
        value,
      );
      return li;
    }),
  );
}

function renderProcesses(processes) {
  const maximumActivity = Math.max(
    0,
    ...processes.map((process) => Math.max(process.cpuPercent || 0, process.memoryPercent || 0)),
  );
  els.processList.replaceChildren(
    ...processes.map((process) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      const cpu = document.createElement("span");
      const memory = document.createElement("span");
      const activity = Math.max(process.cpuPercent || 0, process.memoryPercent || 0);
      name.textContent = process.command;
      cpu.textContent = formatPercent(process.cpuPercent);
      memory.textContent = formatPercent(process.memoryPercent);
      li.append(
        name,
        capacityTrack(
          logarithmicFraction(activity, maximumActivity),
          `${formatPercent(activity)} peak resource use; logarithmic scale`,
        ),
        cpu,
        memory,
      );
      return li;
    }),
  );
}

function displayName(device) {
  if (device.nickname) return device.nickname;
  if (device.name) return device.name;
  if (device.vendor) return device.vendor;
  if (device.ip.endsWith(".1")) return "Router";
  return "Unknown device";
}

function renderNetwork(network) {
  const now = Math.floor(Date.now() / 1000);
  const deviceRows = network.devices.map((device) => {
    const online = device.status === "online";
    const referenceTime = Number(online ? device.onlineSince : device.lastSeen) || network.timestamp;
    return { device, online, referenceTime, elapsedSeconds: Math.max(0, now - referenceTime) };
  });
  const maximumElapsed = Math.max(0, ...deviceRows.map((row) => row.elapsedSeconds));

  els.deviceList.replaceChildren(
    ...deviceRows.map(({ device, online, referenceTime, elapsedSeconds }) => {
      const li = document.createElement("li");
      const name = document.createElement("strong");
      const duration = document.createElement("span");
      const track = capacityTrack(
        logarithmicFraction(elapsedSeconds, maximumElapsed),
        `${formatUptime(elapsedSeconds)}; logarithmic scale`,
      );

      name.className = "device-name";
      li.className = `device-${device.status || "online"}`;
      track.classList.add("device-track");
      track.dataset.referenceTime = String(referenceTime);
      duration.className = "device-duration";
      duration.dataset.referenceTime = String(referenceTime);
      duration.textContent = formatUptime(elapsedSeconds);
      name.textContent = displayName(device);
      li.append(name, track, duration);
      return li;
    }),
  );
}

function tickNetworkDurations() {
  const now = Math.floor(Date.now() / 1000);
  const rows = [...document.querySelectorAll(".device-list li")].map((row) => {
    const duration = row.querySelector(".device-duration[data-reference-time]");
    const track = row.querySelector(".device-track");
    const elapsedSeconds = Math.max(0, now - Number(duration?.dataset.referenceTime || 0));
    return { duration, track, elapsedSeconds };
  });
  const maximumElapsed = Math.max(0, ...rows.map((row) => row.elapsedSeconds));

  rows.forEach(({ duration, track, elapsedSeconds }) => {
    if (duration) duration.textContent = formatUptime(elapsedSeconds);
    if (track) {
      const fraction = logarithmicFraction(elapsedSeconds, maximumElapsed);
      track.style.setProperty("--capacity-fill", `${(fraction * 100).toFixed(2)}%`);
      track.title = `${formatUptime(elapsedSeconds)}; logarithmic scale`;
    }
  });
}

function authModeForCluster(cluster) {
  if (!cluster || cluster.reachable) return null;
  const note = `${cluster.note || ""}`.toLowerCase();
  if (
    note.includes("network is unreachable") ||
    note.includes("no route to host") ||
    note.includes("connection timed out")
  ) {
    return "vpn";
  }
  return "cluster";
}

function setAuthPrompt(mode, status = null) {
  els.authForm.hidden = !mode;
  if (!mode) {
    els.authPassword.value = "";
    els.authStatus.textContent = "";
    return;
  }
  els.authTarget.value = mode;
  els.authLabel.textContent = mode;
  els.authPassword.placeholder = `${mode} password`;
  if (status !== null) {
    els.authStatus.textContent = status;
  }
}

function clusterHealthChecks(cluster) {
  const checks = cluster?.health?.checks || [];
  if (checks.length) return checks;
  return [
    {
      key: "slurm",
      label: "slurm",
      ok: !!cluster?.reachable,
      state: cluster?.reachable ? "ok" : "blocked",
      detail: cluster?.note || (cluster?.reachable ? "cluster answered" : "cluster has not answered"),
    },
  ];
}

function renderClusterHealth(cluster) {
  const health = document.createElement("div");
  health.className = `cluster-health${cluster?.health?.ok ? " is-ok" : ""}`;
  health.replaceChildren(
    ...clusterHealthChecks(cluster).map((check) => {
      const item = document.createElement("span");
      item.className = `cluster-health-check ${check.ok ? "is-ok" : "is-bad"}`;
      item.title = check.detail || check.state || "";
      item.innerHTML = `<span class="health-dot"></span><span>${check.label}</span><strong>${check.state}</strong>`;
      return item;
    }),
  );
  return health;
}

function topCounts(counts, limit = 4) {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name}:${count}`)
    .join(" ");
}

function formatGpu(gpu) {
  if (!gpu || !gpu.total) return "no gpu";
  const label = gpu.type ? gpu.type.replace(/^nvidia_/, "").replaceAll("_", " ") : "gpu";
  return `${gpu.total} ${label}`;
}

function gpuLabel(gpu) {
  if (!gpu?.type) return "gpu";
  return gpu.type.replace(/^nvidia_/, "").replaceAll("_", " ");
}

function formatGb(mb) {
  return Number.isFinite(mb) ? `${Math.round(mb / 1024)} GB` : "-- GB";
}

function nodeCapacity(node) {
  const gpuTotal = node.gpu?.total || 0;
  const gpuAllocated = node.gpu?.allocated || 0;
  return gpuTotal ? (gpuAllocated / gpuTotal) * 100 : 0;
}

function gpuRequest(job, fallback = "pending") {
  const gres = job.gres || "";
  const typed = gres.match(/gpu:([^:]+):(\d+)/);
  if (typed) return `${typed[2]} ${typed[1].replaceAll("_", " ")}`;
  const generic = gres.match(/gpu:(\d+)/);
  if (generic) return `${generic[1]} gpu`;
  return fallback;
}

function gpuRequestCount(job) {
  const gres = job.gres || "";
  const typed = gres.match(/gpu:[^:]+:(\d+)/);
  if (typed) return Number.parseInt(typed[1], 10);
  const generic = gres.match(/gpu:(\d+)/);
  if (generic) return Number.parseInt(generic[1], 10);
  return 1;
}

function friendClass(user, isFriend) {
  if (!isFriend) return "";
  const hash = [...String(user || "friend")].reduce(
    (value, character) => ((value * 31) + character.codePointAt(0)) >>> 0,
    0,
  );
  return `friend-color-${hash % 6}`;
}

function renderJob(job) {
  const li = document.createElement("li");
  const state = job.state.toLowerCase();
  li.className = `cluster-job is-${state}`;
  li.innerHTML = `
    <span class="tree-branch">└</span>
    <span>${job.state === "RUNNING" ? (job.nodeList || []).join(", ") : gpuRequest(job)}</span>
    <span class="live-time" data-seconds="${job.durationSeconds || 0}" data-running="${job.state === "RUNNING"}">${job.time}</span>
    <span>${job.name}</span>
  `;
  return li;
}

function renderUser(user, maxJobs, open = false) {
  const details = document.createElement("details");
  const displayName = user.name || user.id;
  const friendClassName = friendClass(user.id, user.friend);
  details.className = `cluster-user${user.friend || friendClassName ? ` is-friend ${friendClassName}` : ""}`;
  details.dataset.key = user.id;
  details.open = open;

  const summary = document.createElement("summary");
  summary.innerHTML = `
    <span class="tree-toggle" aria-hidden="true">+</span>
    <span>${displayName}</span>
    ${userBar({
      running: user.running,
      pending: Math.max(0, user.jobCount - user.running),
      maxJobs,
      width: 30,
    })}
  `;

  const jobs = document.createElement("ol");
  jobs.className = "cluster-jobs";
  jobs.replaceChildren(...(user.jobs || []).map(renderJob));

  details.append(summary, jobs);
  return details;
}

function queueStartLabel(value) {
  if (!value) return null;
  const start = new Date(value);
  if (Number.isNaN(start.getTime())) return null;
  const clock = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = start.toDateString() === new Date().toDateString();
  return sameDay ? `~ ${clock}` : `~ ${start.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

function queueOrder(a, b) {
  const aStart = Date.parse(a.estimatedStart || "");
  const bStart = Date.parse(b.estimatedStart || "");
  const aEstimated = Number.isFinite(aStart);
  const bEstimated = Number.isFinite(bStart);
  if (aEstimated !== bEstimated) return aEstimated ? -1 : 1;
  if (aEstimated && aStart !== bStart) return aStart - bStart;
  const priority = (Number(b.priority) || 0) - (Number(a.priority) || 0);
  return priority || (a.submittedSort || "").localeCompare(b.submittedSort || "");
}

function renderQueueJob(job) {
  const item = document.createElement("li");
  const displayName = job.userName || job.user;
  const friendClassName = friendClass(job.user, job.friend);
  item.className = `queue-job is-${job.state.toLowerCase()}${job.friend || friendClassName ? ` is-friend ${friendClassName}` : ""}`;
  const timing = job.state === "RUNNING"
    ? job.time
    : queueStartLabel(job.estimatedStart) || (job.priority ? `priority ${job.priority}` : job.reason || "waiting");
  item.innerHTML = `
    <span>${displayName}</span>
    <span class="${job.state === "RUNNING" ? "live-time" : ""}" ${job.state === "RUNNING" ? `data-seconds="${job.durationSeconds || 0}" data-running="true"` : ""}>${timing}</span>
    <span>${job.state === "RUNNING" ? (job.nodeList || []).join(", ") : gpuRequest(job, job.reason || "waiting")}</span>
    <span>${job.name}</span>
  `;
  return item;
}

function renderQueue(jobs) {
  const queue = document.createElement("div");
  queue.className = "cluster-queue";
  const list = document.createElement("ol");
  list.className = "queue-jobs";
  const running = jobs.filter((job) => job.state === "RUNNING").sort((a, b) => b.durationSeconds - a.durationSeconds);
  const pending = jobs.filter((job) => job.state === "PENDING").sort(queueOrder);
  list.replaceChildren(...[...running, ...pending].map(renderQueueJob));
  queue.append(list);
  return queue;
}

function renderNode(node) {
  const details = document.createElement("details");
  details.className = "cluster-node";
  details.dataset.key = node.name;
  const gpu = node.gpu?.total ? `${formatGpu(node.gpu)}` : "no gpu";
  const summary = document.createElement("summary");
  summary.innerHTML = `
    <span class="tree-toggle" aria-hidden="true">+</span>
    <strong>${node.name}</strong>
    <span>${gpu}</span>
    ${nodeBar({
      allocated: node.gpu?.allocated || 0,
      total: node.gpu?.total || 0,
      width: 30,
    })}
  `;

  const detail = document.createElement("div");
  detail.className = "node-detail";

  const metrics = document.createElement("div");
  metrics.className = "node-metrics";
  const cpuTotal = node.cpu?.total || 1;
  const memAllocatedGb = Math.round((node.memory?.allocatedMb || 0) / 1024);
  const memTotalGb = Math.round((node.memory?.totalMb || 0) / 1024);
  metrics.innerHTML = `
    ${metricBar({ label: "cpu alloc", current: node.cpu?.allocated || 0, capacity: cpuTotal, totalLabel: node.cpu?.total || "--", value: node.cpu?.allocated ?? "--", title: "CPU cores allocated by Slurm; not live CPU utilization" })}
    ${metricBar({ label: "mem alloc", current: node.memory?.allocatedMb || 0, capacity: node.memory?.totalMb || 1, totalLabel: `${memTotalGb}G`, value: `${memAllocatedGb}G`, title: "Memory reserved by Slurm jobs; not live memory usage" })}
    ${metricBar({ label: "load", current: node.cpu?.load || 0, capacity: cpuTotal, totalLabel: node.cpu?.total || "--", value: Number.isFinite(node.cpu?.load) ? node.cpu.load.toFixed(1) : "--", title: "One-minute load average relative to the node's CPU core count" })}
    ${readingMetric({ label: "power", value: node.watts ? `${node.watts}w` : "--w", comparisonLabel: "avg", comparisonValue: node.averageWatts ? `${node.averageWatts}w` : "--w", title: "Current and average node power reported by Slurm's IPMI energy monitor" })}
  `;

  const jobs = document.createElement("ol");
  jobs.className = "node-jobs";
  const runningJobs = node.jobs || [];
  const listedGpuCount = runningJobs.reduce(
    (total, job) => total + Math.max(1, gpuRequestCount(job)),
    0,
  );
  const freeGpuCount = Number.isFinite(node.gpu?.free)
    ? node.gpu.free
    : Math.max(0, (node.gpu?.total || 0) - listedGpuCount);
  if (runningJobs.length || freeGpuCount) {
    const busyItems = runningJobs.map((job) => {
      const li = document.createElement("li");
      const gpuCount = Math.max(1, gpuRequestCount(job));
      const friendClassName = friendClass(job.user, job.friend);
      if (job.friend || friendClassName) li.classList.add("is-friend", friendClassName);
      li.innerHTML = `
        <span>${gpuCount > 1 ? `${gpuCount}× ` : ""}${gpuLabel(node.gpu)}</span>
        <span class="live-time" data-seconds="${job.durationSeconds || 0}" data-running="true">${job.time}</span>
        <span>${job.cpus ?? "--"} cpu</span>
        <span>${job.name}</span>
      `;
      return li;
    });
    const idleItems = freeGpuCount ? [(() => {
      const li = document.createElement("li");
      li.className = "node-free";
      li.innerHTML = `
        <span>${freeGpuCount > 1 ? `${freeGpuCount}× ` : ""}${gpuLabel(node.gpu)}</span>
        <span>unalloc</span>
        <span>-- cpu</span>
        <span></span>
      `;
      return li;
    })()] : [];
    jobs.replaceChildren(...busyItems, ...idleItems);
  } else {
    const empty = document.createElement("li");
    empty.className = "node-empty";
    empty.textContent = "no running jobs";
    jobs.append(empty);
  }

  detail.append(metrics, jobs);
  details.append(summary, detail);
  return details;
}

function clusterViewState() {
  const state = {
    usersScroll: document.querySelector(".cluster-users")?.scrollTop || 0,
    nodesScroll: document.querySelector(".cluster-nodes")?.scrollTop || 0,
    queueScroll: document.querySelector(".cluster-queue")?.scrollTop || 0,
    openUsers: new Set(),
    openNodes: new Set(),
    nestedScroll: new Map(),
  };
  document.querySelectorAll(".cluster-user[open]").forEach((details) => {
    const key = details.dataset.key;
    if (!key) return;
    state.openUsers.add(key);
    state.nestedScroll.set(`user:${key}`, details.querySelector(".cluster-jobs")?.scrollTop || 0);
  });
  document.querySelectorAll(".cluster-node[open]").forEach((details) => {
    const key = details.dataset.key;
    if (!key) return;
    state.openNodes.add(key);
    state.nestedScroll.set(`node:${key}`, details.querySelector(".node-jobs")?.scrollTop || 0);
  });
  return state;
}

function restoreClusterViewState(state) {
  if (!state) return;
  const users = document.querySelector(".cluster-users");
  const nodes = document.querySelector(".cluster-nodes");
  const queue = document.querySelector(".cluster-queue");
  if (users) users.scrollTop = Math.min(state.usersScroll, users.scrollHeight);
  if (nodes) nodes.scrollTop = Math.min(state.nodesScroll, nodes.scrollHeight);
  if (queue) queue.scrollTop = Math.min(state.queueScroll, queue.scrollHeight);
  state.nestedScroll.forEach((scrollTop, key) => {
    const [kind, id] = key.split(":");
    const selector = kind === "user"
      ? `.cluster-user[data-key="${CSS.escape(id)}"] .cluster-jobs`
      : `.cluster-node[data-key="${CSS.escape(id)}"] .node-jobs`;
    const element = document.querySelector(selector);
    if (element) element.scrollTop = Math.min(scrollTop, element.scrollHeight);
  });
}

function renderCluster(cluster) {
  setAuthPrompt(authModeForCluster(cluster));

  if (!cluster.reachable) {
    const note = document.createElement("p");
    note.className = "cluster-note";
    note.textContent = cluster.note || "cluster is not reachable";
    els.clusterStatus.replaceChildren(note);
    return;
  }

  const viewState = clusterViewState();
  const states = topCounts(cluster.states);
  const users = cluster.userSummaries || [];
  const gpuNodes = (cluster.nodes || []).filter((node) => node.gpu?.total);
  const totalGpu = gpuNodes.reduce((sum, node) => sum + (node.gpu?.total || 0), 0);
  const freeGpu = gpuNodes.reduce((sum, node) => sum + (node.gpu?.free || 0), 0);
  const maxJobs = Math.max(1, ...users.map((user) => user.jobCount || 0));
  const meta = document.createElement("p");
  meta.className = "cluster-meta";
  meta.textContent = `${states} · gpu unallocated ${freeGpu}/${totalGpu}`;

  const userList = document.createElement("div");
  userList.className = "cluster-users";
  userList.replaceChildren(...users.map((user) => renderUser(user, maxJobs, viewState.openUsers.has(user.id))));

  const nodeList = document.createElement("div");
  nodeList.className = "cluster-nodes";
  nodeList.replaceChildren(...gpuNodes.map((node) => {
    const rendered = renderNode(node);
    rendered.open = viewState.openNodes.has(node.name);
    return rendered;
  }));
  const queue = renderQueue(cluster.jobs || []);

  const userRule = document.createElement("hr");
  const nodeRule = document.createElement("hr");
  const queueRule = document.createElement("hr");
  els.clusterStatus.replaceChildren(meta, userRule, userList, nodeRule, nodeList, queueRule, queue);
  requestAnimationFrame(() => restoreClusterViewState(viewState));
}

async function refresh() {
  els.refreshButton.disabled = true;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "Could not reach hearth");
    const isDemo = payload.mode === "demo";
    els.modeBadge.hidden = !isDemo;
    document.body.classList.toggle("is-demo", isDemo);
    render(payload.snapshot, payload.piHost);
  } catch (error) {
    setStatus("error", error.message);
  } finally {
    els.refreshButton.disabled = false;
  }
}

async function scanNetwork() {
  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "Could not scan the network");
    renderNetwork(payload.network);
  } catch (error) {
    if (!els.deviceList.children.length) {
      const row = document.createElement("li");
      row.className = "device-offline";
      row.innerHTML = `<strong class="device-name">network unavailable</strong><span class="device-duration">--</span>`;
      els.deviceList.replaceChildren(row);
    }
  }
}

async function refreshCluster() {
  try {
    const response = await fetch("/api/cluster", { cache: "no-store" });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "Could not read cluster status");
    renderCluster(payload.cluster);
  } catch (error) {
    els.clusterStatus.textContent = error.message;
  }
}

async function submitSecret(event) {
  event.preventDefault();
  const password = els.authPassword.value;
  if (!password) return;
  els.authButton.disabled = true;
  els.authStatus.textContent = "sending";
  try {
    const response = await fetch("/api/secret", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hearth-secret": "1",
      },
      cache: "no-store",
      body: JSON.stringify({
        target: els.authTarget.value,
        password,
      }),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "password failed");
    els.authStatus.textContent = payload.message || "ok";
    await refreshCluster();
  } catch (error) {
    els.authStatus.textContent = error.message;
  } finally {
    els.authPassword.value = "";
    els.authButton.disabled = false;
  }
}

function tickTimes() {
  document.querySelectorAll(".live-time").forEach((element) => {
    if (element.dataset.running !== "true") return;
    const seconds = (Number.parseInt(element.dataset.seconds || "0", 10) || 0) + 1;
    element.dataset.seconds = String(seconds);
    element.textContent = formatDuration(seconds);
  });
}

els.refreshButton.addEventListener("click", refresh);
els.authForm.addEventListener("submit", submitSecret);
refresh();
scanNetwork();
refreshCluster();
setInterval(refresh, 4000);
setInterval(tickTimes, 1000);
setInterval(tickNetworkDurations, 30000);
setInterval(scanNetwork, 30000);
setInterval(refreshCluster, 15000);
