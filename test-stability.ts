import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ResolvedWeChatAccount } from "./src/types.js";
import {
  getLastQrIssuedAt,
  getStartupCircuitState,
  hydrateAccountFromPersistentState,
  recordLoginSuccessState,
  recordPendingLoginState,
  recordStartupFailureState,
} from "./src/account-state.js";
import { sendWithOutboundControl } from "./src/outbound-control.js";
import {
  computeQrThrottleDelayMs,
  resolveStabilityProfile,
  shouldRenderQRCodeAgain,
} from "./src/stability.js";

function buildAccount(stateFile: string, accountId = "default"): ResolvedWeChatAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    name: "OpenClaw",
    provider: "wechatpadpro",
    apiKey: "wc_live_test",
    proxyUrl: "http://127.0.0.1:1238",
    wcId: undefined,
    isLoggedIn: false,
    nickName: undefined,
    deviceType: "ipad",
    proxy: "2",
    webhookPort: 18792,
    webhookPath: "/webhook/wechat",
    webhookIncludeSelfMessage: false,
    webhookRetryCount: 3,
    webhookTimeoutSec: 10,
    webhookTimestampSkewSec: 300,
    config: {
      apiKey: "wc_live_test",
      proxyUrl: "http://127.0.0.1:1238",
      operations: {
        stateFile,
        outboundRetryCount: 3,
        outboundRetryDelayMs: 10,
        outboundMaxRetryDelayMs: 20,
        outboundMinIntervalMs: 5,
        outboundCircuitBreakerThreshold: 3,
        outboundCircuitOpenMs: 100,
      },
    },
  };
}

async function testPersistentLoginState() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "wechat-claw-state-"));
  const stateFile = path.join(tempDir, "wechat-state.json");

  try {
    const account = buildAccount(stateFile, "persist");
    const profile = resolveStabilityProfile(account);
    recordLoginSuccessState(account, profile, {
      wcId: "wxid_persisted",
      nickName: "Persisted User",
      headUrl: "https://cdn.example.com/avatar.png",
    });

    const hydrated = buildAccount(stateFile, "persist");
    hydrateAccountFromPersistentState(hydrated, resolveStabilityProfile(hydrated));

    assert.equal(hydrated.wcId, "wxid_persisted");
    assert.equal(hydrated.nickName, "Persisted User");
    assert.equal(hydrated.headUrl, "https://cdn.example.com/avatar.png");
    assert.equal(hydrated.isLoggedIn, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testOutboundRetryAndCircuit() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "wechat-claw-send-"));
  const stateFile = path.join(tempDir, "wechat-state.json");

  try {
    const account = buildAccount(stateFile, "retry");
    let attempts = 0;

    const result = await sendWithOutboundControl({
      account,
      send: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("fetch failed");
        }
        return { msgId: 3 };
      },
    });

    assert.equal(result.msgId, 3);
    assert.equal(attempts, 3, "应在成功前重试两次");

    const failureAccount = buildAccount(stateFile, "circuit");
    failureAccount.config.operations = {
      ...failureAccount.config.operations,
      outboundRetryCount: 1,
      outboundCircuitBreakerThreshold: 2,
      outboundCircuitOpenMs: 200,
    };

    await assert.rejects(
      () => sendWithOutboundControl({
        account: failureAccount,
        send: async () => {
          throw new Error("fetch failed");
        },
      }),
      /fetch failed/
    );

    await assert.rejects(
      () => sendWithOutboundControl({
        account: failureAccount,
        send: async () => {
          throw new Error("fetch failed");
        },
      }),
      /出站熔断已开启/
    );

    await assert.rejects(
      () => sendWithOutboundControl({
        account: failureAccount,
        send: async () => {
          throw new Error("should not reach sender");
        },
      }),
      /出站熔断中/
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testQrThrottleAndStartupCircuit() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "wechat-claw-qr-"));
  const stateFile = path.join(tempDir, "wechat-state.json");

  try {
    const account = buildAccount(stateFile, "qr");
    account.config.operations = {
      ...account.config.operations,
      qrThrottleMs: 90_000,
      qrDisplayThrottleMs: 30_000,
      startupCircuitBreakerThreshold: 2,
      startupCircuitOpenMs: 180_000,
    };
    const profile = resolveStabilityProfile(account);
    const issuedAt = Date.now() - 20_000;

    recordPendingLoginState(account, profile, {
      wId: "w_123",
      qrCodeUrl: "https://example.com/qr.png",
      issuedAt,
      expiresAt: issuedAt + profile.loginTimeoutMs,
      lastRenderedAt: issuedAt,
    });

    assert.equal(getLastQrIssuedAt(account, profile), issuedAt);
    assert.equal(computeQrThrottleDelayMs(issuedAt, profile.qrThrottleMs, issuedAt + 20_000), 70_000);
    assert.equal(
      shouldRenderQRCodeAgain({
        lastRenderedSessionId: "w_123",
        currentSessionId: "w_123",
        lastRenderedAt: issuedAt + 10_000,
        displayThrottleMs: profile.qrDisplayThrottleMs,
        now: issuedAt + 20_000,
      }),
      false
    );
    assert.equal(
      shouldRenderQRCodeAgain({
        lastRenderedSessionId: "w_123",
        currentSessionId: "w_123",
        lastRenderedAt: issuedAt,
        displayThrottleMs: profile.qrDisplayThrottleMs,
        now: issuedAt + 31_000,
      }),
      true
    );

    const firstFailure = recordStartupFailureState(account, profile, "timeout");
    assert.equal(firstFailure.consecutiveFailures, 1);
    assert.equal(firstFailure.circuitOpenUntil, undefined);

    const secondFailure = recordStartupFailureState(account, profile, "timeout");
    assert.equal(secondFailure.consecutiveFailures, 2);
    assert.ok(secondFailure.circuitOpenUntil && secondFailure.circuitOpenUntil > Date.now());
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testLegacyAbortCircuitIsIgnored() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "wechat-claw-legacy-circuit-"));
  const stateFile = path.join(tempDir, "wechat-state.json");

  try {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      accounts: {
        legacy: {
          startup: {
            consecutiveFailures: 8,
            lastFailureAt: Date.now(),
            lastError: "流程已中止",
            circuitOpenUntil: Date.now() + 900_000,
          },
        },
      },
    }), "utf8");

    const account = buildAccount(stateFile, "legacy");
    const circuit = getStartupCircuitState(account, resolveStabilityProfile(account));
    assert.deepEqual(circuit, { consecutiveFailures: 0 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testOutboundRateLimitQueue() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "wechat-claw-queue-"));
  const stateFile = path.join(tempDir, "wechat-state.json");

  try {
    const account = buildAccount(stateFile, "queue");
    account.config.operations = {
      ...account.config.operations,
      outboundRetryCount: 1,
      outboundMinIntervalMs: 40,
    };

    const sendTimes: number[] = [];
    await Promise.all([
      sendWithOutboundControl({
        account,
        send: async () => {
          sendTimes.push(Date.now());
          return { msgId: 1 };
        },
      }),
      sendWithOutboundControl({
        account,
        send: async () => {
          sendTimes.push(Date.now());
          return { msgId: 2 };
        },
      }),
    ]);

    assert.equal(sendTimes.length, 2);
    assert.ok(sendTimes[1] - sendTimes[0] >= 30, "同账号出站应串行并遵守最小发送间隔");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("🧪 微信稳定性测试");
  console.log("=".repeat(60));

  await testPersistentLoginState();
  console.log("✓ 登录态持久化通过");

  await testOutboundRetryAndCircuit();
  console.log("✓ 出站重试与熔断通过");

  await testQrThrottleAndStartupCircuit();
  console.log("✓ 二维码节流与启动熔断通过");

  await testLegacyAbortCircuitIsIgnored();
  console.log("✓ 历史 abort 熔断兼容通过");

  await testOutboundRateLimitQueue();
  console.log("✓ 出站限速队列通过");

  console.log("=".repeat(60));
  console.log("✅ 稳定性测试完成");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("稳定性测试失败:", error);
  process.exit(1);
});
