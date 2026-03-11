import type { ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedWeChatAccount, WechatConfig, WechatAccountConfig } from "./types.js";
import { WechatConfigSchema } from "./config-schema.js";
import { ProxyClient } from "./proxy-client.js";
import { startCallbackServer } from "./callback-server.js";
import { handleWeChatMessage } from "./bot.js";
import { displayQRCode, displayLoginSuccess } from "./utils/qrcode.js";
import { attachWebhookAuthToken, buildWebhookAuthToken, buildWebhookSecret } from "./webhook-auth.js";
import { buildWebhookBaseUrl } from "./webhook-url.js";
import { sendWithOutboundControl } from "./outbound-control.js";
import {
  clearPendingLoginState,
  getLastQrIssuedAt,
  getPendingLoginState,
  getStartupCircuitState,
  hydrateAccountFromPersistentState,
  markPendingLoginRendered,
  markPendingLoginVerifyUrl,
  recordLoggedOutState,
  recordLoginSuccessState,
  recordPendingLoginState,
  recordStartupFailureState,
  recordStartupSuccessState,
} from "./account-state.js";
import {
  computeQrThrottleDelayMs,
  computeExponentialBackoffMs,
  resolveStabilityProfile,
  shouldRenderQRCodeAgain,
  sleepWithAbort,
} from "./stability.js";

// 代理服务地址（必须配置）
// openclaw config set channels.wechat.proxyUrl "http://你的代理服务:13800"

const PLUGIN_META = {
  id: "wechat",
  label: "OpenClaw WeChat",
  selectionLabel: "OpenClaw WeChat (微信)",
  docsPath: "/channels/wechat",
  docsLabel: "wechat",
  blurb: "OpenClaw 微信通道插件，通过 Proxy API 接入微信账号。",
  order: 80,
} as const;
const displayedLoginSessions = new Map<string, string>();
const activeAccountLifecycles = new Map<string, { requestStop: () => void }>();

function pickSharedAccountConfig(source?: WechatConfig | WechatAccountConfig): Partial<WechatAccountConfig> {
  if (!source) {
    return {};
  }

  const next: Partial<WechatAccountConfig> = {};

  if ("provider" in source) {
    next.provider = source.provider;
  }
  if ("deviceType" in source) {
    next.deviceType = source.deviceType;
  }
  if ("proxy" in source) {
    next.proxy = source.proxy;
  }
  if ("loginProxyUrl" in source) {
    next.loginProxyUrl = source.loginProxyUrl;
  }
  if ("deviceName" in source) {
    next.deviceName = source.deviceName;
  }
  if ("deviceId" in source) {
    next.deviceId = source.deviceId;
  }
  if ("webhookHost" in source) {
    next.webhookHost = source.webhookHost;
  }
  if ("webhookPort" in source) {
    next.webhookPort = source.webhookPort;
  }
  if ("webhookPath" in source) {
    next.webhookPath = source.webhookPath;
  }
  if ("webhookSecret" in source) {
    next.webhookSecret = source.webhookSecret;
  }
  if ("webhookMessageTypes" in source) {
    next.webhookMessageTypes = source.webhookMessageTypes?.slice();
  }
  if ("webhookIncludeSelfMessage" in source) {
    next.webhookIncludeSelfMessage = source.webhookIncludeSelfMessage;
  }
  if ("webhookRetryCount" in source) {
    next.webhookRetryCount = source.webhookRetryCount;
  }
  if ("webhookTimeoutSec" in source) {
    next.webhookTimeoutSec = source.webhookTimeoutSec;
  }
  if ("webhookTimestampSkewSec" in source) {
    next.webhookTimestampSkewSec = source.webhookTimestampSkewSec;
  }

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

  const resolved: ResolvedWeChatAccount = {
    accountId,
    enabled,
    configured: true,
    name: accountCfg.name,
    provider: accountCfg.provider || "legacy",
    apiKey: accountCfg.apiKey,
    proxyUrl: accountCfg.proxyUrl,
    wcId: accountCfg.wcId,
    isLoggedIn: !!accountCfg.wcId,
    nickName: accountCfg.nickName,
    deviceType: accountCfg.deviceType || "ipad",
    proxy: accountCfg.proxy || "2",
    loginProxyUrl: accountCfg.loginProxyUrl,
    deviceName: accountCfg.deviceName,
    deviceId: accountCfg.deviceId,
    webhookHost: accountCfg.webhookHost,
    webhookPort: accountCfg.webhookPort || 18792,
    webhookPath: accountCfg.webhookPath || "/webhook/wechat",
    webhookSecret: accountCfg.webhookSecret,
    webhookMessageTypes: accountCfg.webhookMessageTypes?.slice(),
    webhookIncludeSelfMessage: accountCfg.webhookIncludeSelfMessage ?? false,
    webhookRetryCount: accountCfg.webhookRetryCount || 3,
    webhookTimeoutSec: accountCfg.webhookTimeoutSec || 10,
    webhookTimestampSkewSec: accountCfg.webhookTimestampSkewSec || 300,
    config: accountCfg,
  };

  hydrateAccountFromPersistentState(resolved, resolveStabilityProfile(resolved));
  return resolved;
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
}

function applyResolvedIdentity(
  account: ResolvedWeChatAccount,
  wcId: string,
  nickName?: string,
  headUrl?: string
): void {
  account.wcId = wcId;
  account.nickName = nickName;
  account.headUrl = headUrl;
  account.isLoggedIn = true;
  account.config.wcId = wcId;
  account.config.nickName = nickName;
}

function computeStartupWaitMs(account: ResolvedWeChatAccount, reason: string): number {
  const profile = resolveStabilityProfile(account);
  const nextState = recordStartupFailureState(account, profile, reason);
  if (nextState.circuitOpenUntil && nextState.circuitOpenUntil > Date.now()) {
    return nextState.circuitOpenUntil - Date.now();
  }
  return computeExponentialBackoffMs(
    nextState.consecutiveFailures,
    profile.startupBaseBackoffMs,
    profile.startupMaxBackoffMs
  );
}

function isAbortLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /流程已中止|登录流程已中止|aborted|abort/i.test(message);
}

async function ensureQRCodeSession(params: {
  account: ResolvedWeChatAccount;
  client: ProxyClient;
  abortSignal?: AbortSignal;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<{ wId: string; qrCodeUrl: string; expiresAt: number }> {
  const { account, client, abortSignal, log } = params;
  const profile = resolveStabilityProfile(account);
  const now = Date.now();
  const pendingLogin = getPendingLoginState(account, profile);

  if (pendingLogin) {
    if (shouldRenderQRCodeAgain({
      lastRenderedSessionId: displayedLoginSessions.get(account.accountId),
      currentSessionId: pendingLogin.wId,
      lastRenderedAt: pendingLogin.lastRenderedAt,
      displayThrottleMs: profile.qrDisplayThrottleMs,
      now,
    })) {
      log?.info?.("复用现有二维码登录会话");
      await displayQRCode(pendingLogin.qrCodeUrl);
      markPendingLoginRendered(account, profile, now);
      displayedLoginSessions.set(account.accountId, pendingLogin.wId);
    } else {
      log?.info?.("沿用仍在有效期内的二维码登录会话");
    }

    return {
      wId: pendingLogin.wId,
      qrCodeUrl: pendingLogin.qrCodeUrl,
      expiresAt: pendingLogin.expiresAt,
    };
  }

  const qrThrottleDelayMs = computeQrThrottleDelayMs(getLastQrIssuedAt(account, profile), profile.qrThrottleMs, now);
  if (qrThrottleDelayMs > 0) {
    log?.info?.(`二维码节流生效，${Math.ceil(qrThrottleDelayMs / 1000)} 秒后再申请新码`);
    await sleepWithAbort(qrThrottleDelayMs, abortSignal);
  }

  const qr = await client.getQRCode(
    account.deviceType,
    account.provider === "wechatpadpro" ? account.loginProxyUrl : account.proxy
  );
  const issuedAt = Date.now();

  const session = {
    wId: qr.wId,
    qrCodeUrl: qr.qrCodeUrl,
    expiresAt: issuedAt + profile.loginTimeoutMs,
  };

  recordPendingLoginState(account, profile, {
    ...session,
    issuedAt,
    lastRenderedAt: issuedAt,
  });
  await displayQRCode(qr.qrCodeUrl);
  displayedLoginSessions.set(account.accountId, qr.wId);
  return session;
}

async function completeLoginFlow(params: {
  account: ResolvedWeChatAccount;
  client: ProxyClient;
  abortSignal?: AbortSignal;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<{ wcId: string; nickName: string; headUrl?: string } | null> {
  const { account, client, abortSignal, log } = params;
  const profile = resolveStabilityProfile(account);
  const qrSession = await ensureQRCodeSession({ account, client, abortSignal, log });

  while (Date.now() < qrSession.expiresAt) {
    if (abortSignal?.aborted) {
      throw new Error("登录流程已中止");
    }

    await sleepWithAbort(profile.loginPollIntervalMs, abortSignal);
    const check = await client.checkLogin(qrSession.wId);

    if (check.status === "logged_in") {
      clearPendingLoginState(account, profile);
      displayedLoginSessions.delete(account.accountId);
      return check;
    }

    if (check.status === "need_verify") {
      log?.warn?.(`需要辅助验证: ${check.verifyUrl}`);
      console.log(`\n⚠️  需要辅助验证，请访问: ${check.verifyUrl}\n`);
      markPendingLoginVerifyUrl(account, profile, check.verifyUrl);
    }
  }

  clearPendingLoginState(account, profile);
  displayedLoginSessions.delete(account.accountId);
  return null;
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

  if (account.provider === "wechatpadpro") {
    warnings.push("WeChatPadPro 属于非官方协议接入，无法承诺零风控；建议固定同城稳定代理并避免频繁重登。");
    if (!account.loginProxyUrl) {
      warnings.push("WeChatPadPro 未配置 loginProxyUrl，首次登录稳定性可能受出口网络影响。");
    }
    if (account.deviceType === "ipad") {
      warnings.push("WeChatPadPro 的 iPad 登录按公开文档可能在首登 24 小时内触发一次掉线，建议完成首次稳定登录后再持续运行。");
    }
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
      "- OpenClaw 微信通道的目标格式：私聊使用 `user:<wcId>`，群聊使用 `group:<chatRoomId>`。",
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
      const profile = resolveStabilityProfile(account);
      let stopCallbackServer: (() => void) | null = null;
      let stopping = false;

      const stopRunningServer = () => {
        if (!stopCallbackServer) {
          return;
        }
        stopCallbackServer();
        stopCallbackServer = null;
      };

      activeAccountLifecycles.get(accountId)?.requestStop();
      const requestStop = () => {
        stopping = true;
        stopRunningServer();
      };
      activeAccountLifecycles.set(accountId, { requestStop });
      abortSignal?.addEventListener("abort", requestStop, { once: true });

      log?.info(`启动 OpenClaw 微信账号: ${accountId}`);
      log?.info(`后端提供方: ${account.provider}`);
      log?.info(`代理地址: ${account.proxyUrl}`);
      if (profile.stateFile) {
        log?.info(`持久化状态文件: ${profile.stateFile}`);
      }

      let statusProbeFailures = 0;

      while (!stopping && !abortSignal?.aborted) {
        try {
          const startupState = getStartupCircuitState(account, profile);
          if (startupState.circuitOpenUntil && startupState.circuitOpenUntil > Date.now()) {
            const remainingMs = startupState.circuitOpenUntil - Date.now();
            const remainingSec = Math.ceil(remainingMs / 1000);
            log?.warn(`登录熔断已开启，${remainingSec} 秒后再尝试拉起账号 ${accountId}`);
            setStatus({
              accountId,
              running: false,
              port: null,
              lastError: `登录熔断中，${remainingSec} 秒后重试`,
            });
            await sleepWithAbort(remainingMs, abortSignal);
          }

          const client = createAccountClient(account);
          const status = await client.getStatus();

          if (!status.valid) {
            throw new Error(`API Key 无效: ${status.error || "未知错误"}`);
          }

          if (!status.isLoggedIn || !status.wcId) {
            log?.info("当前未登录，开始二维码登录流程");
            const loginResult = await completeLoginFlow({
              account,
              client,
              abortSignal,
              log,
            });

            if (!loginResult) {
              const reason = "登录超时：二维码已过期";
              const waitMs = computeStartupWaitMs(account, reason);
              setStatus({
                accountId,
                running: false,
                port: null,
                lastError: reason,
              });
              log?.warn(`${reason}，${Math.ceil(waitMs / 1000)} 秒后重试`);
              await sleepWithAbort(waitMs, abortSignal);
              continue;
            }

            displayLoginSuccess(loginResult.nickName, loginResult.wcId);
            log?.info(`登录成功: ${loginResult.nickName} (${loginResult.wcId})`);
            applyResolvedIdentity(account, loginResult.wcId, loginResult.nickName, loginResult.headUrl);
            recordLoginSuccessState(account, profile, loginResult);
          } else {
            log?.info(`已登录: ${status.nickName} (${status.wcId})`);
            applyResolvedIdentity(account, status.wcId, status.nickName);
            recordLoginSuccessState(account, profile, {
              wcId: status.wcId,
              nickName: status.nickName,
            });
            displayedLoginSessions.delete(account.accountId);
          }

          const port = account.webhookPort;
          setStatus({ accountId, port, running: false });

          let webhookHost: string;
          if (account.webhookHost) {
            webhookHost = account.webhookHost;
          } else {
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
            log?.warn(`建议配置: openclaw config set channels.wechat.webhookHost "你的公网 IP、域名，或 https://你的域名"`);
          }

          const webhookBaseUrl = buildWebhookBaseUrl({
            webhookHost,
            webhookPort: port,
            webhookPath: account.webhookPath,
          });
          const webhookAuthToken = buildWebhookAuthToken(account.accountId, account.apiKey);
          const webhookSecret = account.webhookSecret || buildWebhookSecret(account.accountId, account.apiKey);
          const webhookUrl = attachWebhookAuthToken(webhookBaseUrl, webhookAuthToken);

          log?.info(`使用 webhook 地址: ${webhookBaseUrl}`);
          log?.info("Webhook 派生鉴权已启用");
          if (account.provider === "wechatpadpro") {
            log?.info("WeChatPadPro Webhook HMAC 验签已启用");
          }

          log?.info(`向代理服务注册 webhook，wcId=${account.wcId}`);
          await client.registerWebhook(account.wcId!, webhookUrl);

          stopRunningServer();
          const { stop } = await startCallbackServer({
            port,
            path: account.webhookPath,
            provider: account.provider,
            authToken: webhookAuthToken,
            signatureSecret: account.provider === "wechatpadpro" ? webhookSecret : undefined,
            timestampSkewSec: account.webhookTimestampSkewSec,
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

          stopCallbackServer = stop;
          recordStartupSuccessState(account, profile);
          statusProbeFailures = 0;
          setStatus({
            accountId,
            port,
            running: true,
            lastError: null,
            lastStartAt: Date.now(),
          });
          log?.info(`OpenClaw 微信账号 ${accountId} 已启动，监听端口 ${port}`);
          log?.info(`Webhook 地址: ${webhookBaseUrl}`);

          while (!stopping && !abortSignal?.aborted) {
            await sleepWithAbort(profile.statusProbeIntervalMs, abortSignal);

            try {
              const nextStatus = await client.getStatus();
              if (nextStatus.valid && nextStatus.isLoggedIn && nextStatus.wcId) {
                applyResolvedIdentity(account, nextStatus.wcId, nextStatus.nickName);
                recordLoginSuccessState(account, profile, {
                  wcId: nextStatus.wcId,
                  nickName: nextStatus.nickName,
                });
                statusProbeFailures = 0;
                continue;
              }

              statusProbeFailures += 1;
              log?.warn(`账号 ${accountId} 状态探测异常 (${statusProbeFailures}/${profile.statusProbeFailureThreshold})`);
            } catch (error: any) {
              statusProbeFailures += 1;
              log?.warn(`账号 ${accountId} 状态探测失败 (${statusProbeFailures}/${profile.statusProbeFailureThreshold}): ${error.message}`);
            }

            if (statusProbeFailures < profile.statusProbeFailureThreshold) {
              continue;
            }

            const reason = "状态探测发现离线或代理不可用";
            recordLoggedOutState(account, profile, reason);
            stopRunningServer();
            setStatus({
              accountId,
              running: false,
              port: null,
              lastError: reason,
              lastStopAt: Date.now(),
            });
            const waitMs = computeStartupWaitMs(account, reason);
            log?.warn(`${reason}，${Math.ceil(waitMs / 1000)} 秒后重试`);
            await sleepWithAbort(waitMs, abortSignal);
            break;
          }
        } catch (error: any) {
          stopRunningServer();

          if (stopping || abortSignal?.aborted || isAbortLikeError(error)) {
            break;
          }

          const reason = error?.message || String(error);
          recordLoggedOutState(account, profile, reason);
          setStatus({
            accountId,
            running: false,
            port: null,
            lastError: reason,
            lastStopAt: Date.now(),
          });
          const waitMs = computeStartupWaitMs(account, reason);
          log?.error(`微信账号 ${accountId} 启动失败: ${reason}`);
          log?.warn(`${Math.ceil(waitMs / 1000)} 秒后重试账号 ${accountId}`);
          await sleepWithAbort(waitMs, abortSignal).catch(() => undefined);
        }
      }

      stopRunningServer();
      activeAccountLifecycles.delete(accountId);
      displayedLoginSessions.delete(account.accountId);
      setStatus({
        accountId,
        running: false,
        port: null,
        lastStopAt: Date.now(),
      });
    },

    stopAccount: async ({ accountId, setStatus }) => {
      activeAccountLifecycles.get(accountId)?.requestStop();
      displayedLoginSessions.delete(accountId);
      setStatus({
        accountId,
        running: false,
        port: null,
        lastStopAt: Date.now(),
      });
    },
  },

  outbound: {
    async sendText({ cfg, to, text, accountId }) {
      const account = await resolveWeChatAccount({ cfg, accountId });
      const client = createAccountClient(account);

      if (!account.wcId) {
        throw new Error("当前账号尚未登录");
      }

      const controlled = await sendWithOutboundControl({
        account,
        send: () => client.sendText(to.id, text),
      });

      return {
        channel: "wechat",
        messageId: String(controlled.newMsgId),
        timestamp: controlled.createTime,
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
        await sendWithOutboundControl({
          account,
          send: () => client.sendText(to.id, text),
        });
      }

      if (!looksLikeImageUrl(mediaUrl)) {
        const fallbackText = [text?.trim(), `媒体链接: ${mediaUrl}`]
          .filter(Boolean)
          .join("\n");
        const result = await sendWithOutboundControl({
          account,
          send: () => client.sendText(to.id, fallbackText),
        });
        return {
          channel: "wechat",
          messageId: String(result.newMsgId),
          timestamp: result.createTime,
        };
      }

      // 再发送图片主体。
      const result = await sendWithOutboundControl({
        account,
        send: () => client.sendImage(to.id, mediaUrl),
      });

      return {
        channel: "wechat",
        messageId: String(result.newMsgId),
        timestamp: result.createTime,
      };
    },
  },
};
