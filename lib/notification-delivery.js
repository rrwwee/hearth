export function createExclusiveRunner(run, onOverlap = () => {}) {
  let running = false;
  return async (...args) => {
    if (running) {
      await onOverlap();
      return false;
    }
    running = true;
    try {
      await run(...args);
      return true;
    } finally {
      running = false;
    }
  };
}

export async function sendNtfy(config, notification, fetchImplementation = fetch) {
  const endpoint = `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`;
  const headers = {
    title: notification.title,
    priority: notification.priority || "default",
    tags: notification.tags || "fire",
    click: notification.click || config.dashboardUrl,
  };
  if (notification.sequenceId) headers["x-sequence-id"] = notification.sequenceId;
  if (config.cache === false) headers.cache = "no";
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  const response = await fetchImplementation(endpoint, {
    method: "POST",
    headers,
    body: notification.message,
    signal: AbortSignal.timeout(config.deliveryTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`notification endpoint returned HTTP ${response.status}`);
  }
  return response;
}
