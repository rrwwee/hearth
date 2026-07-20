import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { uptime } from "node:os";
import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { demoBluetooth, demoCluster, demoNetwork, demoSnapshot } from "./demo/fixtures.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const appMode = (process.env.HEARTH_MODE || "demo").trim().toLowerCase();
if (!new Set(["demo", "live"]).has(appMode)) {
  throw new Error("HEARTH_MODE must be either 'demo' or 'live'.");
}
const demoMode = appMode === "demo";
const validateOnly = process.env.HEARTH_VALIDATE_ONLY === "1";
const setting = (name) => (process.env[name] || "").trim();
const requiredSetting = (name) => {
  const value = setting(name);
  if (!value) throw new Error(`${name} is required when HEARTH_MODE=live.`);
  return value;
};
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const bindHost = setting("HEARTH_BIND") || (demoMode ? "127.0.0.1" : "0.0.0.0");
const agentMode = demoMode ? "demo" : requiredSetting("HEARTH_AGENT_MODE");
if (!demoMode && !new Set(["local", "ssh"]).has(agentMode)) {
  throw new Error("HEARTH_AGENT_MODE must be either 'local' or 'ssh' in live mode.");
}
const piHost = demoMode ? "hearth-demo" : (agentMode === "ssh" ? requiredSetting("HEARTH_HOST") : setting("HEARTH_HOST") || "localhost");
const agentPath = demoMode ? "" : requiredSetting("HEARTH_AGENT");
const clusterPrincipal = setting("HEARTH_CLUSTER_PRINCIPAL");
const clusterJumpHost = setting("HEARTH_CLUSTER_JUMP");
const clusterProbeHost = setting("HEARTH_CLUSTER_PROBE_HOST");
const vpnHelperPath = setting("HEARTH_VPN_HELPER");
const stateDir = demoMode ? join(__dirname, ".demo-state") : requiredSetting("HEARTH_STATE_DIR");
const configDir = demoMode ? join(__dirname, "demo") : requiredSetting("HEARTH_CONFIG_DIR");
const eventLogPath = join(stateDir, "hearth-events.jsonl");
const notificationStatePath = join(stateDir, "notification-state.json");
const notificationConfigPath = join(configDir, "notifications.json");
const devicesConfigPath = join(configDir, "devices.json");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".svg", "image/svg+xml"],
]);

function safeText(value, maxLength = 1200) {
  return String(value ?? "")
    .replaceAll("\u0000", "")
    .slice(0, maxLength);
}

async function logEvent(event, fields = {}) {
  if (demoMode) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    source: "web",
    event,
    ...fields,
  });
  try {
    await mkdir(stateDir, { recursive: true });
    await appendFile(eventLogPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error(`diagnostic log failed: ${error.message}`);
  }
}

function runAgent(command, args = []) {
  if (demoMode) throw new Error("Agent execution is disabled in demo mode.");
  const traceId = randomUUID();
  const program = agentMode === "local" ? agentPath : "ssh";
  const commandArgs = agentMode === "local"
    ? [command, ...args]
    : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", piHost, agentPath, command, ...args];

  logEvent("agent.start", { traceId, command, mode: agentMode });
  return new Promise((resolve, reject) => {
    execFile(
      program,
      commandArgs,
      { timeout: command === "network" ? 45000 : 40000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          logEvent("agent.error", {
            traceId,
            command,
            code: error.code,
            signal: error.signal,
            stderr: safeText(stderr),
          });
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        try {
          const payload = JSON.parse(stdout);
          logEvent("agent.ok", {
            traceId,
            command,
            reachable: payload?.reachable,
            note: safeText(payload?.note, 240),
          });
          resolve(payload);
        } catch {
          logEvent("agent.bad_json", { traceId, command, stdout: safeText(stdout) });
          reject(new Error(`The Pi answered ${command}, but the response was not readable.`));
        }
      },
    );
  });
}

function isTailnetAddress(address) {
  const ipv4 = address.replace(/^::ffff:/, "");
  const parts = ipv4.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isSecureSource(request) {
  const remote = request.socket.remoteAddress || "";
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (forwardedProto === "https") return true;
  if (remote === "::1" || remote === "127.0.0.1" || remote === "::ffff:127.0.0.1") return true;
  return isTailnetAddress(remote);
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function readJsonBody(request, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Request body was not readable."));
      }
    });
    request.on("error", reject);
  });
}

function runSecretCommand(program, args, password, options = {}) {
  return new Promise((resolve, reject) => {
    const traceId = options.traceId || randomUUID();
    logEvent("secret.spawn", { traceId, program, args: args.map((arg) => safeText(arg, 160)), timeout: options.timeout || 20000 });
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: { ...process.env, HEARTH_TRACE_ID: traceId, HEARTH_STATE_DIR: stateDir, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      logEvent("secret.timeout", { traceId, program });
      child.kill("SIGTERM");
    }, options.timeout || 20000);
    let stdout = "";
    let stderr = "";
    const scrub = (text) => text.replaceAll(password, "[redacted]");
    child.stdout.on("data", (chunk) => {
      stdout += scrub(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr += scrub(chunk.toString());
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      logEvent("secret.spawn_error", { traceId, program, error: safeText(error.message) });
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      logEvent("secret.close", {
        traceId,
        program,
        code,
        stdout: safeText(stdout),
        stderr: safeText(stderr),
      });
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error((stderr || stdout || `${program} exited with code ${code}`).trim()));
      }
    });
    child.stdin.end(`${password}\n`);
  });
}

function canReachHost(host, port = 22, timeout = 4000) {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function connectCluster(password, traceId = randomUUID()) {
  if (!clusterPrincipal || !clusterJumpHost || !clusterProbeHost) {
    throw new Error("Cluster authentication is not configured. Set HEARTH_CLUSTER_PRINCIPAL, HEARTH_CLUSTER_JUMP, and HEARTH_CLUSTER_PROBE_HOST.");
  }
  await logEvent("cluster.connect.request", { traceId });
  const hasVpnPath = await canReachHost(clusterProbeHost);
  await logEvent("cluster.connect.vpn_path", { traceId, reachable: hasVpnPath });
  if (!hasVpnPath) {
    throw new Error("VPN is not connected yet. Send the VPN password first, then refresh cluster.");
  }

  await runSecretCommand("kinit", ["-f", clusterPrincipal], password, { timeout: 20000, traceId });

  await new Promise((resolve) => {
    execFile("ssh", ["-O", "exit", clusterJumpHost], { timeout: 5000 }, () => resolve());
  });

  await new Promise((resolve, reject) => {
    execFile(
      "ssh",
      ["-fN", "-o", "PreferredAuthentications=gssapi-with-mic", clusterJumpHost],
      { timeout: 12000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }
        resolve();
      },
    );
  });

  return { message: "cluster path refreshed", traceId };
}

async function connectVpn(password, traceId = randomUUID()) {
  if (!vpnHelperPath || !clusterProbeHost) {
    throw new Error("VPN authentication is not configured. Set HEARTH_VPN_HELPER and HEARTH_CLUSTER_PROBE_HOST.");
  }
  await logEvent("vpn.request", { traceId });
  await runSecretCommand(vpnHelperPath, [], password, { timeout: 6000, traceId });
  const hasVpnPath = await canReachHost(clusterProbeHost);
  await logEvent("vpn.post_check", { traceId, reachable: hasVpnPath });
  if (!hasVpnPath) {
    throw new Error("VPN tunnel started, but the configured cluster probe is still unreachable.");
  }
  await logEvent("vpn.accepted", { traceId });
  return { message: "vpn start requested", traceId };
}

async function handleSecret(request) {
  if (demoMode) throw new Error("Credential actions are disabled in demo mode.");
  const traceId = randomUUID();
  await logEvent("secret.request", {
    traceId,
    remote: safeText(request.socket.remoteAddress, 80),
    forwardedProto: safeText(request.headers["x-forwarded-proto"], 40),
    host: safeText(request.headers.host, 160),
    origin: safeText(request.headers.origin, 240),
    agentMode,
  });
  if (agentMode !== "local") {
    await logEvent("secret.reject", { traceId, reason: "not_local" });
    throw new Error("Password actions only run on the Pi-hosted dashboard.");
  }
  if (request.headers["x-hearth-secret"] !== "1" || !isSameOrigin(request)) {
    await logEvent("secret.reject", { traceId, reason: "origin_or_header" });
    throw new Error("Password request was not same-origin.");
  }
  if (!isSecureSource(request)) {
    await logEvent("secret.reject", { traceId, reason: "insecure_source" });
    throw new Error("Open this dashboard over Tailscale or HTTPS before sending a password.");
  }
  const body = await readJsonBody(request);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) throw new Error("Password is required.");
  await logEvent("secret.target", { traceId, target: safeText(body.target, 40), passwordLength: password.length });
  if (body.target === "cluster") return connectCluster(password, traceId);
  if (body.target === "vpn") return connectVpn(password, traceId);
  throw new Error("Unknown password target.");
}

async function diagnosticsPayload() {
  if (demoMode) return { mode: "demo", events: [] };
  let events = [];
  try {
    const raw = await readFile(eventLogPath, "utf8");
    events = raw.trim().split("\n").filter(Boolean).slice(-160).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    events = [];
  }
  return { stateDir, events };
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function validateLiveConfiguration() {
  if (demoMode) throw new Error("HEARTH_VALIDATE_ONLY requires HEARTH_MODE=live.");

  try {
    if (agentMode === "local") await access(agentPath, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new Error("The configured local agent is not readable and executable.");
  }

  try {
    const stateInfo = await stat(stateDir);
    if (!stateInfo.isDirectory()) throw new Error();
    await access(stateDir, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new Error("The configured state directory is not an accessible directory.");
  }

  const readRequiredJson = async (path, label) => {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new Error(`${label} configuration is missing or is not a JSON object.`);
    }
  };

  const devices = await readRequiredJson(devicesConfigPath, "Device");
  if (!devices.devices || typeof devices.devices !== "object" || Array.isArray(devices.devices)
      || Object.values(devices.devices).some((name) => typeof name !== "string")) {
    throw new Error("Device configuration must contain a devices object with string labels.");
  }

  const notifications = await readRequiredJson(notificationConfigPath, "Notification");
  if (typeof notifications.enabled !== "boolean") {
    throw new Error("Notification configuration must declare enabled as true or false.");
  }
  if (notifications.enabled) {
    if (typeof notifications.endpoint !== "string" || typeof notifications.topic !== "string" || !notifications.topic.trim()) {
      throw new Error("Enabled notifications require an endpoint and non-empty topic.");
    }
    try {
      new URL(notifications.endpoint);
    } catch {
      throw new Error("The notification endpoint is not a valid URL.");
    }
  }

  const cluster = await readRequiredJson(join(configDir, "cluster.json"), "Cluster");
  if (typeof cluster.scheduler !== "string" || typeof cluster.sshHost !== "string"
      || !Array.isArray(cluster.friends) || !Number.isFinite(Number(cluster.jobLimit))) {
    throw new Error("Cluster configuration has an invalid scheduler, SSH host, friends list, or job limit.");
  }

  let ntfy;
  try {
    ntfy = await readFile(join(configDir, "ntfy-server.yml"), "utf8");
  } catch {
    throw new Error("ntfy server configuration is missing or unreadable.");
  }
  if (!/^base-url\s*:/m.test(ntfy) || !/^listen-http\s*:/m.test(ntfy) || !/^cache-duration\s*:/m.test(ntfy)) {
    throw new Error("ntfy server configuration is missing a required setting.");
  }

  console.log("Live configuration validation passed: agent, state, devices, cluster, notifications, and ntfy.");
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function deviceNameKeys(body) {
  return [body.key, body.mac, body.ip]
    .map((value) => safeText(value, 120).trim().toLowerCase())
    .filter((value) => value && /^[a-z0-9:.:-]+$/i.test(value));
}

async function handleDeviceName(request) {
  if (demoMode) throw new Error("Device changes are disabled in demo mode.");
  if (!isSecureSource(request) || !isSameOrigin(request)) {
    throw new Error("Device names can only be changed from Hearth over Tailscale or HTTPS.");
  }
  const body = await readJsonBody(request, 2048);
  const keys = [...new Set(deviceNameKeys(body))];
  const name = safeText(body.name, 80).trim();
  if (keys.length === 0) throw new Error("No device address was supplied.");

  const config = await readJsonFile(devicesConfigPath, { devices: {} });
  const devices = config.devices && typeof config.devices === "object" ? config.devices : {};
  for (const key of keys) {
    if (name) {
      devices[key] = name;
    } else {
      delete devices[key];
    }
  }
  config.devices = Object.fromEntries(Object.entries(devices).sort(([a], [b]) => a.localeCompare(b)));
  await writeJsonFile(devicesConfigPath, config);
  await logEvent("network.device_name", { keys, name: name || null });
  return { keys, name };
}

async function notificationConfig() {
  if (demoMode) return { enabled: false };
  const config = await readJsonFile(notificationConfigPath, {});
  return {
    enabled: config.enabled === true,
    endpoint: config.endpoint || "https://ntfy.sh",
    topic: config.topic || "",
    dashboardUrl: config.dashboardUrl || "",
    networkUrl: config.networkUrl || "",
    token: config.token || "",
    pollMs: Number(config.pollMs) || 30000,
    networkPollMs: Number(config.networkPollMs) || 30000,
    networkJoinScans: Number(config.networkJoinScans) || 2,
    networkOnlineGraceMs: Number(config.networkOnlineGraceMs) || 10 * 60 * 1000,
    networkAwayMs: Number(config.networkAwayMs) || 45 * 60 * 1000,
    networkIdentityWindowMs: Number(config.networkIdentityWindowMs) || 45 * 60 * 1000,
    networkUnknownRetentionMs: Number(config.networkUnknownRetentionMs) || 7 * 24 * 60 * 60 * 1000,
    bluetoothPollMs: Number(config.bluetoothPollMs) || 5 * 60 * 1000,
    bluetoothScanSeconds: Number(config.bluetoothScanSeconds) || 8,
    reminderMs: Number(config.reminderMs) || 30 * 60 * 1000,
  };
}

async function publishNotification(kind, title, message, options = {}) {
  const config = await notificationConfig();
  if (!config.enabled || !config.topic) {
    await logEvent("notify.skip", { kind, reason: "disabled_or_missing_topic", title, message });
    return;
  }

  const endpoint = `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`;
  const headers = {
    "title": title,
    "priority": options.priority || "default",
    "tags": options.tags || "fire",
    "click": options.click || config.dashboardUrl,
  };
  if (config.cache === false) headers.cache = "no";
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: message,
    });
    await logEvent("notify.sent", {
      kind,
      title,
      status: response.status,
      ok: response.ok,
    });
  } catch (error) {
    await logEvent("notify.error", { kind, title, error: safeText(error.message) });
  }
}

function passwordNeedForCluster(cluster) {
  if (!cluster || cluster.reachable) return null;
  const note = `${cluster.note || ""}`.toLowerCase();
  if (
    note.includes("network is unreachable") ||
    note.includes("no route to host") ||
    note.includes("connection timed out") ||
    note.includes("vpn tunnel started")
  ) {
    return "vpn";
  }
  return "cluster";
}

function indexOwnJobs(cluster) {
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

function jobLabel(job) {
  return `${job.name || "job"} (${job.id})`;
}

function deviceKey(device) {
  return (device.mac || device.ip || "").toLowerCase();
}

function isMacAddress(value) {
  return /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(value || "");
}

function isPrivateMac(value) {
  if (!isMacAddress(value)) return false;
  return (Number.parseInt(value.slice(0, 2), 16) & 2) !== 0;
}

function deviceLabel(device) {
  const name = device.nickname || device.name;
  if (name) return name;
  if (device.vendor && device.mac) return `${device.vendor} ${device.mac}`;
  return device.ip || device.mac || "unknown device";
}

function formatElapsed(milliseconds) {
  const minutes = Math.max(1, Math.round(milliseconds / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function rememberNetworkEvent(state, type, device, now) {
  const events = Array.isArray(state.networkEvents) ? state.networkEvents : [];
  const key = device.key || deviceKey(device);
  const recentDuplicate = events.findLast?.((event) => (
    event.type === type
    && event.key === key
    && now - event.timestamp < 5 * 60 * 1000
  ));
  if (recentDuplicate) {
    recentDuplicate.timestamp = now;
    recentDuplicate.label = deviceLabel(device);
    recentDuplicate.ip = device.ip;
    recentDuplicate.mac = device.mac;
    recentDuplicate.bluetooth = device.bluetooth || recentDuplicate.bluetooth;
    recentDuplicate.lastSeen = device.lastSeen || recentDuplicate.lastSeen;
    recentDuplicate.awayDurationMs = device.awayDurationMs || recentDuplicate.awayDurationMs;
  } else {
    events.push({
      timestamp: now,
      type,
      key,
      label: deviceLabel(device),
      ip: device.ip,
      mac: device.mac,
      bluetooth: device.bluetooth || null,
      lastSeen: device.lastSeen || null,
      awayDurationMs: device.awayDurationMs || null,
    });
  }
  const keepAfter = now - 26 * 60 * 60 * 1000;
  state.networkEvents = events.filter((event) => event.timestamp >= keepAfter);
}

async function publishNewDeviceAlert(config, device) {
  const label = deviceLabel(device);
  const address = device.ip ? ` (${device.ip})` : "";
  await publishNotification(
    "network.first_seen",
    "New device seen on the network",
    `${label}${address} was seen for the first time.`,
    {
      tags: "mag",
      priority: "default",
      click: config.networkUrl,
    },
  );
}

function hourStart(timestamp) {
  return Math.floor(timestamp / 3600000) * 3600000;
}

async function publishNetworkHourlySummary(config, state, now) {
  const targetHour = hourStart(now) - 3600000;
  if (targetHour < 0 || state.networkSummarySentHour === targetHour) return;
  state.networkSummarySentHour = targetHour;
  const events = (state.networkEvents || [])
    .filter((event) => (
      event.timestamp >= targetHour
      && event.timestamp < targetHour + 3600000
      && ["away", "returned"].includes(event.type)
    ))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!events.length) return;

  const lines = events.slice(0, 20).map((event) => {
    const label = event.label || event.ip || "Unknown device";
    if (event.type === "returned") {
      return `${label} was seen again after ${formatElapsed(event.awayDurationMs || 0)}.`;
    }
    const unseenFor = Math.max(0, now - (event.lastSeen || event.timestamp));
    return `${label} was last seen ${formatElapsed(unseenFor)} ago.`;
  });
  if (events.length > lines.length) lines.push(`Plus ${events.length - lines.length} more changes.`);
  await publishNotification(
    "network.hourly_summary",
    "Network activity last hour",
    lines.join("\n"),
    { tags: "satellite", priority: "default", click: config.networkUrl },
  );
}

function indexNetworkDevices(network) {
  const devices = {};
  for (const device of network?.devices || []) {
    const key = deviceKey(device);
    // IP addresses are leases, not identities. Requiring a MAC here also
    // prevents a single bogus full-subnet scan from producing 250 events.
    if (!isMacAddress(key)) continue;
    devices[key] = {
      key,
      ip: device.ip,
      mac: device.mac,
      vendor: device.vendor,
      name: device.name,
      nickname: device.nickname,
    };
  }
  return devices;
}

async function networkDashboardPayload(force = false) {
  const [network, state, config, namesConfig] = await Promise.all([
    runAgent("network", force ? ["--force"] : []),
    readJsonFile(notificationStatePath, {}),
    notificationConfig(),
    readJsonFile(devicesConfigPath, { devices: {} }),
  ]);
  const now = Date.now();
  const names = Object.fromEntries(
    Object.entries(namesConfig.devices || {}).map(([key, name]) => [key.toLowerCase(), name]),
  );
  const liveDevices = network.devices || [];
  const liveKeys = new Set(liveDevices.map(deviceKey));
  const trackedDevices = state.networkDevices || {};
  const devices = new Map();

  for (const device of liveDevices) {
    const key = deviceKey(device);
    const tracked = trackedDevices[key] || {};
    const lastSeenMs = network.timestamp * 1000;
    const localOnlineSince = device.mac ? null : now - uptime() * 1000;
    devices.set(key, {
      ...device,
      nickname: names[key] || names[(device.ip || "").toLowerCase()] || device.nickname,
      lastSeen: network.timestamp,
      onlineSince: Math.floor((tracked.onlineSince || localOnlineSince || lastSeenMs) / 1000),
      status: "online",
    });
  }

  for (const [key, tracked] of Object.entries(trackedDevices)) {
    if (!isMacAddress(key) || liveKeys.has(key) || tracked.replacedBy) continue;
    const lastSeenMs = Number(tracked.lastSeen) || 0;
    const nickname = names[key] || names[(tracked.ip || "").toLowerCase()] || tracked.nickname;
    if (!nickname && now - lastSeenMs > config.networkUnknownRetentionMs) continue;
    devices.set(key, {
      ip: tracked.ip,
      mac: tracked.mac,
      vendor: tracked.vendor,
      name: tracked.name,
      nickname,
      lastSeen: Math.floor(lastSeenMs / 1000),
      onlineSince: Math.floor((tracked.onlineSince || lastSeenMs) / 1000),
      status: now - lastSeenMs < config.networkOnlineGraceMs ? "online" : "offline",
      away: now - lastSeenMs >= config.networkAwayMs,
    });
  }

  const sortedDevices = [...devices.values()].sort((a, b) => (
    (a.status === "online" ? 0 : 1) - (b.status === "online" ? 0 : 1)
    || (a.status === "online"
      ? (a.onlineSince || a.lastSeen || 0) - (b.onlineSince || b.lastSeen || 0)
      : (b.lastSeen || 0) - (a.lastSeen || 0))
    || deviceLabel(a).localeCompare(deviceLabel(b))
  ));
  const counts = Object.fromEntries(
    ["online", "offline"].map((status) => [
      status,
      sortedDevices.filter((device) => device.status === status).length,
    ]),
  );
  return { ...network, devices: sortedDevices, counts };
}

function candidateLabel(device) {
  return device.nickname || device.name || device.vendor || device.ip || device.key;
}

function bluetoothDeviceKey(device) {
  return String(device?.address || "").toLowerCase();
}

function bluetoothDeviceLabel(device) {
  if (device?.name) return device.name;
  if ((device?.manufacturerIds || []).includes(76)) return "Apple device";
  return device?.address || "unknown Bluetooth device";
}

function compareBluetoothSnapshots(before, after) {
  if (!before?.available || !after?.available) {
    return {
      confidence: "unavailable",
      summary: "Bluetooth comparison unavailable",
      disappeared: [],
      appeared: [],
    };
  }
  const previous = new Map((before.devices || []).map((device) => [bluetoothDeviceKey(device), device]));
  const current = new Map((after.devices || []).map((device) => [bluetoothDeviceKey(device), device]));
  const disappeared = [...previous]
    .filter(([key]) => !current.has(key))
    .map(([, device]) => device);
  const appeared = [...current]
    .filter(([key]) => !previous.has(key))
    .map(([, device]) => device);
  const parts = [];
  if (disappeared.length) {
    parts.push(`Bluetooth missing: ${disappeared.slice(0, 3).map(bluetoothDeviceLabel).join(", ")}`);
  }
  if (appeared.length) {
    parts.push(`Bluetooth appeared: ${appeared.slice(0, 3).map(bluetoothDeviceLabel).join(", ")}`);
  }
  return {
    confidence: disappeared.length === 1 ? "possible" : (disappeared.length ? "ambiguous" : "none"),
    summary: parts.join("; ") || "no Bluetooth change observed",
    disappeared,
    appeared,
    beforeTimestamp: before.timestamp || null,
    afterTimestamp: after.timestamp || null,
  };
}

async function scanBluetooth(config) {
  return runAgent("bluetooth", ["--scan", "--scan-seconds", String(config.bluetoothScanSeconds)]);
}

async function learnDeviceAlias(device, nickname) {
  if (!nickname || !isMacAddress(device.mac)) return;
  const config = await readJsonFile(devicesConfigPath, { devices: {} });
  const devices = config.devices && typeof config.devices === "object" ? config.devices : {};
  const key = device.mac.toLowerCase();
  if (devices[key] === nickname) return;
  devices[key] = nickname;
  config.devices = Object.fromEntries(Object.entries(devices).sort(([a], [b]) => a.localeCompare(b)));
  await writeJsonFile(devicesConfigPath, config);
}

async function updateNetworkNotifications(config, state, now) {
  if (now - (state.networkCheckedAt || 0) < config.networkPollMs) return;
  state.networkCheckedAt = now;

  if (state.networkTrackingVersion !== 4) {
    // Version 4 adds continuous presence sessions. Estimate existing session
    // starts from their accumulated successful observations.
    if ((state.networkTrackingVersion || 0) < 3) state.networkEvents = [];
    for (const device of Object.values(state.networkDevices || {})) {
      device.present = now - (device.lastSeen || 0) < config.networkAwayMs;
      device.pendingJoin = false;
      device.firstSeen = false;
      if (!device.onlineSince && device.lastSeen) {
        const observations = Math.max(1, Number(device.seenScans) || 1);
        const observedMs = (observations - 1) * config.networkPollMs;
        device.onlineSince = Math.max(device.lastSeen - observedMs, device.lastSeen - 30 * 24 * 60 * 60 * 1000);
      }
    }
    state.networkTrackingVersion = 4;
  }

  const network = await runAgent("network", ["--force"]);
  const current = indexNetworkDevices(network);
  const tracked = Object.fromEntries(
    Object.entries(state.networkDevices || {}).filter(([key]) => isMacAddress(key)),
  );
  state.networkEvents = (state.networkEvents || []).filter((event) => isMacAddress(event.mac));
  const hasNetworkBaseline = Object.keys(tracked).length > 0;
  const departedDevices = [];

  if (state.initialized && hasNetworkBaseline) {
    for (const [key, previous] of Object.entries(tracked)) {
      if (current[key]) continue;
      const missedScans = (previous.missedScans || 0) + 1;
      previous.missedScans = missedScans;
      if (!previous.missingSince) {
        previous.missingSince = now;
        previous.bluetoothBefore = state.bluetoothSnapshot || null;
      }
      if (previous.present !== false && now - (previous.lastSeen || 0) >= config.networkAwayMs) {
        previous.present = false;
        departedDevices.push(previous);
      }
      tracked[key] = previous;
    }

    const claimedCandidates = new Set();
    for (const [key, device] of Object.entries(current)) {
      const previous = tracked[key];
      if (previous) {
        if (previous.present === false && !previous.replacedBy) {
          device.pendingJoin = true;
          device.returning = true;
          device.onlineSince = now;
          previous.seenScans = 0;
        }
        continue;
      }

      const candidates = Object.values(tracked).filter((candidate) => (
        !current[candidate.key]
        && !claimedCandidates.has(candidate.key)
        && candidate.missingSince
        && now - candidate.missingSince <= config.networkIdentityWindowMs
        && isPrivateMac(candidate.mac) === isPrivateMac(device.mac)
      ));

      if (candidates.length === 1) {
        const candidate = candidates[0];
        claimedCandidates.add(candidate.key);
        device.identityKey = candidate.identityKey || candidate.key;
        device.nickname ||= candidate.nickname;
        device.inferredFrom = candidate.key;
        candidate.present = false;
        candidate.replacedBy = key;
        candidate.leftNotified = true;
        rememberNetworkEvent(state, "address_changed", {
          ...device,
          label: deviceLabel(device),
        }, now);
        await learnDeviceAlias(device, device.nickname);
      } else if (candidates.length > 1) {
        device.possibleIdentityKeys = candidates.map((candidate) => candidate.identityKey || candidate.key);
        device.identityConfidence = "uncertain";
        device.nickname = `uncertain: ${candidates.map(candidateLabel).slice(0, 3).join(" or ")}`;
        rememberNetworkEvent(state, "uncertain", device, now);
      } else {
        device.pendingJoin = true;
        device.firstSeen = true;
        device.onlineSince = now;
      }
    }
  }

  for (const [key, device] of Object.entries(current)) {
    const previous = tracked[key] || {};
    const seenScans = (previous.seenScans || 0) + 1;
    tracked[key] = {
      ...previous,
      ...device,
      identityKey: device.identityKey || previous.identityKey || key,
      present: true,
      lastSeen: now,
      onlineSince: device.onlineSince || previous.onlineSince || now,
      missingSince: null,
      missedScans: 0,
      seenScans,
    };
    if ((device.pendingJoin || previous.pendingJoin) && seenScans >= config.networkJoinScans) {
      const firstSeen = device.firstSeen || previous.firstSeen;
      if (firstSeen) {
        rememberNetworkEvent(state, "first_seen", tracked[key], now);
        await publishNewDeviceAlert(config, tracked[key]);
      } else {
        rememberNetworkEvent(state, "returned", {
          ...tracked[key],
          awayDurationMs: previous.lastSeen ? now - previous.lastSeen : config.networkAwayMs,
        }, now);
      }
      tracked[key].pendingJoin = false;
      tracked[key].firstSeen = false;
      tracked[key].returning = false;
    }
  }

  if (departedDevices.length) {
    let bluetoothAfter;
    try {
      bluetoothAfter = await scanBluetooth(config);
      state.bluetoothSnapshot = bluetoothAfter;
      state.bluetoothCheckedAt = now;
    } catch (error) {
      bluetoothAfter = { available: false, devices: [], timestamp: Math.floor(now / 1000) };
      await logEvent("bluetooth.scan_error", { error: safeText(error.message) });
    }
    for (const device of departedDevices) {
      const departed = {
        ...device,
        bluetooth: compareBluetoothSnapshots(device.bluetoothBefore, bluetoothAfter),
      };
      rememberNetworkEvent(state, "away", departed, now);
      delete device.bluetoothBefore;
    }
  } else if (now - (state.bluetoothCheckedAt || 0) >= config.bluetoothPollMs) {
    try {
      state.bluetoothSnapshot = await scanBluetooth(config);
      state.bluetoothCheckedAt = now;
    } catch (error) {
      await logEvent("bluetooth.scan_error", { error: safeText(error.message) });
    }
  }

  state.networkDevices = tracked;
  await publishNetworkHourlySummary(config, state, now);
}

async function runNotificationMonitor() {
  const config = await notificationConfig();
  if (!config.enabled) return;

  const state = await readJsonFile(notificationStatePath, {
    initialized: false,
    jobs: {},
    networkDevices: {},
    networkEvents: [],
    networkCheckedAt: 0,
    networkSummarySentHour: 0,
    bluetoothSnapshot: null,
    bluetoothCheckedAt: 0,
    passwordNeed: null,
    passwordNotifiedAt: 0,
  });

  try {
    const cluster = await runAgent("cluster");
    const now = Date.now();
    const previousJobs = state.jobs || {};
    const currentJobs = cluster.reachable ? indexOwnJobs(cluster) : previousJobs;

    if (state.initialized) {
      for (const job of Object.values(currentJobs)) {
        const previous = previousJobs[job.id];
        if (job.state === "RUNNING" && previous?.state !== "RUNNING") {
          await publishNotification(
            "job.running",
            "Cluster job started",
            `${jobLabel(job)} is now running.`,
            { tags: "rocket", priority: "default" },
          );
        }
      }

      for (const previous of Object.values(previousJobs)) {
        if (previous.state !== "RUNNING") continue;
        const current = currentJobs[previous.id];
        if (!current) {
          await publishNotification(
            "job.finished",
            "Cluster job finished",
            `${jobLabel(previous)} is no longer in the Slurm queue.`,
            { tags: "white_check_mark", priority: "default" },
          );
        } else if (current.state !== "RUNNING") {
          await publishNotification(
            "job.stopped_running",
            "Cluster job stopped running",
            `${jobLabel(current)} changed from RUNNING to ${current.state}.`,
            { tags: "warning", priority: "default" },
          );
        }
      }
    }

    const passwordNeed = passwordNeedForCluster(cluster);
    const shouldRemind = passwordNeed
      && (state.passwordNeed !== passwordNeed || now - (state.passwordNotifiedAt || 0) > config.reminderMs);
    if (shouldRemind) {
      await publishNotification(
        `${passwordNeed}.password_needed`,
        passwordNeed === "vpn" ? "Hearth VPN needs password" : "Hearth cluster needs password",
        passwordNeed === "vpn"
          ? "Tap to open Hearth and enter the university VPN password."
          : "Tap to open Hearth and refresh the cluster login.",
        { tags: "key", priority: "high", click: config.dashboardUrl },
      );
      state.passwordNotifiedAt = now;
    }

    await updateNetworkNotifications(config, state, now);
    state.initialized = true;
    state.jobs = currentJobs;
    state.passwordNeed = passwordNeed;
    await writeJsonFile(notificationStatePath, state);
  } catch (error) {
    await logEvent("notify.monitor_error", { error: safeText(error.message) });
  }
}

async function startNotificationMonitor() {
  if (demoMode) return;
  const config = await notificationConfig();
  if (!config.enabled) {
    await logEvent("notify.monitor_disabled");
    return;
  }
  await logEvent("notify.monitor_start", {
    endpoint: config.endpoint,
    topic: config.topic,
    pollMs: config.pollMs,
  });
  runNotificationMonitor();
  setInterval(runNotificationMonitor, config.pollMs);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const routes = new Map([
  ["/api/snapshot", () => demoMode ? demoSnapshot() : runAgent("snapshot")],
  ["/api/network", (url) => demoMode ? demoNetwork() : networkDashboardPayload(url.searchParams.get("force") === "1")],
  ["/api/bluetooth", () => demoMode ? demoBluetooth() : runAgent("bluetooth")],
  ["/api/cluster", () => demoMode ? demoCluster() : runAgent("cluster")],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/api/secret" && request.method === "POST") {
    try {
      const payload = await handleSecret(request);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: true, ...payload }));
    } catch (error) {
      response.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (url.pathname === "/api/diagnostics" && request.method === "GET") {
    if (!isSecureSource(request) || !isSameOrigin(request)) {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "Forbidden" }));
      return;
    }
    const payload = await diagnosticsPayload();
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ ok: true, diagnostics: payload }));
    return;
  }

  if (url.pathname === "/api/device-name" && request.method === "POST") {
    try {
      const payload = await handleDeviceName(request);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: true, ...payload }));
    } catch (error) {
      response.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  const handler = routes.get(url.pathname);

  if (handler) {
    try {
      const payload = await handler(url);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, [url.pathname.slice(5)]: payload, piHost, mode: appMode }));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: error.message, piHost }));
    }
    return;
  }

  await serveStatic(request, response);
});

if (validateOnly) {
  await validateLiveConfiguration();
} else {
  server.listen(port, bindHost, () => {
    console.log(`Hearth is glowing at http://${bindHost}:${port} (${appMode} mode)`);
    const source = demoMode ? "fictional in-process fixtures" : agentMode === "local" ? agentPath : `ssh ${piHost}:${agentPath}`;
    console.log(`Reading dashboard data from ${source}`);
    startNotificationMonitor();
  });
}
