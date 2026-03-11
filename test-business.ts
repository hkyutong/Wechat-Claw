import assert from "node:assert/strict";
import { handleWeChatMessage } from "./src/bot.js";
import { setWeChatRuntime } from "./src/runtime.js";
import type { ResolvedWeChatAccount, WechatMessageContext } from "./src/types.js";

type SentRequest = {
  endpoint: string;
  body: any;
  headers: Record<string, string>;
};

const sentRequests: SentRequest[] = [];
const routedPeers: Array<{ kind: string; id: string }> = [];
const dispatchedContexts: any[] = [];
const systemEvents: Array<{ message: string; meta: any }> = [];

const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const endpoint = new URL(url).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const headers = normalizeHeaders(init?.headers);

  sentRequests.push({ endpoint, body, headers });

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      if (endpoint.endsWith("/sendText") || endpoint.endsWith("/sendImage2")) {
        return {
          code: "1000",
          data: {
            msgId: 1,
            newMsgId: Date.now(),
            createTime: Date.now(),
          },
        };
      }

      return { code: "1000", data: {} };
    },
  } as Response;
}) as typeof fetch;

setWeChatRuntime({
  channel: {
    routing: {
      resolveAgentRoute: ({ peer }: any) => {
        routedPeers.push(peer);
        return {
          sessionKey: "session-default",
          accountId: "default",
          agentId: "agent-default",
        };
      },
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }: any) => body,
      finalizeInboundContext: (ctx: any) => {
        dispatchedContexts.push(ctx);
        return ctx;
      },
      resolveHumanDelayConfig: () => null,
      createReplyDispatcherWithTyping: ({ deliver }: any) => ({
        dispatcher: { deliver },
        replyOptions: {},
        markDispatchIdle: () => undefined,
      }),
      dispatchReplyFromConfig: async ({ dispatcher }: any) => {
        await dispatcher.deliver({ text: "智能体回复" });
        return {
          queuedFinal: false,
          counts: { final: 1 },
        };
      },
    },
    text: {
      resolveTextChunkLimit: () => 2000,
      resolveChunkMode: () => "paragraph",
      chunkTextWithMode: (text: string) => [text],
    },
  },
  system: {
    enqueueSystemEvent: (message: string, meta: any) => {
      systemEvents.push({ message, meta });
    },
  },
});

const runtime = {
  log: (message: string) => console.log(`[LOG] ${message}`),
  error: (message: string) => console.log(`[ERROR] ${message}`),
};

async function testRequireMentionInGroup() {
  resetState();
  const account = buildAccount({
    inbound: {
      requireMentionInGroup: true,
    },
  });

  await handleWeChatMessage({
    cfg: {},
    account,
    accountId: account.accountId,
    runtime,
    message: buildGroupMessage({
      id: "msg-no-mention",
      content: "这是一条普通群消息",
      raw: {},
    }),
  });

  assert.equal(dispatchedContexts.length, 0, "未被 @ 的群消息不应进入智能体");
  assert.equal(sentRequests.length, 0, "未被 @ 的群消息不应产生回包");
}

async function testBuiltinHelpCommand() {
  resetState();
  const account = buildAccount({
    inbound: {
      requireMentionInGroup: true,
      commandPrefixes: ["/"],
    },
    reply: {
      mentionSenderInGroup: true,
    },
  });

  await handleWeChatMessage({
    cfg: {},
    account,
    accountId: account.accountId,
    runtime,
    message: buildGroupMessage({
      id: "msg-help",
      content: "@OpenClaw /help",
    }),
  });

  assert.equal(dispatchedContexts.length, 0, "内建 help 命令不应进入智能体");
  assert.equal(sentRequests.length, 1, "内建 help 命令应直接回包");
  assert.equal(sentRequests[0].endpoint, "/v1/sendText");
  assert.equal(sentRequests[0].body.wcId, "room@chatroom");
  assert.match(sentRequests[0].body.content, /^@Alice /, "群内 help 回复应带 @ 发送者前缀");
  assert.match(sentRequests[0].body.content, /OpenClaw 微信通道命令/);
}

async function testRoutingRuleAndDirectReplyMode() {
  resetState();
  const account = buildAccount({
    inbound: {
      requireMentionInGroup: true,
    },
    reply: {
      defaultGroupReplyMode: "group",
      mentionSenderInGroup: true,
    },
    routing: {
      rules: [
        {
          name: "sales-handoff",
          chatType: "group",
          matchType: "keyword",
          pattern: "发包",
          routeKey: "sales-room",
          agentId: "agent-sales",
          sessionMode: "group-member",
          replyMode: "direct",
        },
      ],
    },
  });

  await handleWeChatMessage({
    cfg: {},
    account,
    accountId: account.accountId,
    runtime,
    message: buildGroupMessage({
      id: "msg-sales",
      content: "@OpenClaw 请发包",
    }),
  });

  assert.equal(routedPeers.length, 1);
  assert.deepEqual(routedPeers[0], { kind: "group", id: "sales-room" });
  assert.equal(dispatchedContexts.length, 1, "命中业务规则后仍应进入智能体");
  assert.equal(dispatchedContexts[0].SessionKey, "session-default::group-member:room@chatroom:wxid_alice");
  assert.equal(dispatchedContexts[0].WechatRule, "sales-handoff");
  assert.equal(sentRequests.length, 1, "智能体回复应按 direct 模式私聊回发");
  assert.equal(sentRequests[0].body.wcId, "wxid_alice");
  assert.equal(sentRequests[0].body.content, "智能体回复");
}

async function testSensitiveWordBlock() {
  resetState();
  const account = buildAccount({
    riskControl: {
      sensitiveWords: ["退款"],
      sensitiveReplyText: "该诉求已转人工，请稍候。",
    },
  });

  await handleWeChatMessage({
    cfg: {},
    account,
    accountId: account.accountId,
    runtime,
    message: buildDirectMessage({
      id: "msg-sensitive",
      content: "我要退款",
    }),
  });

  assert.equal(dispatchedContexts.length, 0, "敏感词消息不应进入智能体");
  assert.equal(sentRequests.length, 1, "敏感词命中后应触发提示");
  assert.equal(sentRequests[0].body.wcId, "wxid_alice");
  assert.match(sentRequests[0].body.content, /转人工/);
}

async function testImageIngressFormatting() {
  resetState();
  const account = buildAccount();

  await handleWeChatMessage({
    cfg: {},
    account,
    accountId: account.accountId,
    runtime,
    message: buildDirectMessage({
      id: "msg-image",
      type: "image",
      content: "这是报价图",
      raw: {
        data: {
          imageUrl: "https://cdn.example.com/quote.png",
          fileName: "quote.png",
        },
      },
    }),
  });

  assert.equal(dispatchedContexts.length, 1, "图片消息应进入智能体链路");
  assert.match(dispatchedContexts[0].Body, /\[图片消息\]/);
  assert.match(dispatchedContexts[0].Body, /quote\.png/);
  assert.match(dispatchedContexts[0].Body, /https:\/\/cdn\.example\.com\/quote\.png/);
  assert.equal(sentRequests.length, 1, "图片消息的智能体回复应正常发回");
}

async function main() {
  console.log("=".repeat(60));
  console.log("🧪 OpenClaw 微信通道业务规则测试");
  console.log("=".repeat(60));

  try {
    await testRequireMentionInGroup();
    console.log("✓ 群聊 @ 门控通过");

    await testBuiltinHelpCommand();
    console.log("✓ 内建命令通过");

    await testRoutingRuleAndDirectReplyMode();
    console.log("✓ 路由规则与私聊回落通过");

    await testSensitiveWordBlock();
    console.log("✓ 敏感词风控通过");

    await testImageIngressFormatting();
    console.log("✓ 媒体消息入链路通过");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("=".repeat(60));
  console.log("✅ 业务规则测试完成");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("业务规则测试失败:", error);
  globalThis.fetch = originalFetch;
  process.exit(1);
});

function buildAccount(overrides?: Partial<ResolvedWeChatAccount["config"]>): ResolvedWeChatAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    name: "OpenClaw",
    provider: "legacy",
    apiKey: "wc_live_test",
    proxyUrl: "http://127.0.0.1:13800",
    wcId: "wxid_openclaw",
    isLoggedIn: true,
    nickName: "OpenClaw",
    deviceType: "ipad",
    proxy: "2",
    webhookPort: 18790,
    webhookPath: "/webhook/wechat",
    webhookIncludeSelfMessage: false,
    webhookRetryCount: 3,
    webhookTimeoutSec: 10,
    webhookTimestampSkewSec: 300,
    config: {
      apiKey: "wc_live_test",
      proxyUrl: "http://127.0.0.1:13800",
      ...overrides,
    },
  };
}

function buildDirectMessage(overrides?: Partial<WechatMessageContext>): WechatMessageContext {
  return {
    id: "msg-direct",
    type: "text",
    sender: {
      id: "wxid_alice",
      name: "Alice",
    },
    recipient: {
      id: "wxid_openclaw",
    },
    content: "你好",
    timestamp: Date.now(),
    threadId: "wxid_alice",
    raw: {},
    ...overrides,
  };
}

function buildGroupMessage(overrides?: Partial<WechatMessageContext>): WechatMessageContext {
  return {
    ...buildDirectMessage(),
    id: "msg-group",
    content: "@OpenClaw 你好",
    threadId: "room@chatroom",
    group: {
      id: "room@chatroom",
      name: "OpenClaw 客服群",
    },
    raw: {
      atUsers: ["wxid_openclaw"],
    },
    ...overrides,
  };
}

function normalizeHeaders(headers: any): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function resetState(): void {
  sentRequests.length = 0;
  routedPeers.length = 0;
  dispatchedContexts.length = 0;
  systemEvents.length = 0;
}
