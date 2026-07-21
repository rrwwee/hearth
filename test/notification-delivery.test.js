import test from "node:test";
import assert from "node:assert/strict";
import { createExclusiveRunner, sendNtfy } from "../lib/notification-delivery.js";

test("exclusive notification runner skips overlapping passes and recovers afterward", async () => {
  let calls = 0;
  let overlaps = 0;
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const runner = createExclusiveRunner(async () => {
    calls += 1;
    if (calls === 1) await firstCanFinish;
  }, () => { overlaps += 1; });

  const first = runner();
  assert.equal(await runner(), false);
  assert.equal(calls, 1);
  assert.equal(overlaps, 1);

  releaseFirst();
  assert.equal(await first, true);
  assert.equal(await runner(), true);
  assert.equal(calls, 2);
});

test("ntfy delivery carries a stable sequence and rejects HTTP errors", async () => {
  const config = {
    endpoint: "https://notify.example.invalid/",
    topic: "private topic",
    dashboardUrl: "https://hearth.example.invalid/",
    deliveryTimeoutMs: 1000,
    cache: false,
    token: "test-token",
  };
  let request;
  const response = await sendNtfy(config, {
    title: "Job started",
    message: "job (1) is running",
    tags: "rocket",
    sequenceId: "hearth-job-1",
  }, async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  });

  assert.equal(response.status, 200);
  assert.equal(request.url, "https://notify.example.invalid/private%20topic");
  assert.equal(request.options.headers["x-sequence-id"], "hearth-job-1");
  assert.equal(request.options.headers.cache, "no");
  assert.equal(request.options.headers.authorization, "Bearer test-token");

  await assert.rejects(
    sendNtfy(config, { title: "Failure", message: "not delivered" }, async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
});
