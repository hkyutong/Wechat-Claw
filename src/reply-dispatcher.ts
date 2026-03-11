import type {
  ClawdbotConfig,
  RuntimeEnv,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import { createReplyPrefixContext } from "openclaw/plugin-sdk";
import { getWeChatRuntime } from "./runtime.js";
import { ProxyClient } from "./proxy-client.js";
import type { WechatProvider } from "./types.js";
import { sendWithOutboundControl } from "./outbound-control.js";
import type { ResolvedWeChatAccount } from "./types.js";

export type CreateWeChatReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  account: ResolvedWeChatAccount;
  provider?: WechatProvider;
  apiKey: string;
  proxyUrl: string;
  /** 回复投递目标，可为私聊接收方或群聊 ID */
  replyTo: string;
  accountId?: string;
  textPrefix?: string;
};

export function createWeChatReplyDispatcher(params: CreateWeChatReplyDispatcherParams) {
  const core = getWeChatRuntime();
  const { cfg, agentId, runtime, account, provider, apiKey, proxyUrl, replyTo, accountId, textPrefix } = params;

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit({
    cfg,
    channel: "wechat",
    defaultLimit: 2000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "wechat");

  const client = new ProxyClient({
    provider,
    apiKey,
    accountId: accountId || "default",
    baseUrl: proxyUrl,
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      deliver: async (payload: ReplyPayload) => {
        runtime.log?.(`wechat[${accountId}] 开始投递回复: text=${payload.text?.slice(0, 100)}`);
        const text = payload.text ?? "";
        if (!text.trim()) {
          runtime.log?.(`wechat[${accountId}] 回复内容为空，已跳过`);
          return;
        }

        const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
        if (textPrefix && chunks.length > 0) {
          chunks[0] = `${textPrefix}${chunks[0]}`;
        }
        runtime.log?.(`wechat[${accountId}] 准备向 ${replyTo} 发送 ${chunks.length} 段文本`);

        for (const chunk of chunks) {
          try {
            const result = await sendWithOutboundControl({
              account,
              log: runtime.log,
              send: () => client.sendText(replyTo, chunk),
            });
            runtime.log?.(`wechat[${accountId}] sendText 成功: msgId=${result.msgId}`);
          } catch (err) {
            runtime.error?.(`wechat[${accountId}] sendText 失败: ${String(err)}`);
            throw err;
          }
        }
      },
      onError: (err, info) => {
        runtime.error?.(`wechat[${accountId}] ${info.kind} 回复失败: ${String(err)}`);
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
  };
}
