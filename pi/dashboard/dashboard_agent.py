#!/usr/bin/env python3
import argparse
import ipaddress
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

BASE_DIR = Path(os.environ.get("HEARTH_BASE_DIR", Path.home() / "Code" / "dashboard")).expanduser()
STATE_DIR = Path(os.environ.get("HEARTH_STATE_DIR", BASE_DIR / "state")).expanduser()
CONFIG_DIR = Path(os.environ.get("HEARTH_CONFIG_DIR", BASE_DIR / "config")).expanduser()
CLUSTER_PROBE_HOST = os.environ.get("HEARTH_CLUSTER_PROBE_HOST", "").strip()
CLUSTER_JUMP_ALIAS = os.environ.get("HEARTH_CLUSTER_JUMP", "").strip()
STATE_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def read(path, fallback=None):
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return fallback


def command(args, timeout=5):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=timeout).strip()


def run(args, timeout=8):
    try:
        return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        return subprocess.CompletedProcess(
            args,
            124,
            stdout=error.stdout or "",
            stderr=f"timed out after {timeout}s",
        )


def tcp_check(host, port=22, timeout=3):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def cluster_health(slurm_ok=False, slurm_note=None):
    vpn_ok = bool(CLUSTER_PROBE_HOST) and tcp_check(CLUSTER_PROBE_HOST, 22, timeout=3)
    ticket = run(["klist", "-s"], timeout=3)
    ticket_ok = ticket.returncode == 0
    jump = run(["ssh", "-O", "check", CLUSTER_JUMP_ALIAS], timeout=4) if CLUSTER_JUMP_ALIAS else None
    jump_ok = bool(jump and jump.returncode == 0)
    checks = [
        {
            "key": "vpn",
            "label": "vpn",
            "ok": vpn_ok,
            "state": "ok" if vpn_ok else ("not configured" if not CLUSTER_PROBE_HOST else "needs password"),
            "detail": "cluster route reachable" if vpn_ok else ("set HEARTH_CLUSTER_PROBE_HOST" if not CLUSTER_PROBE_HOST else "cluster route not reachable"),
        },
        {
            "key": "ticket",
            "label": "login",
            "ok": ticket_ok,
            "state": "ok" if ticket_ok else "needs password",
            "detail": "kerberos ticket present" if ticket_ok else "kerberos ticket missing",
        },
        {
            "key": "jump",
            "label": "jump",
            "ok": jump_ok,
            "state": "ok" if jump_ok else "stale",
            "detail": "background path open" if jump_ok else "background path needs refresh",
        },
        {
            "key": "slurm",
            "label": "slurm",
            "ok": bool(slurm_ok),
            "state": "ok" if slurm_ok else "blocked",
            "detail": slurm_note or ("cluster answered" if slurm_ok else "cluster has not answered"),
        },
    ]
    return {"ok": all(check["ok"] for check in checks), "checks": checks}


def thermal_c():
    raw = read("/sys/class/thermal/thermal_zone0/temp")
    if raw and raw.isdigit():
        return round(int(raw) / 1000, 1)
    try:
        output = command(["vcgencmd", "measure_temp"], timeout=1)
        return float(output.split("=")[1].split("'")[0])
    except Exception:
        return None


def vcgencmd_value(args, pattern):
    try:
        output = command(["vcgencmd"] + args, timeout=2)
        match = re.search(pattern, output)
        return match.group(1) if match else None
    except Exception:
        return None


def voltage():
    value = vcgencmd_value(["measure_volts"], r"volt=([0-9.]+)V")
    return round(float(value), 3) if value else None


def throttled():
    raw = vcgencmd_value(["get_throttled"], r"throttled=(0x[0-9a-fA-F]+)")
    if not raw:
        return {"raw": None, "ok": None, "flags": []}
    value = int(raw, 16)
    meanings = {
        0: "under-voltage",
        1: "frequency-capped",
        2: "throttled",
        3: "soft-temp-limit",
        16: "under-voltage-history",
        17: "frequency-capped-history",
        18: "throttled-history",
        19: "soft-temp-limit-history",
    }
    return {
        "raw": raw,
        "ok": value == 0,
        "flags": [label for bit, label in meanings.items() if value & (1 << bit)],
    }


def disk_root():
    usage = shutil.disk_usage("/")
    return {
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
        "percent": round((usage.used / usage.total) * 100, 1),
    }


def meminfo():
    values = {}
    for line in (read("/proc/meminfo", "") or "").splitlines():
        key, value = line.split(":", 1)
        values[key] = int(value.strip().split()[0]) * 1024
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    return {
        "total": total,
        "available": available,
        "usedPercent": round(((total - available) / total) * 100, 1) if total and available else None,
    }


def cpu_times():
    cores = {}
    for line in (read("/proc/stat", "") or "").splitlines():
        parts = line.split()
        if not parts or not re.fullmatch(r"cpu\d+", parts[0]):
            continue
        values = [int(value) for value in parts[1:]]
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        cores[parts[0]] = {"idle": idle, "total": sum(values)}
    return cores


def cpu_usage():
    path = STATE_DIR / "cpu-prev.json"
    current = cpu_times()
    previous = {}
    if path.exists():
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            previous = {}
    path.write_text(json.dumps(current), encoding="utf-8")

    usage = []
    for name in sorted(current, key=lambda value: int(value[3:])):
        prev = previous.get(name)
        percent = None
        if prev:
            total_delta = current[name]["total"] - prev.get("total", 0)
            idle_delta = current[name]["idle"] - prev.get("idle", 0)
            if total_delta > 0:
                percent = round(max(0, min(100, (1 - idle_delta / total_delta) * 100)), 1)
        usage.append({"name": name, "percent": percent})
    return usage


def user_processes():
    try:
        output = command(["ps", "-eo", "user=,pid=,comm=,pcpu=,pmem=,args=", "--sort=-pcpu"], timeout=3)
    except Exception:
        return []
    ignored = {"ps", "sshd-session", "sshd-auth", "nmap"}
    current_pid = os.getpid()
    processes = []
    for line in output.splitlines():
        parts = line.split(None, 5)
        if len(parts) != 6:
            continue
        user, pid, command_name, cpu, mem, args = parts
        pid = int(pid)
        if (
            pid == current_pid
            or command_name in ignored
            or command_name.startswith("kworker/")
            or "dashboard_agent.py" in args
        ):
            continue
        if user == "root" and command_name not in {"tailscaled", "dockerd", "containerd", "python3", "nmap", "sshd"}:
            continue
        processes.append({
            "user": user,
            "pid": pid,
            "command": command_name,
            "cpuPercent": float(cpu),
            "memoryPercent": float(mem),
        })
        if len(processes) >= 8:
            break
    return processes


def update_history(item):
    history_path = STATE_DIR / "snapshots.jsonl"
    now = item["timestamp"]
    keep_after = now - 24 * 60 * 60
    entries = []
    if history_path.exists():
        for line in history_path.read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("timestamp", 0) >= keep_after:
                entries.append(entry)
    if not entries or now - entries[-1].get("timestamp", 0) >= 60:
        entries.append({
            "timestamp": now,
            "temperatureC": item.get("temperatureC"),
            "load": item.get("load", [None])[0],
            "memoryUsedPercent": item.get("memory", {}).get("usedPercent"),
            "diskUsedPercent": item.get("disk", {}).get("percent"),
        })
    entries = entries[-1440:]
    history_path.write_text("\n".join(json.dumps(entry) for entry in entries) + ("\n" if entries else ""), encoding="utf-8")
    return entries[-12:]


def snapshot():
    uptime_seconds = float((read("/proc/uptime", "0") or "0").split()[0])
    item = {
        "host": socket.gethostname(),
        "platform": platform.platform(),
        "arch": platform.machine(),
        "timestamp": int(time.time()),
        "uptimeSeconds": round(uptime_seconds),
        "temperatureC": thermal_c(),
        "voltage": voltage(),
        "throttled": throttled(),
        "cores": cpu_usage(),
        "processes": user_processes(),
        "load": [round(load, 2) for load in os.getloadavg()],
        "memory": meminfo(),
        "disk": disk_root(),
    }
    item["history"] = update_history(item)
    return item


def lan_cidr():
    route = command(["ip", "route"], timeout=5)
    for line in route.splitlines():
        if " proto kernel " in line and " scope link " in line and " dev docker" not in line:
            cidr = line.split()[0]
            try:
                network = ipaddress.ip_network(cidr, strict=False)
            except ValueError:
                continue
            if network.version == 4 and network.is_private:
                return str(network)
    configured = os.environ.get("HEARTH_LAN_CIDR", "").strip()
    if configured:
        try:
            return str(ipaddress.ip_network(configured, strict=False))
        except ValueError as error:
            raise RuntimeError("HEARTH_LAN_CIDR is not a valid network.") from error
    raise RuntimeError("No private LAN route was detected. Set HEARTH_LAN_CIDR in the local environment file.")


def local_ipv4_addresses():
    try:
        return {
            value
            for value in command(["hostname", "-I"], timeout=3).split()
            if ipaddress.ip_address(value).version == 4
        }
    except Exception:
        return set()


def nmap_scan(cidr):
    try:
        xml = command(["sudo", "-n", "nmap", "-sn", "-PR", "-oX", "-", cidr], timeout=35)
    except Exception:
        xml = command(["nmap", "-sn", "-oX", "-", cidr], timeout=35)
    root = ET.fromstring(xml)
    devices = []
    for host in root.findall("host"):
        status = host.find("status")
        if status is not None and status.attrib.get("state") != "up":
            continue
        addresses = {address.attrib.get("addrtype"): address.attrib for address in host.findall("address")}
        ip = addresses.get("ipv4", {}).get("addr")
        mac = addresses.get("mac", {}).get("addr")
        vendor = addresses.get("mac", {}).get("vendor")
        names = [name.attrib.get("name") for name in host.findall("./hostnames/hostname") if name.attrib.get("name")]
        if ip:
            devices.append({"ip": ip, "mac": mac, "vendor": vendor, "name": names[0] if names else None})
    return devices


def neighbor_table():
    output = command(["ip", "neigh", "show"], timeout=5)
    devices = {}
    for line in output.splitlines():
        match = re.match(r"(?P<ip>\d+\.\d+\.\d+\.\d+)\s+dev\s+(?P<dev>\S+)(?:\s+lladdr\s+(?P<mac>[0-9a-f:]+))?\s+(?P<state>\S+)", line, re.I)
        if match and match.group("state") != "FAILED":
            devices[match.group("ip")] = {
                "ip": match.group("ip"),
                "mac": match.group("mac"),
                "vendor": None,
                "name": None,
                "neighborState": match.group("state").upper(),
            }
    return devices


def load_device_names():
    path = CONFIG_DIR / "devices.json"
    if not path.exists():
        path.write_text(json.dumps({"devices": {}}, indent=2) + "\n", encoding="utf-8")
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("devices", {})
    except json.JSONDecodeError:
        return {}


def apply_device_names(devices):
    names = load_device_names()
    for device in devices:
        nickname = names.get(device.get("ip")) or names.get((device.get("mac") or "").lower())
        if nickname:
            device["nickname"] = nickname
    return devices


def append_presence(network):
    path = STATE_DIR / "presence.jsonl"
    entry = {
        "timestamp": network["timestamp"],
        "cidr": network["cidr"],
        "devices": [
            {"ip": item.get("ip"), "mac": item.get("mac"), "nickname": item.get("nickname")}
            for item in network["devices"]
        ],
    }
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")


def network_scan(force=False):
    cache_path = STATE_DIR / "network-cache.json"
    now = int(time.time())
    if not force and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if now - cached.get("timestamp", 0) < 10 * 60:
                return cached
        except json.JSONDecodeError:
            pass
    cidr = lan_cidr()
    try:
        devices = nmap_scan(cidr)
        neighbors = neighbor_table()
        known_ips = {device["ip"] for device in devices}
        for device in devices:
            neighbor = neighbors.get(device["ip"])
            if neighbor and not device.get("mac"):
                device["mac"] = neighbor.get("mac")
        network = ipaddress.ip_network(cidr, strict=False)
        devices.extend(
            device for ip, device in neighbors.items()
            if (
                ip not in known_ips
                and ipaddress.ip_address(ip) in network
                and device.get("neighborState") == "REACHABLE"
            )
        )
        source = "nmap"
    except Exception:
        devices = list(neighbor_table().values())
        source = "neighbor table"
    devices = apply_device_names(devices)
    # A broken or proxy-ARP-influenced nmap scan can report every address in a
    # /24 as alive without supplying a MAC address. Those are not persistent
    # device observations. Keep MAC-backed devices plus Hearth's own local IP,
    # and discard every other IP-only result even if it has an old nickname.
    local_ips = local_ipv4_addresses()
    devices = [device for device in devices if device.get("mac") or device.get("ip") in local_ips]
    devices.sort(key=lambda item: tuple(int(part) for part in item["ip"].split(".")))
    result = {"cidr": cidr, "source": source, "timestamp": now, "devices": devices}
    cache_path.write_text(json.dumps(result), encoding="utf-8")
    append_presence(result)
    return result


def bluetooth_info():
    try:
        info = command(["btmgmt", "info"], timeout=5)
        available = True
    except Exception:
        info = ""
        available = False
    return {"available": available, "summary": info.splitlines()[:12]}


def bluetooth_scan(scan_seconds=8):
    scan_seconds = max(3, min(int(scan_seconds), 20))
    result = run([
        "bluetoothctl",
        "--timeout",
        str(scan_seconds),
        "scan",
        "on",
    ], timeout=scan_seconds + 4)
    output = re.sub(r"\x1b\[[0-9;]*m", "", f"{result.stdout or ''}\n{result.stderr or ''}")
    devices = {}
    for line in output.splitlines():
        match = re.search(r"\bDevice\s+(?P<address>[0-9A-F:]{17})\b", line, re.I)
        if match:
            address = match.group("address").upper()
            device = devices.setdefault(address, {
                "address": address,
                "addressType": None,
                "rssi": -127,
                "name": None,
                "manufacturerIds": [],
            })
            rssi = re.search(r"RSSI:\s+(?:0x[0-9a-f]+\s+)?\((-?\d+)\)", line, re.I)
            if rssi:
                device["rssi"] = max(device["rssi"], int(rssi.group(1)))

    for device in devices.values():
        info = run(["bluetoothctl", "info", device["address"]], timeout=3)
        address_type = re.search(rf"Device\s+{re.escape(device['address'])}\s+\((random|public)\)", info.stdout or "", re.I)
        name = re.search(r"^\s*Name:\s+(.+)$", info.stdout or "", re.I | re.M)
        manufacturer_ids = {
            int(value, 16)
            for value in re.findall(r"ManufacturerData\.Key:\s+0x([0-9a-f]+)", info.stdout or "", re.I)
        }
        device["addressType"] = address_type.group(1).lower() if address_type else None
        device["name"] = name.group(1).strip() if name else None
        device["manufacturerIds"] = sorted(manufacturer_ids)

    return {
        "available": result.returncode == 0,
        "timestamp": int(time.time()),
        "scanSeconds": scan_seconds,
        "devices": sorted(devices.values(), key=lambda item: (-item["rssi"], item["address"])),
        "note": None if devices else (result.stderr or "no Bluetooth advertisements heard").strip()[:240],
    }


def load_cluster_config():
    path = CONFIG_DIR / "cluster.json"
    config = {}
    if path.exists():
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Cluster configuration is not valid JSON: {path}") from error
    ssh_host = str(config.get("sshHost") or os.environ.get("HEARTH_CLUSTER_HOST") or "").strip()
    jump_host = str(config.get("jumpHost") or os.environ.get("HEARTH_CLUSTER_JUMP") or "").strip()
    user = str(config.get("user") or os.environ.get("HEARTH_CLUSTER_USER") or "").strip()
    return {
        "configured": bool(ssh_host and jump_host and user),
        "scheduler": config.get("scheduler", "slurm"),
        "sshHost": ssh_host,
        "jumpHost": jump_host,
        "user": user,
        "friends": {str(friend) for friend in config.get("friends", [])},
    }


TERMINAL_JOB_STATES = {
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
}


def parse_cluster_sections(output):
    sections = {
        "host": [],
        "partitions": [],
        "jobs": [],
        "starts": [],
        "passwd": [],
        "accounting": [],
        "nodes": [],
    }
    current = None
    for line in output.splitlines():
        if line == "__HOST__":
            current = "host"
            continue
        if line == "__SINFO__":
            current = "partitions"
            continue
        if line == "__SQUEUE__":
            current = "jobs"
            continue
        if line == "__SQUEUE_START__":
            current = "starts"
            continue
        if line == "__PASSWD__":
            current = "passwd"
            continue
        if line == "__SACCT__":
            current = "accounting"
            continue
        if line == "__NODES__":
            current = "nodes"
            continue
        if current:
            sections[current].append(line)
    return sections


def parse_partitions(lines):
    partitions = []
    for line in lines:
        parts = line.split("|")
        if len(parts) != 5:
            continue
        partitions.append({
            "name": parts[0].rstrip("*"),
            "default": parts[0].endswith("*"),
            "availability": parts[1],
            "nodes": parts[2],
            "state": parts[3],
            "cpus": parts[4],
        })
    return partitions


def duration_seconds(value):
    if not value or value == "INVALID":
        return 0
    days = 0
    time_part = value
    if "-" in value:
        day_part, time_part = value.split("-", 1)
        try:
            days = int(day_part)
        except ValueError:
            days = 0
    pieces = [int(piece) for piece in time_part.split(":") if piece.isdigit()]
    if len(pieces) == 3:
        hours, minutes, seconds = pieces
    elif len(pieces) == 2:
        hours = 0
        minutes, seconds = pieces
    elif len(pieces) == 1:
        hours = 0
        minutes = 0
        seconds = pieces[0]
    else:
        hours = minutes = seconds = 0
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def sortable_time(value):
    if not value or value in {"N/A", "Unknown"}:
        return ""
    return value


def expand_hostlist(value):
    if not value or value.startswith("("):
        return []
    hosts = []
    for part in value.split(","):
        match = re.fullmatch(r"([A-Za-z_-]+)\[(.+)\]", part)
        if not match:
            hosts.append(part)
            continue
        prefix, ranges = match.groups()
        for item in ranges.split(","):
            if "-" in item:
                start, end = item.split("-", 1)
                width = max(len(start), len(end))
                try:
                    hosts.extend(f"{prefix}{number:0{width}d}" for number in range(int(start), int(end) + 1))
                except ValueError:
                    hosts.append(f"{prefix}{item}")
            else:
                hosts.append(f"{prefix}{item}")
    return hosts


def parse_start_estimates(lines):
    estimates = {}
    for line in lines:
        parts = line.split("|", 2)
        if len(parts) != 3:
            continue
        estimates[parts[0]] = {
            "priority": int(parts[1]) if parts[1].isdigit() else None,
            "estimatedStart": parts[2] if parts[2] not in {"N/A", "Unknown", "None"} else None,
        }
    return estimates


def parse_jobs(lines, names, estimates=None):
    estimates = estimates or {}
    jobs = []
    for line in lines:
        parts = line.split("|", 9)
        if len(parts) != 10:
            continue
        state = parts[2]
        node_list = expand_hostlist(parts[6]) if state == "RUNNING" else []
        estimate = estimates.get(parts[0], {})
        jobs.append({
            "id": parts[0],
            "user": parts[1],
            "userName": names.get(parts[1]),
            "state": state,
            "time": parts[3],
            "durationSeconds": duration_seconds(parts[3]),
            "submittedAt": parts[4],
            "submittedSort": sortable_time(parts[4]),
            "nodeCount": int(parts[5]) if parts[5].isdigit() else None,
            "nodeList": node_list,
            "reason": parts[6],
            "cpus": int(parts[7]) if parts[7].isdigit() else None,
            "gres": "" if parts[8] in {"(null)", "N/A"} else parts[8],
            "name": parts[9],
            "priority": estimate.get("priority"),
            "estimatedStart": estimate.get("estimatedStart"),
        })
    return jobs


def parse_accounting(lines):
    available = bool(lines and lines[0] == "__AVAILABLE__")
    if not available:
        return False, []

    jobs = []
    for line in lines[1:]:
        parts = line.split("|", 7)
        if len(parts) != 8:
            continue
        state = parts[2].split()[0].split("+")[0].upper()
        if state not in TERMINAL_JOB_STATES:
            continue
        jobs.append({
            "id": parts[0],
            "user": parts[1],
            "state": state,
            "time": parts[3],
            "submittedAt": None if parts[4] in {"", "Unknown", "N/A"} else parts[4],
            "startedAt": None if parts[5] in {"", "Unknown", "N/A"} else parts[5],
            "endedAt": None if parts[6] in {"", "Unknown", "N/A"} else parts[6],
            "name": parts[7],
        })
    return True, jobs


def sort_jobs(jobs):
    def key(job):
        if job["state"] == "RUNNING":
            return (0, -job.get("durationSeconds", 0), job["name"])
        if job["state"] == "PENDING":
            return (1, job.get("submittedSort") or "", job["name"])
        return (2, job["state"], job["name"])
    return sorted(jobs, key=key)


def parse_passwd(lines):
    users = {}
    for line in lines:
        parts = line.split(":")
        if len(parts) < 5:
            continue
        login = parts[0]
        name = parts[4].split(",", 1)[0].strip()
        if login and name:
            users[login] = name
    return users


def load_user_cache():
    path = STATE_DIR / "user-cache.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_user_cache(users):
    path = STATE_DIR / "user-cache.json"
    path.write_text(json.dumps(users, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_tres(value):
    result = {}
    for item in (value or "").split(","):
        if "=" not in item:
            continue
        key, raw = item.split("=", 1)
        try:
            result[key] = int(raw.rstrip("M"))
        except ValueError:
            result[key] = raw
    return result


def parse_gres(value):
    match = re.search(r"gpu(?::(?P<type>[^:(]+))?:(?P<count>\d+)", value or "")
    if not match:
        return {"type": None, "total": 0}
    return {"type": match.group("type") or "gpu", "total": int(match.group("count"))}


def tres_gpu_count(values):
    if "gres/gpu" in values:
        try:
            return int(values["gres/gpu"])
        except (TypeError, ValueError):
            return 0
    total = 0
    for key, value in values.items():
        if key == "gres/gpu" or key.startswith("gres/gpu:"):
            try:
                total += int(value)
            except (TypeError, ValueError):
                pass
    return total


def parse_scontrol_line(line):
    values = {}
    for match in re.finditer(r"(\w+)=(.*?)(?=\s+\w+=|$)", line):
        values[match.group(1)] = match.group(2).strip()
    return values


def decorate_nodes(nodes, jobs):
    jobs_by_node = {node["name"]: [] for node in nodes}
    for job in jobs:
        if job.get("state") != "RUNNING":
            continue
        for node_name in job.get("nodeList", []):
            if node_name in jobs_by_node:
                jobs_by_node[node_name].append({
                    "id": job["id"],
                    "name": job["name"],
                    "user": job["user"],
                    "userName": job.get("userName"),
                    "friend": job.get("friend", False),
                    "time": job["time"],
                    "durationSeconds": job.get("durationSeconds", 0),
                    "cpus": job.get("cpus"),
                    "gres": job.get("gres"),
                })
    for node in nodes:
        node_jobs = sorted(jobs_by_node.get(node["name"], []), key=lambda item: -item.get("durationSeconds", 0))
        node["jobs"] = node_jobs
        node["jobCount"] = len(node_jobs)
    return nodes


def parse_nodes(lines, jobs):
    def number(value, converter=int):
        try:
            return converter(value or 0)
        except (TypeError, ValueError):
            return converter(0)

    nodes = []
    for line in lines:
        values = parse_scontrol_line(line)
        if not values.get("NodeName"):
            continue
        cfg = parse_tres(values.get("CfgTRES"))
        alloc = parse_tres(values.get("AllocTRES"))
        gpu = parse_gres(values.get("Gres"))
        allocated_gpu = tres_gpu_count(alloc)
        total_gpu = max(gpu["total"], tres_gpu_count(cfg), allocated_gpu)
        total_cpu = number(values.get("CPUTot") or cfg.get("cpu", 0))
        allocated_cpu = number(values.get("CPUAlloc") or alloc.get("cpu", 0))
        real_memory = number(values.get("RealMemory"))
        allocated_memory = number(values.get("AllocMem"))
        nodes.append({
            "name": values["NodeName"],
            "state": values.get("State", "").lower(),
            "partitions": [part.strip() for part in values.get("Partitions", "").split(",") if part.strip()],
            "cpu": {
                "allocated": allocated_cpu,
                "total": total_cpu,
                "percent": round((allocated_cpu / total_cpu) * 100, 1) if total_cpu else None,
                "load": number(values.get("CPULoad"), float),
            },
            "memory": {
                "allocatedMb": allocated_memory,
                "totalMb": real_memory,
                "freeMb": number(values.get("FreeMem")),
                "percent": round((allocated_memory / real_memory) * 100, 1) if real_memory else None,
            },
            "gpu": {
                "type": gpu["type"],
                "allocated": int(allocated_gpu or 0),
                "total": int(total_gpu or 0),
                "free": max(0, int(total_gpu or 0) - int(allocated_gpu or 0)),
            },
            "watts": number(values.get("CurrentWatts")),
            "averageWatts": number(values.get("AveWatts")),
        })
    return decorate_nodes(sorted(nodes, key=lambda item: item["name"]), jobs)


def summarize_users(jobs, names, friend_ids):
    grouped = {}
    for job in jobs:
        user = job["user"]
        if user not in grouped:
            grouped[user] = {
                "id": user,
                "name": names.get(user),
                "jobCount": 0,
                "running": 0,
                "pending": 0,
                "longestRunningSeconds": 0,
                "firstQueuedAt": None,
                "friend": user in friend_ids,
                "jobs": [],
            }
        grouped[user]["jobCount"] += 1
        if job["state"] == "RUNNING":
            grouped[user]["running"] += 1
            grouped[user]["longestRunningSeconds"] = max(
                grouped[user]["longestRunningSeconds"],
                job.get("durationSeconds", 0),
            )
        if job["state"] == "PENDING":
            grouped[user]["pending"] += 1
            queued_at = job.get("submittedSort") or None
            current = grouped[user]["firstQueuedAt"]
            if queued_at and (current is None or queued_at < current):
                grouped[user]["firstQueuedAt"] = queued_at
        grouped[user]["jobs"].append(job)
    for user in grouped.values():
        user["jobs"] = sort_jobs(user["jobs"])
    return sorted(
        grouped.values(),
        key=lambda item: (
            -item["jobCount"],
            -item["running"],
            -item["longestRunningSeconds"],
            item["firstQueuedAt"] or "9999-12-31T23:59:59",
            item.get("name") or item["id"],
        ),
    )


def counts_by(items, key):
    counts = {}
    for item in items:
        value = item.get(key) or "unknown"
        counts[value] = counts.get(value, 0) + 1
    return counts


def cluster_status():
    config = load_cluster_config()
    if not config["configured"]:
        note = "Cluster is not configured. Copy cluster.example.json to the ignored local config directory."
        return {
            "configured": False,
            "reachable": False,
            "scheduler": config["scheduler"],
            "note": note,
            "health": cluster_health(False, note),
        }
    ssh_host = config["sshHost"]
    jump_host = config["jumpHost"]
    accounting_user = shlex.quote(config["user"])
    remote_script = "; ".join([
        "printf '%s\\n' __HOST__",
        "hostname",
        "printf '%s\\n' __SINFO__",
        "command -v sinfo >/dev/null 2>&1 && sinfo -h -o '%P|%a|%D|%t|%C' | head -40",
        "printf '%s\\n' __SQUEUE__",
        "command -v squeue >/dev/null 2>&1 && squeue -h -o '%i|%u|%T|%M|%V|%D|%R|%C|%b|%j'",
        "printf '%s\\n' __SQUEUE_START__",
        "command -v squeue >/dev/null 2>&1 && squeue --start -h -t PENDING -o '%i|%Q|%S'",
        "printf '%s\\n' __PASSWD__",
        "users=$(command -v squeue >/dev/null 2>&1 && squeue -h -o '%u' | sort -u | tr '\\n' ' '); [ -n \"$users\" ] && getent passwd $users || true",
        "printf '%s\\n' __SACCT__",
        f"if command -v sacct >/dev/null 2>&1 && accounting_output=$(sacct -X -n -P -S now-2days -u {accounting_user} -o JobIDRaw,User,State,Elapsed,Submit,Start,End,JobName 2>/dev/null); then printf '%s\\n' __AVAILABLE__; printf '%s\\n' \"$accounting_output\"; else printf '%s\\n' __UNAVAILABLE__; fi",
        "printf '%s\\n' __NODES__",
        "command -v scontrol >/dev/null 2>&1 && scontrol show nodes -o | head -100",
    ])
    remote_command = " ".join([
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=6",
        shlex.quote(ssh_host),
        shlex.quote(remote_script),
    ])
    ssh = run([
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=6",
        "-o", "StrictHostKeyChecking=accept-new",
        jump_host,
        remote_command,
    ], timeout=35)

    if ssh.returncode != 0:
        reason = (ssh.stderr or ssh.stdout or "").strip().splitlines()
        note = reason[-1] if reason else "The configured cluster is not reachable from Hearth yet"
        if (
            "Permission denied" in note
            or "Connection closed by UNKNOWN port 65535" in note
            or "Connection to UNKNOWN port 65535 timed out" in note
        ):
            note = "refresh the configured jump connection with connect-cluster-control.sh"
        return {
            "configured": True,
            "reachable": False,
            "scheduler": config["scheduler"],
            "sshHost": ssh_host,
            "jumpHost": config["jumpHost"],
            "user": config["user"],
            "note": note,
            "health": cluster_health(False, note),
        }

    sections = parse_cluster_sections(ssh.stdout)
    partitions = parse_partitions(sections["partitions"])
    cached_users = load_user_cache()
    discovered_users = parse_passwd(sections["passwd"])
    if discovered_users:
        cached_users.update(discovered_users)
        save_user_cache(cached_users)
    jobs = sort_jobs(parse_jobs(sections["jobs"], cached_users, parse_start_estimates(sections["starts"])))
    accounting_available, terminal_jobs = parse_accounting(sections["accounting"])
    for job in jobs:
        job["friend"] = job["user"] in config["friends"]
    nodes = parse_nodes(sections["nodes"], jobs)
    return {
        "configured": True,
        "reachable": True,
        "scheduler": config["scheduler"],
        "sshHost": ssh_host,
        "jumpHost": config["jumpHost"],
        "user": config["user"],
        "host": sections["host"][0] if sections["host"] else ssh_host,
        "timestamp": int(time.time()),
        "partitions": partitions,
        "jobs": jobs,
        "accountingAvailable": accounting_available,
        "terminalJobs": terminal_jobs,
        "userSummaries": summarize_users(jobs, cached_users, config["friends"]),
        "nodes": nodes,
        "states": counts_by(jobs, "state"),
        "users": counts_by(jobs, "user"),
        "health": cluster_health(True, "cluster answered"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["snapshot", "network", "presence", "bluetooth", "cluster"])
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--scan", action="store_true")
    parser.add_argument("--scan-seconds", type=int, default=8)
    args = parser.parse_args()
    if args.command == "snapshot":
        data = snapshot()
    elif args.command in {"network", "presence"}:
        data = network_scan(force=args.force or args.command == "presence")
    elif args.command == "bluetooth":
        data = bluetooth_scan(args.scan_seconds) if args.scan else bluetooth_info()
    else:
        data = cluster_status()
    print(json.dumps(data))


if __name__ == "__main__":
    main()
