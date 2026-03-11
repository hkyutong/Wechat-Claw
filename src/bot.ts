import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { getWeChatRuntime } from "./runtime.js";
import { createWeChatReplyDispatcher } from "./reply-dispatcher.js";
import {
  buildGroupReplyPrefix,
  composeSessionKey,
  evaluateWeChatMessage,
  resolveBuiltinCommandAction,
  resolveReplyMode,
  resolveRoutePeer,
} from "./message-policy.js";
import { tryConsumeRateLimit, tryRecordMessage } from "./message-state.js";
import { ProxyClient } from "./proxy-client.js";
import type { WechatMessageContext, ResolvedWeChatAccount } from "./types.js";
import { sendWithOutboundControl } from "./outbound-control.js";

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
  const riskControl = account.config.riskControl ?? {};

  if (!tryRecordMessage({
    accountId: account.accountId,
    messageId: message.id,
    dedupWindowMs: riskControl.dedupWindowMs,
    dedupMaxSize: riskControl.dedupMaxSize,
  })) {
    log(`wechat[${accountId}]: 跳过重复消息 ${message.id}`);
    return;
  }

  const isGroup = !!message.group;
  log(`wechat[${accountId}]: 收到 ${message.type} 消息，发送方=${message.sender.id}${isGroup ? `，群=${message.group!.id}` : ""}`);

  const evaluation = evaluateWeChatMessage({ account, message });
  if (!evaluation.accepted) {
    log(`wechat[${accountId}]: 消息被策略拒绝，原因=${evaluation.reason}`);
    await maybeSendTextReply({
      account,
      message,
      text: evaluation.autoReplyText,
      replyMode: resolveReplyMode({ account, message, evaluation }),
    });
    return;
  }

  if (!consumeRateLimit({ account, message })) {
    log(`wechat[${accountId}]: 命中限流，发送方=${message.sender.id}`);
    await maybeSendTextReply({
      account,
      message,
      text: riskControl.rateLimitReplyText,
      replyMode: resolveReplyMode({ account, message, evaluation }),
    });
    return;
  }

  try {
    const core = getWeChatRuntime();
    const routePeer = resolveRoutePeer({ message, evaluation });
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "wechat",
      accountId: account.accountId,
      peer: routePeer,
    });

    const agentId = evaluation.agentIdOverride || route.agentId;
    const sessionKey = composeSessionKey({
      baseSessionKey: route.sessionKey,
      sessionMode: evaluation.sessionMode,
      message,
    });
    const replyMode = resolveReplyMode({ account, message, evaluation });
    const preview = evaluation.agentBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `OpenClaw 微信通道[${accountId}] 群消息 ${message.group!.id}`
      : `OpenClaw 微信通道[${accountId}] 私聊消息 ${message.sender.id}`;

    core.system?.enqueueSystemEvent?.(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `wechat:message:${account.accountId}:${message.id}`,
    });

    const builtinCommand = resolveBuiltinCommandAction({ account, message, evaluation });
    if (builtinCommand) {
      await maybeSendTextReply({
        account,
        message,
        text: builtinCommand.replyText,
        replyMode,
      });
      if (builtinCommand.stopAfterReply) {
        return;
      }
    }

    if (evaluation.autoReplyText) {
      await maybeSendTextReply({
        account,
        message,
        text: evaluation.autoReplyText,
        replyMode,
      });
      if (evaluation.skipAgent) {
        return;
      }
    }

    if (evaluation.skipAgent) {
      log(`wechat[${accountId}]: 规则 ${evaluation.matchedRule?.name || ""} 仅执行自动动作，不进入智能体`);
      return;
    }

    if (replyMode === "silent") {
      log(`wechat[${accountId}]: 消息已入链路，但配置为 silent，不向微信侧回发`);
      return;
    }

    const wechatFrom = `wechat:${message.sender.id}`;
    const wechatTo = isGroup
      ? `group:${message.group!.id}`
      : `user:${message.sender.id}`;

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const speaker = message.sender.name || message.sender.id;
    const messageBody = `${speaker}: ${evaluation.agentBody}`;
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
      CommandBody: evaluation.commandBody || evaluation.normalizedText,
      From: wechatFrom,
      To: wechatTo,
      SessionKey: sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? message.group!.id : undefined,
      SenderName: speaker,
      SenderId: message.sender.id,
      Provider: "wechat" as const,
      Surface: "wechat" as const,
      MessageSid: message.id,
      Timestamp: Date.now(),
      WasMentioned: evaluation.mentioned,
      CommandAuthorized: true,
      OriginatingChannel: "wechat" as const,
      OriginatingTo: wechatTo,
      WechatMessageType: message.type,
      WechatRule: evaluation.matchedRule?.name,
      WechatReplyMode: replyMode,
      WechatAuditTags: evaluation.auditTags,
      WechatSensitiveWord: evaluation.sensitiveWord,
    });

    const replyTo = replyMode === "direct"
      ? message.sender.id
      : message.group?.id ?? message.sender.id;
    const textPrefix = replyMode === "group"
      ? buildGroupReplyPrefix({ account, message })
      : undefined;

    const { dispatcher, replyOptions, markDispatchIdle } = createWeChatReplyDispatcher({
      cfg,
      agentId,
      runtime: runtime as RuntimeEnv,
      account,
      provider: account.provider,
      apiKey: account.apiKey,
      proxyUrl: account.proxyUrl,
      replyTo,
      accountId: account.accountId,
      textPrefix,
    });

    log(`wechat[${accountId}]: 开始分发给智能体，session=${sessionKey}，agent=${agentId}`);

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

function consumeRateLimit(params: {
  account: ResolvedWeChatAccount;
  message: WechatMessageContext;
}): boolean {
  const { account, message } = params;
  const riskControl = account.config.riskControl ?? {};

  if (!tryConsumeRateLimit({
    scopeKey: `wechat:${account.accountId}:sender:${message.sender.id}`,
    limit: riskControl.senderRateLimitPerMinute,
  })) {
    return false;
  }

  if (message.group && !tryConsumeRateLimit({
    scopeKey: `wechat:${account.accountId}:group:${message.group.id}`,
    limit: riskControl.groupRateLimitPerMinute,
  })) {
    return false;
  }

  return true;
}

async function maybeSendTextReply(params: {
  account: ResolvedWeChatAccount;
  message: WechatMessageContext;
  text?: string;
  replyMode: "group" | "direct" | "silent";
}): Promise<void> {
  const { account, message, text, replyMode } = params;
  if (!text?.trim() || replyMode === "silent") {
    return;
  }

  const replyTo = replyMode === "direct"
    ? message.sender.id
    : message.group?.id ?? message.sender.id;
  const prefix = replyMode === "group"
    ? buildGroupReplyPrefix({ account, message })
    : undefined;

  const client = new ProxyClient({
    provider: account.provider,
    apiKey: account.apiKey,
    accountId: account.accountId,
    baseUrl: account.proxyUrl,
    deviceType: account.deviceType,
    proxy: account.proxy,
    loginProxyUrl: account.loginProxyUrl,
    deviceName: account.deviceName,
    deviceId: account.deviceId,
    webhookSecret: account.webhookSecret,
    webhookMessageTypes: account.webhookMessageTypes,
    webhookIncludeSelfMessage: account.webhookIncludeSelfMessage,
    webhookRetryCount: account.webhookRetryCount,
    webhookTimeoutSec: account.webhookTimeoutSec,
  });

  const content = prefix ? `${prefix}${text}` : text;
  await sendWithOutboundControl({
    account,
    log: console.log,
    send: () => client.sendText(replyTo, content),
  });
}
