function normalizeWebhookPath(webhookPath: string): string {
  const trimmed = webhookPath.trim();
  if (!trimmed) {
    return "/webhook/wechat";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function buildWebhookBaseUrl(params: {
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
}): string {
  const { webhookHost, webhookPort, webhookPath } = params;
  const normalizedPath = normalizeWebhookPath(webhookPath);
  const trimmedHost = webhookHost.trim();

  if (!trimmedHost) {
    throw new Error("webhookHost 不能为空");
  }

  if (/^https?:\/\//i.test(trimmedHost)) {
    const url = new URL(trimmedHost);
    url.pathname = normalizedPath;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const url = new URL(`http://${trimmedHost}`);
  if (!url.port) {
    url.port = String(webhookPort);
  }
  url.pathname = normalizedPath;
  url.search = "";
  url.hash = "";
  return url.toString();
}
