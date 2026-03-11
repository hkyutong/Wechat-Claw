import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { startCallbackServer } from "./src/callback-server.js";
import { ProxyClient } from "./src/proxy-client.js";
import type { WechatMessageContext } from "./src/types.js";
import {
  attachWebhookAuthToken,
  buildWebhookAuthToken,
  buildWebhookSecret,
} from "./src/webhook-auth.js";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const originalFetch = globalThis.fetch;
const fetchCalls: FetchCall[] = [];

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

async function testWeChatPadProClient() {
  console.log("\n🧪 验证 WeChatPadPro 客户端适配...");

  fetchCalls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });

    if (url.includes("/api/login/qr/newx")) {
      return jsonResponse({ message: "missing route" }, { status: 404 });
    }

    if (url.includes("/login/GetLoginQrCodeNewX")) {
      return jsonResponse({
        Code: 200,
        Data: {
          uuid: "uuid-padpro",
          QrLink: "http://weixin.qq.com/x/padpro-demo",
          QrCodeUrl: "https://api.example.com/qrcode/padpro-demo",
        },
        Text: "获取登录二维码成功",
      });
    }

    if (url.includes("/message/SendTextMessage")) {
      return jsonResponse({
        Code: 0,
        Data: {
          MsgId: 123456,
        },
      });
    }

    if (url.includes("/login/CheckLoginStatus")) {
      return jsonResponse({
        Code: 200,
        Data: {
          Status: "online",
          wxid: "wxid_padpro",
          nickname: "PadPro 用户",
        },
      });
    }

    if (url.includes("/webhook/Config")) {
      return jsonResponse({
        Code: 200,
        Data: {
          enabled: true,
        },
      });
    }

    if (url.includes("/user/GetProfile")) {
      return jsonResponse({
        Code: 200,
        Data: {
          wxid: "wxid_padpro",
          nickname: "PadPro 用户",
        },
      });
    }

    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const client = new ProxyClient({
    provider: "wechatpadpro",
    apiKey: "auth-demo",
    accountId: "default",
    baseUrl: "http://127.0.0.1:8080",
    deviceType: "ipad",
    loginProxyUrl: "socks5://127.0.0.1:7890",
    deviceName: "iPhone",
    deviceId: "device-demo",
    webhookSecret: "secret-demo",
    webhookMessageTypes: ["1", "3"],
    webhookIncludeSelfMessage: false,
    webhookRetryCount: 5,
    webhookTimeoutSec: 12,
  });

  const status = await client.getStatus();
  assert.equal(status.valid, true);
  assert.equal(status.isLoggedIn, true);
  assert.equal(status.wcId, "wxid_padpro");

  const qr = await client.getQRCode("ipad");
  assert.equal(qr.wId, "uuid-padpro");
  assert.equal(qr.qrCodeUrl, "http://weixin.qq.com/x/padpro-demo");

  const login = await client.checkLogin(qr.wId);
  assert.equal(login.status, "logged_in");
  assert.equal(login.wcId, "wxid_padpro");

  const sendResult = await client.sendText("wxid_target", "hello");
  assert.equal(sendResult.msgId, 123456);
  assert.equal(sendResult.newMsgId, 123456);

  await client.registerWebhook("wxid_padpro", "https://example.com/webhook/wechat?token=abc");

  const qrCalls = fetchCalls.filter((call) => call.url.includes("/login/"));
  assert.equal(qrCalls.length, 3, "应先尝试兼容路径，并覆盖新版登录状态检查");
  assert.ok(
    qrCalls.some((call) => call.url.includes("/login/GetLoginQrCodeNewX")),
    "应回退到新版真实二维码接口"
  );
  assert.ok(
    qrCalls.some((call) => call.url.includes("/login/CheckLoginStatus?key=uuid-padpro")),
    "应使用 uuid 查询新版登录状态"
  );

  const sendCall = fetchCalls.find((call) => call.url.includes("/message/SendTextMessage"));
  assert.ok(sendCall, "应调用 SendTextMessage");
  const sendBody = JSON.parse(String(sendCall!.init?.body || "{}"));
  assert.deepEqual(sendBody, {
    MsgItem: [
      {
        ToUserName: "wxid_target",
        TextContent: "hello",
        MsgType: 0,
      },
    ],
  });
  assert.ok(sendCall!.url.includes("key=auth-demo"), "应通过 key 传递授权码");

  const webhookCall = fetchCalls.find((call) => call.url.includes("/webhook/Config"));
  assert.ok(webhookCall, "应调用 Webhook 配置接口");
  const webhookBody = JSON.parse(String(webhookCall!.init?.body || "{}"));
  assert.deepEqual(webhookBody, {
    url: "https://example.com/webhook/wechat?token=abc",
    secret: "secret-demo",
    enabled: true,
    timeout: 12,
    retryCount: 5,
    messageTypes: ["1", "3"],
    includeSelfMessage: false,
  });

  const qrCall = fetchCalls.find((call) => call.url.includes("/login/GetLoginQrCodeNewX"));
  assert.ok(qrCall, "应命中新版登录二维码路径");
  const qrBody = JSON.parse(String(qrCall!.init?.body || "{}"));
  assert.deepEqual(qrBody, {
    Proxy: "socks5://127.0.0.1:7890",
    proxy: "socks5://127.0.0.1:7890",
    deviceName: "iPhone",
    deviceId: "device-demo",
  });

  console.log("  ✓ WeChatPadPro 登录、发信和 Webhook 配置请求形状正确");
  globalThis.fetch = originalFetch;
}

async function testWeChatPadProWebhook() {
  console.log("\n🧪 验证 WeChatPadPro Webhook 验签与群消息解析...");

  const accountId = "default";
  const apiKey = "auth-demo";
  const authToken = buildWebhookAuthToken(accountId, apiKey);
  const webhookSecret = buildWebhookSecret(accountId, apiKey);
  let receivedMessage: WechatMessageContext | null = null;

  const { stop } = await startCallbackServer({
    port: 18791,
    path: "/webhook/wechat",
    provider: "wechatpadpro",
    authToken,
    signatureSecret: webhookSecret,
    onMessage: (message) => {
      receivedMessage = message;
    },
  });

  try {
    const payload = {
      msgType: 1,
      fromUser: "room@chatroom",
      toUser: "wxid_bot",
      content: "wxid_member:\n你好，测试一下",
      timestamp: Date.now(),
      msgId: "42",
    };
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", webhookSecret)
      .update(timestamp)
      .update(body)
      .digest("hex");

    const unauthorized = await fetch(
      attachWebhookAuthToken("http://localhost:18791/webhook/wechat", authToken),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }
    );
    assert.equal(unauthorized.status, 401, "缺少签名的 WeChatPadPro 请求应被拒绝");

    const response = await fetch(
      attachWebhookAuthToken("http://localhost:18791/webhook/wechat", authToken),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": timestamp,
          "X-Webhook-Signature": signature,
        },
        body,
      }
    );
    assert.equal(response.status, 200, "验签通过的请求应返回 200");
    assert.ok(receivedMessage, "应收到解析后的消息");
    assert.equal(receivedMessage!.group?.id, "room@chatroom");
    assert.equal(receivedMessage!.sender.id, "wxid_member");
    assert.equal(receivedMessage!.recipient.id, "wxid_bot");
    assert.equal(receivedMessage!.content, "你好，测试一下");

    console.log("  ✓ WeChatPadPro Webhook 验签和群消息拆解通过");
  } finally {
    stop();
  }
}

async function main() {
  console.log("🚀 开始 WeChatPadPro 适配验证\n");

  try {
    await testWeChatPadProClient();
    globalThis.fetch = originalFetch;
    await testWeChatPadProWebhook();
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n✅ WeChatPadPro 适配验证完成");
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
