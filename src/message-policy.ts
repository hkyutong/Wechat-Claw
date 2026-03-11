import type {
  ResolvedWeChatAccount,
  WechatMessageContext,
  WechatReplyMode,
  WechatRoutingRule,
  WechatSessionMode,
} from "./types.js";

const DEFAULT_ALLOWED_MESSAGE_TYPES = ["text", "image", "video", "file", "voice"] as const;
const DEFAULT_COMMAND_PREFIXES = ["/"] as const;

type InboundCommand = {
  prefix: string;
  name: string;
  args: string;
};

export type EvaluatedWeChatMessage = {
  accepted: boolean;
  reason?: string;
  chatType: "direct" | "group";
  normalizedText: string;
  commandBody: string;
  agentBody: string;
  mentioned: boolean;
  command?: InboundCommand;
  messageType: WechatMessageContext["type"];
  matchedRule?: WechatRoutingRule;
  routeKey?: string;
  agentIdOverride?: string;
  sessionMode: WechatSessionMode;
  replyMode: WechatReplyMode;
  autoReplyText?: string;
  skipAgent: boolean;
  auditTags: string[];
  sensitiveWord?: string;
};

export type BuiltinCommandAction = {
  replyText: string;
  stopAfterReply: boolean;
};

export function evaluateWeChatMessage(params: {
  account: ResolvedWeChatAccount;
  message: WechatMessageContext;
}): EvaluatedWeChatMessage {
  const { account, message } = params;
  const inbound = account.config.inbound ?? {};
  const routing = account.config.routing ?? {};
  const riskControl = account.config.riskControl ?? {};
  const isGroup = !!message.group;
  const chatType = isGroup ? "group" : "direct";

  if (!isGroup && inbound.allowDirect === false) {
    return reject("私聊入口已关闭", message, account);
  }
  if (isGroup && inbound.allowGroup === false) {
    return reject("群聊入口已关闭", message, account);
  }

  if (message.type === "unknown") {
    return reject("未知消息类型暂未接入", message, account);
  }

  const allowedMessageTypes = inbound.allowedMessageTypes ?? [...DEFAULT_ALLOWED_MESSAGE_TYPES];
  if (!allowedMessageTypes.includes(message.type)) {
    return reject(`消息类型 ${message.type} 未放行`, message, account);
  }

  if (matchesConfiguredIds(message.sender.id, inbound.blockSenders)) {
    return reject(`发送方 ${message.sender.id} 已被拉黑`, message, account);
  }
  if (matchesConfiguredIds(message.sender.id, inbound.allowSenders, true)) {
    return reject(`发送方 ${message.sender.id} 不在白名单内`, message, account);
  }

  if (isGroup && message.group) {
    if (matchesConfiguredIds(message.group.id, inbound.blockGroups)) {
      return reject(`群 ${message.group.id} 已被拉黑`, message, account);
    }
    if (matchesConfiguredIds(message.group.id, inbound.allowGroups, true)) {
      return reject(`群 ${message.group.id} 不在白名单内`, message, account);
    }
  }

  const normalizedOriginalText = normalizeWhitespace(message.content);
  const mentioned = isGroup ? detectMention({ account, message }) : false;
  const strippedText = shouldStripMentions(inbound.stripMentions) && isGroup
    ? stripLeadingMentions(normalizedOriginalText, collectMentionNames(account, message))
    : normalizedOriginalText;
  const normalizedText = inbound.normalizeWhitespace === false
    ? strippedText.trim()
    : normalizeWhitespace(strippedText);
  const command = parseCommand(normalizedText, inbound.commandPrefixes);

  if (isGroup && inbound.requireMentionInGroup && !mentioned) {
    return reject("群消息未命中 @ 提及规则", message, account, {
      mentioned,
      normalizedText,
      command,
    });
  }

  if (isGroup && inbound.requireCommandPrefixInGroup && !command) {
    return reject("群消息缺少命令前缀", message, account, {
      mentioned,
      normalizedText,
      command,
    });
  }

  const commandBody = command ? command.args || command.name : normalizedText;
  const sensitiveWord = findSensitiveWord(normalizedText, riskControl.sensitiveWords);
  if (sensitiveWord && riskControl.blockOnSensitive !== false) {
    return {
      accepted: false,
      reason: `命中敏感词 ${sensitiveWord}`,
      chatType,
      normalizedText,
      commandBody,
      agentBody: buildAgentBody(message, normalizedText),
      mentioned,
      command,
      messageType: message.type,
      sessionMode: routing.defaultSessionMode ?? "default",
      replyMode: "default",
      autoReplyText: renderTemplate(riskControl.sensitiveReplyText, {
        sender: message.sender.name || message.sender.id,
        senderId: message.sender.id,
        group: message.group?.id ?? "",
        account: account.name || account.nickName || account.accountId,
        content: normalizedText,
        command: command?.name ?? "",
        sensitiveWord,
      }),
      skipAgent: true,
      auditTags: ["sensitive-word"],
      sensitiveWord,
    };
  }

  const matchedRule = findFirstMatchedRule({
    account,
    message,
    chatType,
    normalizedText,
    mentioned,
    command,
  });

  const replyMode = matchedRule?.replyMode ?? "default";
  const sessionMode = matchedRule?.sessionMode ?? routing.defaultSessionMode ?? "default";
  const autoReplyText = renderTemplate(matchedRule?.autoReplyText, {
    sender: message.sender.name || message.sender.id,
    senderId: message.sender.id,
    group: message.group?.id ?? "",
    account: account.name || account.nickName || account.accountId,
    content: normalizedText,
    command: command?.name ?? "",
    sensitiveWord: sensitiveWord ?? "",
  });
  const auditTags = compactUnique([
    matchedRule?.auditTag,
    matchedRule?.name ? `rule:${matchedRule.name}` : undefined,
    command?.name ? `command:${command.name}` : undefined,
    mentioned ? "mentioned" : undefined,
  ]);

  return {
    accepted: true,
    chatType,
    normalizedText,
    commandBody,
    agentBody: buildAgentBody(message, normalizedText),
    mentioned,
    command,
    messageType: message.type,
    matchedRule,
    routeKey: matchedRule?.routeKey,
    agentIdOverride: matchedRule?.agentId ?? routing.defaultAgentId,
    sessionMode,
    replyMode,
    autoReplyText,
    skipAgent: matchedRule?.skipAgent ?? false,
    auditTags,
    sensitiveWord,
  };
}

export function resolveReplyMode(params: {
  account: ResolvedWeChatAccount;
  message: WechatMessageContext;
  evaluation: EvaluatedWeChatMessage;
}): Exclude<WechatReplyMode, "default"> {
  const { account, message, evaluation } = params;
  if (!message.group) {
    return "direct";
  }

  const configured = evaluation.replyMode !== "default"
    ? evaluation.replyMode
    : account.config.reply?.defaultGroupReplyMode ?? "group";

  return configured;
}

export function resolveRoutePeer(params: {
  message: WechatMessageContext;
  evaluation: EvaluatedWeChatMessage;
}): { kind: "direct" | "group"; id: string } {
  const { message, evaluation } = params;
  const fallbackId = message.group?.id ?? message.sender.id;
  return {
    kind: message.group ? "group" : "direct",
    id: evaluation.routeKey || fallbackId,
  };
}

export function composeSessionKey(params: {
  baseSessionKey: string;
  sessionMode: WechatSessionMode;
  message: WechatMessageContext;
}): string {
  const { baseSessionKey, sessionMode, message } = params;
  if (sessionMode === "default") {
    return baseSessionKey;
  }

  const scope = resolveSessionScope(sessionMode, message);
  return scope ? `${baseSessionKey}::${scope}` : baseSessionKey;
}

export function buildGroupReplyPrefix(params: {
  account: ResolvedWeChatAccount;
  message: WechatMessageContext;
}): string | undefined {
  const { account, message } = params;
  if (!message.group || account.config.reply?.mentionSenderInGroup === false) {
    return undefined;
  }

  const speakerName = message.sender.name || message.sender.id;
  const template = account.config.reply?.mentionTemplate || "@{name} ";
  return template
    .replace(/\{name\}/g, speakerName)
    .replace(/\{id\}/g, message.sender.id);
}

export function resolveBuiltinCommandAction(params: {
  account: ResolvedWeChatAccount;
  message: WechatMessageContext;
  evaluation: EvaluatedWeChatMessage;
}): BuiltinCommandAction | null {
  const { account, message, evaluation } = params;
  if (account.config.operations?.enableBuiltinCommands === false) {
    return null;
  }
  if (!evaluation.command) {
    return null;
  }

  const command = evaluation.command.name.toLowerCase();
  if (command === "ping") {
    return {
      replyText: `pong\n账号: ${account.name || account.nickName || account.accountId}\n微信ID: ${account.wcId || "未登录"}`,
      stopAfterReply: true,
    };
  }

  if (command === "status") {
    const requireMention = account.config.inbound?.requireMentionInGroup ? "开启" : "关闭";
    const groupReplyMode = account.config.reply?.defaultGroupReplyMode ?? "group";
    return {
      replyText: [
        "OpenClaw 微信通道状态",
        `账号: ${account.name || account.nickName || account.accountId}`,
        `微信ID: ${account.wcId || "未登录"}`,
        `群内需@触发: ${requireMention}`,
        `群回复模式: ${groupReplyMode}`,
        `命中规则: ${evaluation.matchedRule?.name || "无"}`,
      ].join("\n"),
      stopAfterReply: true,
    };
  }

  if (command === "help") {
    const prefixes = (account.config.inbound?.commandPrefixes ?? [...DEFAULT_COMMAND_PREFIXES]).join(" ");
    const ruleNames = (account.config.routing?.rules ?? [])
      .filter((rule) => rule.enabled !== false)
      .map((rule) => rule.name)
      .slice(0, 8);

    return {
      replyText: [
        "OpenClaw 微信通道命令",
        `命令前缀: ${prefixes}`,
        "内建命令: ping, status, help",
        `群内需@触发: ${account.config.inbound?.requireMentionInGroup ? "是" : "否"}`,
        ruleNames.length > 0 ? `已配置规则: ${ruleNames.join("、")}` : "已配置规则: 无",
      ].join("\n"),
      stopAfterReply: true,
    };
  }

  return null;
}

function reject(
  reason: string,
  message: WechatMessageContext,
  account: ResolvedWeChatAccount,
  extra?: Partial<EvaluatedWeChatMessage>
): EvaluatedWeChatMessage {
  return {
    accepted: false,
    reason,
    chatType: message.group ? "group" : "direct",
    normalizedText: extra?.normalizedText ?? normalizeWhitespace(message.content),
    commandBody: extra?.commandBody ?? normalizeWhitespace(message.content),
    agentBody: extra?.agentBody ?? buildAgentBody(message, normalizeWhitespace(message.content)),
    mentioned: extra?.mentioned ?? false,
    command: extra?.command,
    messageType: message.type,
    sessionMode: account.config.routing?.defaultSessionMode ?? "default",
    replyMode: "default",
    autoReplyText: extra?.autoReplyText,
    skipAgent: true,
    auditTags: extra?.auditTags ?? [],
    sensitiveWord: extra?.sensitiveWord,
  };
}

function findFirstMatchedRule(params: {
  account: ResolvedWeChatAccount;
  message: WechatMessageContext;
  chatType: "direct" | "group";
  normalizedText: string;
  mentioned: boolean;
  command?: InboundCommand;
}): WechatRoutingRule | undefined {
  const { account, message, chatType, normalizedText, mentioned, command } = params;
  const rules = account.config.routing?.rules ?? [];
  return rules.find((rule) =>
    rule.enabled !== false &&
    matchesRule(rule, {
      message,
      chatType,
      normalizedText,
      mentioned,
      command,
    })
  );
}

function matchesRule(
  rule: WechatRoutingRule,
  params: {
    message: WechatMessageContext;
    chatType: "direct" | "group";
    normalizedText: string;
    mentioned: boolean;
    command?: InboundCommand;
  }
): boolean {
  const { message, chatType, normalizedText, mentioned, command } = params;

  if (rule.chatType && rule.chatType !== "all" && rule.chatType !== chatType) {
    return false;
  }
  if (rule.messageTypes?.length && (message.type === "unknown" || !rule.messageTypes.includes(message.type))) {
    return false;
  }
  if (rule.senderIds?.length && !matchesConfiguredIds(message.sender.id, rule.senderIds)) {
    return false;
  }
  if (rule.groupIds?.length && !message.group) {
    return false;
  }
  if (rule.groupIds?.length && message.group && !matchesConfiguredIds(message.group.id, rule.groupIds)) {
    return false;
  }
  if (rule.mentionRequired && !mentioned) {
    return false;
  }
  if (!rule.matchType) {
    return true;
  }

  const pattern = rule.pattern?.trim();
  if (!pattern) {
    return false;
  }

  if (rule.matchType === "command") {
    return command?.name.toLowerCase() === pattern.toLowerCase();
  }

  if (rule.matchType === "keyword") {
    return normalizedText.toLowerCase().includes(pattern.toLowerCase());
  }

  try {
    return compileRegex(pattern).test(normalizedText);
  } catch {
    return false;
  }
}

function buildAgentBody(message: WechatMessageContext, normalizedText: string): string {
  if (message.type === "text") {
    return normalizedText;
  }

  const clues = collectMediaClues(message.raw);
  const lines = [
    `[${resolveMessageTypeLabel(message.type)}消息]`,
    normalizedText ? `说明: ${normalizedText}` : undefined,
    clues.fileName ? `文件名: ${clues.fileName}` : undefined,
    clues.mediaUrl ? `资源: ${clues.mediaUrl}` : undefined,
  ].filter(Boolean);

  return lines.join("\n");
}

function resolveSessionScope(sessionMode: WechatSessionMode, message: WechatMessageContext): string | null {
  if (sessionMode === "sender") {
    return `sender:${message.sender.id}`;
  }
  if (sessionMode === "group") {
    return message.group ? `group:${message.group.id}` : `sender:${message.sender.id}`;
  }
  if (sessionMode === "group-member") {
    return message.group
      ? `group-member:${message.group.id}:${message.sender.id}`
      : `sender:${message.sender.id}`;
  }
  return null;
}

function detectMention(params: {
  account: ResolvedWeChatAccount;
  message: WechatMessageContext;
}): boolean {
  const { account, message } = params;
  const mentionedIds = collectMentionIds(message.raw);
  const accountIds = compactUnique([account.wcId, message.recipient.id]);
  if (accountIds.some((id) => mentionedIds.includes(id))) {
    return true;
  }

  const names = collectMentionNames(account, message);
  return names.some((name) => new RegExp(`(^|\\s)@${escapeRegex(name)}([\\s,:，：]|$)`, "i").test(message.content));
}

function collectMentionNames(account: ResolvedWeChatAccount, message: WechatMessageContext): string[] {
  return compactUnique([
    account.nickName,
    account.name,
    account.wcId,
    message.recipient.id,
  ]);
}

function collectMentionIds(raw: any): string[] {
  const keys = [
    "atUsers",
    "atUserList",
    "atWxIds",
    "atList",
    "mentionedUsers",
    "mentionedWxIds",
  ];

  const values: string[] = [];
  for (const root of [raw, raw?.data]) {
    if (!root || typeof root !== "object") {
      continue;
    }
    for (const key of keys) {
      const value = root[key];
      if (Array.isArray(value)) {
        values.push(...value.map(String));
      } else if (typeof value === "string") {
        values.push(...value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean));
      }
    }
  }
  return compactUnique(values);
}

function parseCommand(text: string, configuredPrefixes?: string[]): InboundCommand | undefined {
  const prefixes = configuredPrefixes?.length ? configuredPrefixes : [...DEFAULT_COMMAND_PREFIXES];
  const prefix = prefixes.find((item) => text.startsWith(item));
  if (!prefix) {
    return undefined;
  }

  const rest = text.slice(prefix.length).trim();
  if (!rest) {
    return undefined;
  }

  const [name, ...args] = rest.split(/\s+/);
  return {
    prefix,
    name: name.toLowerCase(),
    args: args.join(" ").trim(),
  };
}

function findSensitiveWord(content: string, sensitiveWords?: string[]): string | undefined {
  if (!sensitiveWords?.length) {
    return undefined;
  }

  const lowered = content.toLowerCase();
  return sensitiveWords.find((word) => lowered.includes(word.toLowerCase()));
}

function collectMediaClues(raw: any): { fileName?: string; mediaUrl?: string } {
  const fileName = pickFirstString(raw, [
    "fileName",
    "filename",
    "title",
    "name",
    "data.fileName",
    "data.filename",
    "data.title",
    "data.name",
  ]);
  const mediaUrl = pickFirstString(raw, [
    "imageUrl",
    "mediaUrl",
    "fileUrl",
    "downloadUrl",
    "voiceUrl",
    "videoUrl",
    "url",
    "data.imageUrl",
    "data.mediaUrl",
    "data.fileUrl",
    "data.downloadUrl",
    "data.voiceUrl",
    "data.videoUrl",
    "data.url",
  ]);

  return { fileName, mediaUrl };
}

function pickFirstString(source: any, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getPathValue(source, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getPathValue(source: any, path: string): unknown {
  return path.split(".").reduce((current, key) => current?.[key], source);
}

function compileRegex(pattern: string): RegExp {
  const match = /^\/(.+)\/([a-z]*)$/i.exec(pattern);
  if (match) {
    return new RegExp(match[1], match[2]);
  }
  return new RegExp(pattern, "i");
}

function normalizeWhitespace(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function stripLeadingMentions(text: string, names: string[]): string {
  let next = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of names) {
      const regexp = new RegExp(`^@${escapeRegex(name)}([\\s,:，：]|$)`, "i");
      if (regexp.test(next)) {
        next = next.replace(regexp, "").trim();
        changed = true;
      }
    }
  }
  return next;
}

function shouldStripMentions(value: boolean | undefined): boolean {
  return value !== false;
}

function resolveMessageTypeLabel(type: WechatMessageContext["type"]): string {
  switch (type) {
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "file":
      return "文件";
    case "voice":
      return "语音";
    default:
      return "未知";
  }
}

function matchesConfiguredIds(candidate: string, ids?: string[], invert = false): boolean {
  if (!ids?.length) {
    return false;
  }
  const matched = ids.some((item) => item === candidate);
  return invert ? !matched : matched;
}

function renderTemplate(template: string | undefined, context: Record<string, string>): string | undefined {
  if (!template) {
    return undefined;
  }
  return template.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (_, doubleKey, singleKey) => {
    const key = doubleKey || singleKey;
    return context[key] ?? "";
  });
}

function compactUnique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
