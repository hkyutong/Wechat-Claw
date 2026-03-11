import { createHash } from "node:crypto";

export const WEBHOOK_AUTH_QUERY_PARAM = "token";

export function buildWebhookAuthToken(accountId: string, apiKey: string): string {
  return createHash("sha256")
    .update(`yutoai-wechat:${accountId}:${apiKey}`)
    .digest("hex")
    .slice(0, 24);
}

export function attachWebhookAuthToken(webhookUrl: string, authToken: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set(WEBHOOK_AUTH_QUERY_PARAM, authToken);
  return url.toString();
}
