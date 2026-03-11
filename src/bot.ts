import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { getWeChatRuntime } from "./runtime.js";
import { createWeChatReplyDispatcher } from "./reply-dispatcher.js";
import type { WechatMessageContext, ResolvedWeChatAccount } from "./types.js";

// 消息去重，避免代理回调或网络抖动造成重复投递。
const processedMessages = new Map<string, number>();
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_SIZE = 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let lastCleanup = Date.now();

function tryRecordMessage(messageId: string): boolean {
  const now = Date.now();

  // 定期清理过期去重记录。
  if (now - lastCleanup > DEDUP_CLEANUP_INTERVAL_MS) {
    lastCleanup = now;
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_WINDOW_MS) processedMessages.delete(id);
    }
  }

  // 达到上限时淘汰最早的记录，避免内存持续增长。
  if (processedMessages.size >= DEDUP_MAX_SIZE) {
    const oldest = processedMessages.keys().next().value;
    if (oldest) processedMessages.delete(oldest);
  }

  if (processedMessages.has(messageId)) return false;
  processedMessages.set(messageId, now);
  return true;
}

export async function handleWeChatMessage(params: {
  cfg: ClawdbotConfig;
  message: WechatMessageContext;
  runtime?: RuntimeEnv;
  accountId?: string;
  account: ResolvedWeChatAccount;
}): Promise<void> {
  const { cfg, message, runtime, accountId, account } = params;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // 先做去重，避免重复消息进入后续链路。
  if (!tryRecordMessage(message.id)) {
    log(`wechat: 跳过重复消息 ${message.id}`);
    return;
  }

  const isGroup = !!message.group;

  log(`wechat[${accountId}]: 收到 ${message.type} 消息，发送方=${message.sender.id}${isGroup ? `，群=${message.group!.id}` : ""}`);

  // 当前节点只处理文本消息，其余类型先跳过。
  if (message.type !== "text") {
    log(`wechat[${accountId}]: 暂不处理非文本消息类型 ${message.type}`);
    return;
  }

  try {
    const core = getWeChatRuntime();

    const wechatFrom = `wechat:${message.sender.id}`;
    const wechatTo = isGroup
      ? `group:${message.group!.id}`
      : `user:${message.sender.id}`;

    const peerId = isGroup ? message.group!.id : message.sender.id;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "wechat",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
    });

    const preview = message.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `YutoAI 微信节点[${accountId}] 群消息 ${message.group!.id}`
      : `YutoAI 微信节点[${accountId}] 私聊消息 ${message.sender.id}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `wechat:message:${peerId}:${message.id}`,
    });

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // 群聊场景下把说话人并入正文，方便下游智能体还原上下文。
    const speaker = message.sender.name || message.sender.id;
    const messageBody = `${speaker}: ${message.content}`;

    const envelopeFrom = isGroup
      ? `${message.group!.id}:${message.sender.id}`
      : message.sender.id;

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "WeChat",
      from: envelopeFrom,
      timestamp: new Date(message.timestamp),
      envelope: envelopeOptions,
      body: messageBody,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: message.content,
      CommandBody: message.content,
      From: wechatFrom,
      To: wechatTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? message.group!.id : undefined,
      SenderName: message.sender.name || message.sender.id,
      SenderId: message.sender.id,
      Provider: "wechat" as const,
      Surface: "wechat" as const,
      MessageSid: message.id,
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: "wechat" as const,
      OriginatingTo: wechatTo,
    });

    // 群聊回群，私聊回发件人。
    const replyTo = isGroup ? message.group!.id : message.sender.id;

    const { dispatcher, replyOptions, markDispatchIdle } = createWeChatReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtime: runtime as RuntimeEnv,
      apiKey: account.apiKey,
      proxyUrl: account.proxyUrl,
      replyTo,
      accountId: account.accountId,
    });

    log(`wechat[${accountId}]: 开始分发给智能体，session=${route.sessionKey}`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    log(`wechat[${accountId}]: 分发完成，queuedFinal=${queuedFinal}，replies=${counts.final}`);
  } catch (err) {
    error(`wechat[${accountId}]: 分发消息失败: ${String(err)}`);
  }
}
