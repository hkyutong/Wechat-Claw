import http from "http";
import type { WechatMessageContext } from "./types.js";

interface CallbackServerOptions {
  port: number;
  apiKey: string;
  path?: string;
  onMessage: (message: WechatMessageContext) => void;
  abortSignal?: AbortSignal;
}

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export async function startCallbackServer(
  options: CallbackServerOptions
): Promise<{ port: number; stop: () => void }> {
  const { port, path = "/webhook/wechat", onMessage, abortSignal } = options;

  const server = http.createServer((req, res) => {
    // 回调 URL 可能带查询参数，这里只取路径部分。
    const url = req.url?.split("?")[0] || "";
    if (url === path && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
          res.writeHead(413).end("Payload Too Large");
          req.destroy();
        }
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const message = convertToMessageContext(payload);

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
      console.log(`📡 YutoAI 微信回调服务监听于 0.0.0.0:${port}`);
      console.log(`   回调地址: http://localhost:${port}${path}`);

      const stop = () => {
        server.close(() => {
          console.log(`📡 YutoAI 微信回调服务已停止，端口 ${port}`);
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

/**
 * 归一化回调负载，兼容原始上游格式和代理层拍平后的格式。
 */
function normalizePayload(payload: any): {
  messageType: string;
  wcId: string;
  fromUser: string;
  toUser?: string;
  fromGroup?: string;
  content: string;
  newMsgId?: string | number;
  timestamp?: number;
  contentType?: string;
  raw: any;
} {
  const { messageType, wcId } = payload;

  // 代理层拍平格式：fromUser 直接出现在顶层。
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
      contentType: payload.contentType,
      raw: payload,
    };
  }

  // 原始格式：字段位于 data 内。
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
    contentType: undefined,
    raw: payload,
  };
}

/** 把 messageType 编码映射为内部消息类型。 */
function resolveMessageType(messageType: string): WechatMessageContext["type"] {
  switch (messageType) {
    case "60001": // 私聊文本
    case "80001": // 群聊文本
      return "text";
    case "60002": // 私聊图片
    case "80002": // 群聊图片
      return "image";
    case "60003": // 私聊视频
    case "80003": // 群聊视频
      return "video";
    case "60004": // 私聊语音
    case "80004": // 群聊语音
      return "voice";
    case "60008": // 私聊文件
    case "80008": // 群聊文件
      return "file";
    default:
      return "unknown";
  }
}

function isGroupMessage(messageType: string): boolean {
  return messageType.startsWith("8");
}

function convertToMessageContext(payload: any): WechatMessageContext | null {
  const { messageType } = payload;

  // 设备离线通知。
  if (messageType === "30000") {
    const wcId = payload.wcId;
    const offlineContent = payload.content ?? payload.data?.content;
    console.log(`账号 ${wcId} 已离线: ${offlineContent}`);
    return null;
  }

  // 当前只接收已知的私聊/群聊消息类型。
  if (!messageType || (!messageType.startsWith("6") && !messageType.startsWith("8"))) {
    console.log(`收到未处理的消息类型 ${messageType}`);
    return null;
  }

  const norm = normalizePayload(payload);

  if (!norm.fromUser) {
    console.log("消息缺少 fromUser，已跳过");
    return null;
  }

  const msgType = resolveMessageType(messageType);
  const isGroup = isGroupMessage(messageType);

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
