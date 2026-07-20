import test from "node:test";
import assert from "node:assert/strict";
import { demoBluetooth, demoCluster, demoNetwork, demoSnapshot } from "../demo/fixtures.js";

test("demo fixtures cover every dashboard surface", () => {
  const snapshot = demoSnapshot();
  const network = demoNetwork();
  const cluster = demoCluster();
  const bluetooth = demoBluetooth();

  assert.equal(snapshot.host, "hearth-demo");
  assert.equal(snapshot.cores.length, 4);
  assert.ok(snapshot.processes.length >= 4);
  assert.ok(network.devices.some((device) => device.status === "online"));
  assert.ok(network.devices.some((device) => device.status === "offline"));
  assert.equal(cluster.reachable, true);
  assert.ok(cluster.jobs.some((job) => job.state === "RUNNING"));
  assert.ok(cluster.jobs.some((job) => job.state === "PENDING"));
  assert.ok(cluster.nodes.every((node) => Number.isFinite(node.averageWatts)));
  assert.equal(bluetooth.note, "demo fixture");
});

test("demo fixture timestamps are relative to the current run", () => {
  const before = Math.floor(Date.now() / 1000);
  const network = demoNetwork();
  const after = Math.floor(Date.now() / 1000);
  assert.ok(network.timestamp >= before && network.timestamp <= after);
  assert.ok(network.devices.every((device) => (device.lastSeen || device.onlineSince) <= after));
});
