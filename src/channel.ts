import type { ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedWeChatAccount, WechatConfig, WechatAccountConfig } from "./types.js";
import { WechatConfigSchema } from "./config-schema.js";
import { ProxyClient } from "./proxy-client.js";
import { startCallbackServer } from "./callback-server.js";
import { handleWeChatMessage } from "./bot.js";
import { displayQRCode, displayLoginSuccess } from "./utils/qrcode.js";
import { attachWebhookAuthToken, buildWebhookAuthToken } from "./webhook-auth.js";

// 代理服务地址（必须配置）
// openclaw config set channels.wechat.proxyUrl "http://你的代理服务:13800"

const PLUGIN_META = {
  id: "wechat",
  label: "YutoAI WeChat",
  selectionLabel: "YutoAI WeChat (微信)",
  docsPath: "/channels/wechat",
  docsLabel: "wechat",
  blurb: "YutoAI 微信节点，通过 Proxy API 接入微信账号。",
  order: 80,
} as const;

function pickSharedAccountConfig(source?: WechatConfig | WechatAccountConfig): Partial<WechatAccountConfig> {
  if (!source) {
    return {};
  }

  const next: Partial<WechatAccountConfig> = {};

  if (source.inbound) {
    next.inbound = { ...source.inbound };
  }
  if (source.routing) {
    next.routing = {
      ...source.routing,
      rules: source.routing.rules?.map((rule) => ({ ...rule })),
    };
  }
  if (source.reply) {
    next.reply = { ...source.reply };
  }
  if (source.riskControl) {
    next.riskControl = { ...source.riskControl };
  }
  if (source.operations) {
    next.operations = { ...source.operations };
  }

  return next;
}

function mergeAccountConfig(
  baseConfig: Partial<WechatAccountConfig>,
  overrideConfig?: WechatAccountConfig
): WechatAccountConfig | undefined {
  if (!overrideConfig && Object.keys(baseConfig).length === 0) {
    return undefined;
  }

  return {
    ...baseConfig,
    ...overrideConfig,
    inbound: {
      ...baseConfig.inbound,
      ...overrideConfig?.inbound,
    },
    routing: {
      ...baseConfig.routing,
      ...overrideConfig?.routing,
      rules: overrideConfig?.routing?.rules?.map((rule) => ({ ...rule }))
        ?? baseConfig.routing?.rules?.map((rule) => ({ ...rule })),
    },
    reply: {
      ...baseConfig.reply,
      ...overrideConfig?.reply,
    },
    riskControl: {
      ...baseConfig.riskControl,
      ...overrideConfig?.riskControl,
    },
    operations: {
      ...baseConfig.operations,
      ...overrideConfig?.operations,
    },
  } as WechatAccountConfig;
}

/**
 * 解析微信账号配置
 * 支持简化配置（顶级字段）和多账号配置（accounts）
 */
function resolveWeChatAccount({
  cfg,
  accountId,
}: {
  cfg: ClawdbotConfig;
  accountId: string;
}): ResolvedWeChatAccount {
  const wechatCfg = cfg.channels?.wechat as WechatConfig | undefined;
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;

  let accountCfg: WechatAccountConfig | undefined;
  let enabled: boolean;

  if (isDefault) {
    // 顶级单账号配置会与 default 账号配置合并。
    const topLevelConfig: WechatAccountConfig = {
      apiKey: wechatCfg?.apiKey || "",
      proxyUrl: wechatCfg?.proxyUrl,
      deviceType: wechatCfg?.deviceType,
      proxy: wechatCfg?.proxy,
      webhookHost: wechatCfg?.webhookHost,
      webhookPort: wechatCfg?.webhookPort,
      webhookPath: wechatCfg?.webhookPath,
      ...pickSharedAccountConfig(wechatCfg),
    };

    // 如果存在 accounts.default，则作为默认值补齐。
    const defaultAccount = wechatCfg?.accounts?.default;
    accountCfg = mergeAccountConfig(topLevelConfig, defaultAccount);
    if (accountCfg) {
      accountCfg.apiKey = topLevelConfig.apiKey || defaultAccount?.apiKey || "";
    }

    enabled = accountCfg.enabled ?? wechatCfg?.enabled ?? true;
  } else {
    accountCfg = mergeAccountConfig(pickSharedAccountConfig(wechatCfg), wechatCfg?.accounts?.[accountId]);
    enabled = accountCfg?.enabled ?? true;
  }

  if (!accountCfg?.apiKey) {
    throw new Error(
      `缺少 API Key。\n` +
        `请先提供可用凭证，然后配置: openclaw config set channels.wechat.apiKey "your-key"`
    );
  }

  if (!accountCfg?.proxyUrl) {
    throw new Error(
      `缺少 proxyUrl 配置。\n` +
        `请配置: openclaw config set channels.wechat.proxyUrl "http://你的代理服务:13800"`
    );
  }

  return {
    accountId,
    enabled,
    configured: true,
    name: accountCfg.name,
    apiKey: accountCfg.apiKey,
    proxyUrl: accountCfg.proxyUrl,
    wcId: accountCfg.wcId,
    isLoggedIn: !!accountCfg.wcId,
    nickName: accountCfg.nickName,
    deviceType: accountCfg.deviceType || "ipad",
    proxy: accountCfg.proxy || "2",
    webhookHost: accountCfg.webhookHost,
    webhookPort: accountCfg.webhookPort || 18790,
    webhookPath: accountCfg.webhookPath || "/webhook/wechat",
    natappEnabled: accountCfg.natappEnabled ?? false,
    natapiWebPort: accountCfg.natapiWebPort || 4040,
    config: accountCfg,
  };
}

/**
 * 列出所有可用的微信账号 ID
 * 支持简化配置和多账号配置
 */
function listWeChatAccountIds(cfg: ClawdbotConfig): string[] {
  const wechatCfg = cfg.channels?.wechat as WechatConfig | undefined;

  // 只要顶级 apiKey 存在，就视为单账号模式。
  if (wechatCfg?.apiKey) {
    return [DEFAULT_ACCOUNT_ID];
  }

  // 否则从 accounts 中读取。
  const accounts = wechatCfg?.accounts;
  if (!accounts) return [];

  return Object.keys(accounts).filter((id) => accounts[id]?.enabled !== false);
}

function filterDirectoryEntries(ids: string[], query: string | undefined, limit: number): string[] {
  const keyword = query?.trim().toLowerCase();
  const filtered = keyword
    ? ids.filter((id) => id.toLowerCase().includes(keyword))
    : ids;
  return filtered.slice(0, limit);
}

function isWeChatGroupId(target: string): boolean {
  return target.includes("@chatroom");
}

function normalizeWeChatTarget(target: string): { type: "direct" | "channel"; id: string } {
  if (target.startsWith("user:")) {
    return { type: "direct", id: target.slice(5) };
  }
  if (target.startsWith("group:")) {
    return { type: "channel", id: target.slice(6) };
  }
  if (isWeChatGroupId(target)) {
    return { type: "channel", id: target };
  }
  return { type: "direct", id: target };
}

function looksLikeImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(url);
}

function createAccountClient(account: ResolvedWeChatAccount): ProxyClient {
  return new ProxyClient({
    apiKey: account.apiKey,
    accountId: account.accountId,
    baseUrl: account.proxyUrl,
  });
}

function applyResolvedIdentity(account: ResolvedWeChatAccount, wcId: string, nickName?: string): void {
  account.wcId = wcId;
  account.nickName = nickName;
  account.isLoggedIn = true;
  account.config.wcId = wcId;
  account.config.nickName = nickName;
}

function resolveAllowEntries(account: ResolvedWeChatAccount): string[] {
  const inbound = account.config.inbound;
  return [
    ...(inbound?.allowSenders ?? []).map((id) => `user:${id}`),
    ...(inbound?.allowGroups ?? []).map((id) => `group:${id}`),
  ];
}

function collectSecurityWarnings(account: ResolvedWeChatAccount): string[] {
  const warnings: string[] = [];
  const inbound = account.config.inbound;
  const risk = account.config.riskControl;

  if (inbound?.allowGroup !== false && !inbound?.requireMentionInGroup && !(inbound?.allowGroups?.length)) {
    warnings.push("群聊已开启但未要求 @ 提及，也没有群白名单，容易引入噪声。");
  }

  if (!risk?.senderRateLimitPerMinute && !risk?.groupRateLimitPerMinute) {
    warnings.push("未配置消息限流，容易在回调抖动或群刷屏时放大流量。");
  }

  if (!risk?.sensitiveWords?.length) {
    warnings.push("未配置敏感词列表，转人工或风险语料只能依赖上游处理。");
  }

  if (!account.webhookHost) {
    warnings.push("未显式配置 webhookHost，当前依赖运行时自动探测公网地址。");
  }

  return warnings;
}

export const wechatPlugin: ChannelPlugin<ResolvedWeChatAccount> = {
  id: "wechat",

  meta: PLUGIN_META,

  capabilities: {
    chatTypes: ["direct", "channel"],
    polls: false,
    threads: false,
    media: true,
    reactions: false,
    edit: false,
    reply: false,
  },

  agentPrompt: {
    messageToolHints: () => [
      "- YutoAI 微信节点的目标格式：私聊使用 `user:<wcId>`，群聊使用 `group:<chatRoomId>`。",
      "- 当前支持文本、图片、视频、文件、语音消息接入，外发媒体会优先按图片发送，其他链接自动回退为文本。",
    ],
  },

  configSchema: {
    schema: WechatConfigSchema,
  },

  config: {
    listAccountIds: (cfg) => listWeChatAccountIds(cfg),

    resolveAccount: (cfg, accountId) => resolveWeChatAccount({ cfg, accountId }),

    defaultAccountId: (cfg) => {
      const ids = listWeChatAccountIds(cfg);
      return ids[0] || DEFAULT_ACCOUNT_ID;
    },

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const wechatCfg = cfg.channels?.wechat as WechatConfig | undefined;
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // 默认账号直接写回顶级 enabled。
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            wechat: {
              ...wechatCfg,
              enabled,
            },
          },
        };
      }

      const account = wechatCfg?.accounts?.[accountId];
      if (!account) {
        throw new Error(`Account ${accountId} not found`);
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wechat: {
            ...wechatCfg,
            accounts: {
              ...wechatCfg?.accounts,
              [accountId]: {
                ...account,
                enabled,
              },
            },
          },
        },
      };
    },

    deleteAccount: ({ cfg, accountId }) => {
      const wechatCfg = cfg.channels?.wechat as WechatConfig | undefined;
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // 删除整个 wechat 配置。
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>).wechat;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      const accounts = { ...wechatCfg?.accounts };
      delete accounts[accountId];

      const nextCfg = { ...cfg } as ClawdbotConfig;
      nextCfg.channels = {
        ...cfg.channels,
        wechat: {
          ...wechatCfg,
          accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
        },
      };

      return nextCfg;
    },

    isConfigured: () => {
      // 实际校验在 resolveAccount 内执行，这里只负责声明可配置。
      return true;
    },

    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name || account.nickName || account.accountId,
      wcId: account.wcId,
      isLoggedIn: account.isLoggedIn,
    }),

    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWeChatAccount({ cfg, accountId });
      return resolveAllowEntries(account);
    },

    formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
  },

  security: {
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveWeChatAccount({ cfg, accountId });
      return collectSecurityWarnings(account);
    },
  },

  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,

    applyAccountConfig: ({ cfg, accountId }) => {
      const wechatCfg = cfg.channels?.wechat as WechatConfig | undefined;
      const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        // 默认账号直接写回顶级 enabled。
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            wechat: {
              ...wechatCfg,
              enabled: true,
            },
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wechat: {
            ...wechatCfg,
            accounts: {
              ...wechatCfg?.accounts,
              [accountId]: {
                ...wechatCfg?.accounts?.[accountId],
                enabled: true,
              },
            },
          },
        },
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => normalizeWeChatTarget(target),

    targetResolver: {
      looksLikeId: (id) => {
        // wxid_ 开头视为私聊 ID，@chatroom 视为群聊 ID。
        return id.startsWith("wxid_") || isWeChatGroupId(id);
      },
      hint: "<wxid_xxx|xxxx@chatroom|user:wxid_xxx|group:xxx@chatroom>",
    },
  },

  directory: {
    self: async () => null,

    listPeers: async ({ cfg, query, limit, accountId }) => {
      const account = await resolveWeChatAccount({ cfg, accountId });
      if (!account.isLoggedIn) return [];

      const client = createAccountClient(account);
      const contacts = await client.getContacts(account.wcId!);

      return filterDirectoryEntries(contacts.friends, query, limit).map((id) => ({
        id,
        name: id,
        type: "user" as const,
      }));
    },

    listGroups: async ({ cfg, query, limit, accountId }) => {
      const account = await resolveWeChatAccount({ cfg, accountId });
      if (!account.isLoggedIn) return [];

      const client = createAccountClient(account);
      const contacts = await client.getContacts(account.wcId!);

      return filterDirectoryEntries(contacts.chatrooms, query, limit).map((id) => ({
        id,
        name: id,
        type: "group" as const,
      }));
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      port: null,
    },

    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      port: snapshot.port ?? null,
    }),

    probeAccount: async ({ cfg, accountId }) => {
      const account = await resolveWeChatAccount({ cfg, accountId });
      const client = createAccountClient(account);

      try {
        const status = await client.getStatus();
        return {
          ok: status.valid && status.isLoggedIn,
          error: status.error,
          wcId: status.wcId,
          nickName: status.nickName,
        };
      } catch (err: any) {
        return {
          ok: false,
          error: err.message,
        };
      }
    },

    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name || account.nickName,
      wcId: account.wcId,
      isLoggedIn: account.isLoggedIn,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { cfg, accountId, abortSignal, setStatus, log } = ctx;
      const account = await resolveWeChatAccount({ cfg, accountId });

      log?.info(`启动 YutoAI 微信账号: ${accountId}`);
      log?.info(`代理地址: ${account.proxyUrl}`);

      const client = createAccountClient(account);

      // 先检查当前登录状态。
      const status = await client.getStatus();

      if (!status.valid) {
        throw new Error(`API Key 无效: ${status.error || "未知错误"}`);
      }

      // 未登录时走二维码登录流程。
      if (!status.isLoggedIn) {
        log?.info("当前未登录，开始二维码登录流程");

        const { qrCodeUrl, wId } = await client.getQRCode(
          account.deviceType,
          account.proxy
        );

        await displayQRCode(qrCodeUrl);

        // 轮询登录结果。
        let loggedIn = false;
        let loginResult: { wcId: string; nickName: string; headUrl?: string } | null = null;

        for (let i = 0; i < 60; i++) {
          if (abortSignal?.aborted) {
            throw new Error("登录流程已中止");
          }

          await new Promise((r) => setTimeout(r, 5000));

          const check = await client.checkLogin(wId);

          if (check.status === "logged_in") {
            loggedIn = true;
            loginResult = check;
            break;
          } else if (check.status === "need_verify") {
            log?.warn(`需要辅助验证: ${check.verifyUrl}`);
            console.log(`\n⚠️  需要辅助验证，请访问: ${check.verifyUrl}\n`);
          }
        }

        if (!loggedIn || !loginResult) {
          throw new Error("登录超时：二维码已过期");
        }

        displayLoginSuccess(loginResult.nickName, loginResult.wcId);

        // 这里只更新内存态，持久化由外层运行时负责。
        log?.info(`登录成功: ${loginResult.nickName} (${loginResult.wcId})`);

        // 更新当前账号的内存态。
        applyResolvedIdentity(account, loginResult.wcId, loginResult.nickName);
      } else {
        log?.info(`已登录: ${status.nickName} (${status.wcId})`);
        applyResolvedIdentity(account, status.wcId!, status.nickName);
      }

      // 启动回调服务接收消息。
      const port = account.webhookPort;
      setStatus({ accountId, port, running: true });

      // 生成代理服务回调地址。
      let webhookHost: string;

      if (account.webhookHost) {
        // 优先使用显式配置的公网地址。
        webhookHost = account.webhookHost;
      } else {
        // 云服务器场景下自动探测本机 IPv4。
        const { networkInterfaces } = await import("os");
        const nets = networkInterfaces();
        let localIp = "localhost";
        for (const name of Object.keys(nets)) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal) {
              localIp = net.address;
              break;
            }
          }
          if (localIp !== "localhost") break;
        }
        webhookHost = localIp;
        log?.warn(`webhookHost 未配置，使用自动检测的 IP: ${localIp}`);
        log?.warn(`建议配置: openclaw config set channels.wechat.webhookHost "你的公网 IP 或域名"`);
      }

      const webhookBaseUrl = `http://${webhookHost}:${port}${account.webhookPath}`;
      const webhookAuthToken = buildWebhookAuthToken(account.accountId, account.apiKey);
      const webhookUrl = attachWebhookAuthToken(webhookBaseUrl, webhookAuthToken);
      log?.info(`使用 webhook 地址: ${webhookBaseUrl}`);
      log?.info("Webhook 派生鉴权已启用");

      // 向代理服务注册 webhook。
      log?.info(`向代理服务注册 webhook，wcId=${account.wcId}`);
      await client.registerWebhook(account.wcId!, webhookUrl);

      const { stop } = await startCallbackServer({
        port,
        path: account.webhookPath,
        authToken: webhookAuthToken,
        onMessage: (message) => {
          handleWeChatMessage({
            cfg,
            message,
            runtime: ctx.runtime,
            accountId,
            account,
          }).catch((err) => {
            log?.error(`处理微信消息失败: ${String(err)}`);
          });
        },
        abortSignal,
      });

      log?.info(`YutoAI 微信账号 ${accountId} 已启动，监听端口 ${port}`);
      log?.info(`Webhook 地址: ${webhookBaseUrl}`);

      // 返回停止句柄，供运行时收尾。
      return {
        async stop() {
          stop();
          setStatus({ accountId, port, running: false });
        },
      };
    },
  },

  outbound: {
    async sendText({ cfg, to, text, accountId }) {
      const account = await resolveWeChatAccount({ cfg, accountId });
      const client = createAccountClient(account);

      if (!account.wcId) {
        throw new Error("当前账号尚未登录");
      }

      const result = await client.sendText(to.id, text);

      return {
        channel: "wechat",
        messageId: String(result.newMsgId),
        timestamp: result.createTime,
      };
    },

    async sendMedia({ cfg, to, mediaUrl, text, accountId }) {
      const account = await resolveWeChatAccount({ cfg, accountId });
      const client = createAccountClient(account);

      if (!account.wcId) {
        throw new Error("当前账号尚未登录");
      }

      // 发送媒体前先补发文字说明。
      if (text?.trim()) {
        await client.sendText(to.id, text);
      }

      if (!looksLikeImageUrl(mediaUrl)) {
        const fallbackText = [text?.trim(), `媒体链接: ${mediaUrl}`]
          .filter(Boolean)
          .join("\n");
        const result = await client.sendText(to.id, fallbackText);
        return {
          channel: "wechat",
          messageId: String(result.newMsgId),
          timestamp: result.createTime,
        };
      }

      // 再发送图片主体。
      const result = await client.sendImage(to.id, mediaUrl);

      return {
        channel: "wechat",
        messageId: String(result.newMsgId),
        timestamp: result.createTime,
      };
    },
  },
};
