import { createHmac, timingSafeEqual } from "node:crypto";
import http from "http";
import type { WechatMessageContext, WechatProvider } from "./types.js";
import { WEBHOOK_AUTH_QUERY_PARAM } from "./webhook-auth.js";

interface CallbackServerOptions {
  port: number;
  authToken?: string;
  path?: string;
  provider?: WechatProvider;
  signatureSecret?: string;
  timestampSkewSec?: number;
  onMessage: (message: WechatMessageContext) => void;
  abortSignal?: AbortSignal;
}

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMESTAMP_SKEW_SEC = 300;

export async function startCallbackServer(
  options: CallbackServerOptions
): Promise<{ port: number; stop: () => void }> {
  const {
    port,
    path = "/webhook/wechat",
    authToken,
    provider = "legacy",
    signatureSecret,
    timestampSkewSec = DEFAULT_TIMESTAMP_SKEW_SEC,
    onMessage,
    abortSignal,
  } = options;

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (requestUrl.pathname === path && req.method === "POST") {
      if (authToken && requestUrl.searchParams.get(WEBHOOK_AUTH_QUERY_PARAM) !== authToken) {
        req.resume();
        res.writeHead(401).end("Unauthorized");
        return;
      }

      let body = "";
      let bodyTooLarge = false;
      req.on("data", (chunk) => {
        if (bodyTooLarge) return;
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
          bodyTooLarge = true;
          res.writeHead(413).end("Payload Too Large");
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (bodyTooLarge) return;
        try {
          const payload = JSON.parse(body);

          if (
            provider === "wechatpadpro" &&
            signatureSecret &&
            !verifyWeChatPadProSignature(req, body, payload, signatureSecret, timestampSkewSec)
          ) {
            res.writeHead(401).end("Invalid Signature");
            return;
          }

          const message = convertToMessageContext(payload, provider);

          if (message) {
            onMessage(message);
          }

          res.writeHead(200).end("OK");
        } catch (err) {
          console.error("处理微信回调失败:", err);
          res.writeHead(400).end("Bad Request");
        }
      });
    } else {
      res.writeHead(404).end("Not Found");
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => {
      console.log(`📡 OpenClaw 微信回调服务监听于 0.0.0.0:${port}`);
      console.log(`   回调地址: http://localhost:${port}${path}`);

      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        server.close(() => {
          console.log(`📡 OpenClaw 微信回调服务已停止，端口 ${port}`);
        });
      };

      abortSignal?.addEventListener("abort", stop);

      resolve({ port, stop });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

function withinTimestampSkew(timestamp: string | number | undefined, skewSec: number): boolean {
  if (timestamp === undefined || timestamp === null || timestamp === "") return false;
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return false;
  const ts = numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= skewSec;
}

function safeCompareHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifyWeChatPadProSignature(
  req: http.IncomingMessage,
  rawBody: string,
  payload: any,
  secret: string,
  skewSec: number
): boolean {
  const headerTimestamp = req.headers["x-webhook-timestamp"];
  const headerSignature = req.headers["x-webhook-signature"];
  const timestampValue = Array.isArray(headerTimestamp) ? headerTimestamp[0] : headerTimestamp;
  const signatureValue = Array.isArray(headerSignature) ? headerSignature[0] : headerSignature;

  if (timestampValue && signatureValue) {
    if (!withinTimestampSkew(timestampValue, skewSec)) {
      return false;
    }
    const expected = createHmac("sha256", secret)
      .update(String(timestampValue))
      .update(rawBody)
      .digest("hex");
    return safeCompareHex(expected, String(signatureValue));
  }

  const bodySignature = payload?.Signature || payload?.signature;
  const bodyTimestamp = payload?.Timestamp || payload?.timestamp;
  const bodyWxid = payload?.Wxid || payload?.wcId || payload?.toUser || payload?.toUserName;
  const bodyMessageType = payload?.MessageType || payload?.msgType || payload?.messageType;

  if (bodySignature && bodyTimestamp && bodyWxid && bodyMessageType) {
    if (!withinTimestampSkew(bodyTimestamp, skewSec)) {
      return false;
    }
    const expected = createHmac("sha256", secret)
      .update(`${bodyWxid}:${bodyMessageType}:${bodyTimestamp}`)
      .digest("hex");
    return safeCompareHex(expected, String(bodySignature));
  }

  return false;
}

function normalizeLegacyPayload(payload: any): {
  messageType: string;
  wcId: string;
  fromUser: string;
  toUser?: string;
  fromGroup?: string;
  content: string;
  newMsgId?: string | number;
  timestamp?: number;
  raw: any;
} {
  const { messageType, wcId } = payload;

  if (payload.fromUser) {
    return {
      messageType,
      wcId,
      fromUser: payload.fromUser,
      toUser: payload.toUser,
      fromGroup: payload.fromGroup,
      content: payload.content ?? "",
      newMsgId: payload.newMsgId,
      timestamp: payload.timestamp,
      raw: payload,
    };
  }

  const data = payload.data ?? {};
  return {
    messageType,
    wcId,
    fromUser: data.fromUser,
    toUser: data.toUser,
    fromGroup: data.fromGroup,
    content: data.content ?? "",
    newMsgId: data.newMsgId,
    timestamp: data.timestamp ?? payload.timestamp,
    raw: payload,
  };
}

function resolveLegacyMessageType(messageType: string): WechatMessageContext["type"] {
  switch (messageType) {
    case "60001":
    case "80001":
      return "text";
    case "60002":
    case "80002":
      return "image";
    case "60003":
    case "80003":
      return "video";
    case "60004":
    case "80004":
      return "voice";
    case "60008":
    case "80008":
      return "file";
    default:
      return "unknown";
  }
}

function isLegacyGroupMessage(messageType: string): boolean {
  return messageType.startsWith("8");
}

function parseGroupSender(content: string): { senderId?: string; content: string } {
  const match = /^([^\n:]{3,}):\n([\s\S]*)$/u.exec(content || "");
  if (!match) {
    return { content };
  }

  return {
    senderId: match[1].trim(),
    content: match[2],
  };
}

function unwrapWeChatPadProPayload(payload: any): any {
  if (payload?.event_type && payload?.data) {
    return payload.data;
  }
  if (payload?.message && payload?.type === "message_received") {
    return payload.message;
  }
  return payload;
}

function resolveWeChatPadProMessageType(msgType: number | string): WechatMessageContext["type"] {
  const normalized = Number(msgType);
  switch (normalized) {
    case 1:
    case 10000:
      return "text";
    case 3:
    case 47:
      return "image";
    case 34:
      return "voice";
    case 43:
      return "video";
    case 49:
      return "file";
    default:
      return "unknown";
  }
}

function convertWeChatPadProMessage(payload: any): WechatMessageContext | null {
  const message = unwrapWeChatPadProPayload(payload);
  const fromUser = message?.fromUser || message?.fromUserName || message?.from_user_name?.str;
  const toUser = message?.toUser || message?.toUserName || message?.to_user_name?.str || message?.Wxid;
  const msgType = message?.msgType || message?.MessageType || message?.msg_type;
  const timestamp = Number(message?.timestamp || message?.Timestamp || Date.now());
  const rawContent =
    message?.content ||
    message?.Content ||
    message?.msgContent ||
    message?.rawContent ||
    message?.content?.str ||
    "";

  if (!fromUser || !toUser || msgType === undefined || msgType === null) {
    console.log("WeChatPadPro 消息缺少关键字段，已跳过");
    return null;
  }

  const isGroup = String(fromUser).includes("@chatroom");
  const parsedGroup = isGroup ? parseGroupSender(String(rawContent)) : { content: String(rawContent) };
  const senderId =
    message?.realFromUser ||
    message?.senderWxid ||
    message?.fromMember ||
    message?.fromGroupUser ||
    parsedGroup.senderId ||
    String(fromUser);
  const content = parsedGroup.content || "";

  const result: WechatMessageContext = {
    id: String(message?.msgId || message?.newMsgId || message?.msg_id || `${timestamp}:${fromUser}`),
    type: resolveWeChatPadProMessageType(msgType),
    sender: {
      id: String(senderId),
      name: String(senderId),
    },
    recipient: {
      id: String(toUser),
    },
    content,
    timestamp,
    threadId: isGroup ? String(fromUser) : String(senderId),
    raw: payload,
  };

  if (isGroup) {
    result.group = {
      id: String(fromUser),
      name: String(message?.groupName || message?.fromGroupName || ""),
    };
  }

  return result;
}

function convertLegacyMessage(payload: any): WechatMessageContext | null {
  const { messageType } = payload;

  if (messageType === "30000") {
    const wcId = payload.wcId;
    const offlineContent = payload.content ?? payload.data?.content;
    console.log(`账号 ${wcId} 已离线: ${offlineContent}`);
    return null;
  }

  if (!messageType || (!messageType.startsWith("6") && !messageType.startsWith("8"))) {
    console.log(`收到未处理的消息类型 ${messageType}`);
    return null;
  }

  const norm = normalizeLegacyPayload(payload);

  if (!norm.fromUser) {
    console.log("消息缺少 fromUser，已跳过");
    return null;
  }

  const msgType = resolveLegacyMessageType(messageType);
  const isGroup = isLegacyGroupMessage(messageType);

  const result: WechatMessageContext = {
    id: String(norm.newMsgId || Date.now()),
    type: msgType,
    sender: {
      id: norm.fromUser,
      name: norm.fromUser,
    },
    recipient: {
      id: norm.wcId,
    },
    content: norm.content,
    timestamp: norm.timestamp || Date.now(),
    threadId: isGroup ? (norm.fromGroup || norm.fromUser) : norm.fromUser,
    raw: norm.raw,
  };

  if (isGroup && norm.fromGroup) {
    result.group = {
      id: norm.fromGroup,
      name: "",
    };
  }

  return result;
}

function convertToMessageContext(
  payload: any,
  provider: WechatProvider
): WechatMessageContext | null {
  if (provider === "wechatpadpro") {
    return convertWeChatPadProMessage(payload);
  }
  return convertLegacyMessage(payload);
}
