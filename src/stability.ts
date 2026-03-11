import type { ResolvedWeChatAccount } from "./types.js";

export type WechatStabilityProfile = {
  qrThrottleMs: number;
  qrDisplayThrottleMs: number;
  loginPollIntervalMs: number;
  loginTimeoutMs: number;
  startupBaseBackoffMs: number;
  startupMaxBackoffMs: number;
  startupCircuitBreakerThreshold: number;
  startupCircuitOpenMs: number;
  outboundMinIntervalMs: number;
  outboundRetryCount: number;
  outboundRetryDelayMs: number;
  outboundMaxRetryDelayMs: number;
  outboundCircuitBreakerThreshold: number;
  outboundCircuitOpenMs: number;
  statusProbeIntervalMs: number;
  statusProbeFailureThreshold: number;
  stateFile?: string;
};

const DEFAULT_STABILITY_PROFILE: WechatStabilityProfile = {
  qrThrottleMs: 90_000,
  qrDisplayThrottleMs: 30_000,
  loginPollIntervalMs: 5_000,
  loginTimeoutMs: 5 * 60_000,
  startupBaseBackoffMs: 15_000,
  startupMaxBackoffMs: 10 * 60_000,
  startupCircuitBreakerThreshold: 4,
  startupCircuitOpenMs: 15 * 60_000,
  outboundMinIntervalMs: 1_500,
  outboundRetryCount: 3,
  outboundRetryDelayMs: 2_000,
  outboundMaxRetryDelayMs: 20_000,
  outboundCircuitBreakerThreshold: 5,
  outboundCircuitOpenMs: 5 * 60_000,
  statusProbeIntervalMs: 60_000,
  statusProbeFailureThreshold: 3,
};

export function resolveStabilityProfile(account: ResolvedWeChatAccount): WechatStabilityProfile {
  const operations = account.config.operations ?? {};
  return {
    qrThrottleMs: operations.qrThrottleMs ?? DEFAULT_STABILITY_PROFILE.qrThrottleMs,
    qrDisplayThrottleMs: operations.qrDisplayThrottleMs ?? DEFAULT_STABILITY_PROFILE.qrDisplayThrottleMs,
    loginPollIntervalMs: operations.loginPollIntervalMs ?? DEFAULT_STABILITY_PROFILE.loginPollIntervalMs,
    loginTimeoutMs: operations.loginTimeoutMs ?? DEFAULT_STABILITY_PROFILE.loginTimeoutMs,
    startupBaseBackoffMs: operations.startupBaseBackoffMs ?? DEFAULT_STABILITY_PROFILE.startupBaseBackoffMs,
    startupMaxBackoffMs: operations.startupMaxBackoffMs ?? DEFAULT_STABILITY_PROFILE.startupMaxBackoffMs,
    startupCircuitBreakerThreshold:
      operations.startupCircuitBreakerThreshold ?? DEFAULT_STABILITY_PROFILE.startupCircuitBreakerThreshold,
    startupCircuitOpenMs: operations.startupCircuitOpenMs ?? DEFAULT_STABILITY_PROFILE.startupCircuitOpenMs,
    outboundMinIntervalMs: operations.outboundMinIntervalMs ?? DEFAULT_STABILITY_PROFILE.outboundMinIntervalMs,
    outboundRetryCount: operations.outboundRetryCount ?? DEFAULT_STABILITY_PROFILE.outboundRetryCount,
    outboundRetryDelayMs: operations.outboundRetryDelayMs ?? DEFAULT_STABILITY_PROFILE.outboundRetryDelayMs,
    outboundMaxRetryDelayMs:
      operations.outboundMaxRetryDelayMs ?? DEFAULT_STABILITY_PROFILE.outboundMaxRetryDelayMs,
    outboundCircuitBreakerThreshold:
      operations.outboundCircuitBreakerThreshold ?? DEFAULT_STABILITY_PROFILE.outboundCircuitBreakerThreshold,
    outboundCircuitOpenMs: operations.outboundCircuitOpenMs ?? DEFAULT_STABILITY_PROFILE.outboundCircuitOpenMs,
    statusProbeIntervalMs: operations.statusProbeIntervalMs ?? DEFAULT_STABILITY_PROFILE.statusProbeIntervalMs,
    statusProbeFailureThreshold:
      operations.statusProbeFailureThreshold ?? DEFAULT_STABILITY_PROFILE.statusProbeFailureThreshold,
    stateFile: operations.stateFile,
  };
}

export function computeExponentialBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  const delay = baseDelayMs * (2 ** exponent);
  return Math.min(maxDelayMs, delay);
}

export function computeQrThrottleDelayMs(
  lastIssuedAt: number | null | undefined,
  qrThrottleMs: number,
  now = Date.now()
): number {
  if (!lastIssuedAt || qrThrottleMs <= 0) {
    return 0;
  }
  return Math.max(0, lastIssuedAt + qrThrottleMs - now);
}

export function shouldRenderQRCodeAgain(params: {
  lastRenderedSessionId?: string | null;
  currentSessionId: string;
  lastRenderedAt?: number;
  displayThrottleMs: number;
  now?: number;
}): boolean {
  const {
    lastRenderedSessionId,
    currentSessionId,
    lastRenderedAt,
    displayThrottleMs,
    now = Date.now(),
  } = params;

  if (lastRenderedSessionId !== currentSessionId) {
    return true;
  }

  if (!lastRenderedAt) {
    return true;
  }

  return now - lastRenderedAt >= displayThrottleMs;
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  if (signal.aborted) {
    throw new Error("流程已中止");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("流程已中止"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
