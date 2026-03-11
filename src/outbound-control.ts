import type { ResolvedWeChatAccount } from "./types.js";
import {
  getOutboundCircuitState,
  recordLoggedOutState,
  recordOutboundFailureState,
  recordOutboundSuccessState,
} from "./account-state.js";
import { computeExponentialBackoffMs, resolveStabilityProfile, sleepWithAbort } from "./stability.js";

const outboundQueues = new Map<string, Promise<unknown>>();
const outboundNextAvailableAt = new Map<string, number>();

function isRetryableSendError(message: string): boolean {
  return /fetch failed|timeout|timed out|temporarily|temporarily unavailable|connection|ECONNRESET|EPIPE|socket|429|502|503|504/i
    .test(message);
}

function isLoggedOutError(message: string): boolean {
  return /未登录|离线|offline|not\s*login|no\s*login|重新登录/i.test(message);
}

function queueByAccount<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const previous = outboundQueues.get(accountId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(task);

  const tracked = current
    .catch(() => undefined)
    .finally(() => {
      if (outboundQueues.get(accountId) === tracked) {
        outboundQueues.delete(accountId);
      }
    });

  outboundQueues.set(accountId, tracked);

  return current;
}

export async function sendWithOutboundControl<T>(params: {
  account: ResolvedWeChatAccount;
  log?: (message: string) => void;
  send: () => Promise<T>;
  signal?: AbortSignal;
}): Promise<T> {
  const { account, log, send, signal } = params;
  const profile = resolveStabilityProfile(account);

  return queueByAccount(account.accountId, async () => {
    const outboundState = getOutboundCircuitState(account, profile);
    if (outboundState.circuitOpenUntil && outboundState.circuitOpenUntil > Date.now()) {
      const reopenInMs = outboundState.circuitOpenUntil - Date.now();
      throw new Error(`出站熔断中，${Math.ceil(reopenInMs / 1000)} 秒后再试`);
    }

    const nextAvailableAt = outboundNextAvailableAt.get(account.accountId) ?? 0;
    if (nextAvailableAt > Date.now()) {
      await sleepWithAbort(nextAvailableAt - Date.now(), signal);
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= profile.outboundRetryCount; attempt++) {
      try {
        const result = await send();
        recordOutboundSuccessState(account, profile);
        outboundNextAvailableAt.set(account.accountId, Date.now() + profile.outboundMinIntervalMs);
        return result;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const message = lastError.message || String(lastError);

        if (isLoggedOutError(message)) {
          recordLoggedOutState(account, profile, message);
        }

        const failureState = recordOutboundFailureState(account, profile, message);
        const isLastAttempt = attempt >= profile.outboundRetryCount;
        const retryable = isRetryableSendError(message);

        if (failureState.circuitOpenUntil && failureState.circuitOpenUntil > Date.now()) {
          throw new Error(`出站熔断已开启: ${message}`);
        }

        if (!retryable || isLastAttempt) {
          throw lastError;
        }

        const delayMs = computeExponentialBackoffMs(
          attempt,
          profile.outboundRetryDelayMs,
          profile.outboundMaxRetryDelayMs
        );
        log?.(`wechat[${account.accountId}] 出站发送失败，${delayMs}ms 后重试: ${message}`);
        await sleepWithAbort(delayMs, signal);
      }
    }

    throw lastError || new Error("未知发送失败");
  });
}
