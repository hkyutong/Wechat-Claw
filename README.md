# YutoAI 微信节点

YutoAI 微信节点用于把微信账号接入 Proxy API 和兼容运行时，面向私聊、群聊、扫码登录和回调收发场景。

当前为了兼容既有运行时，仍保留以下技术标识：
- 通道 id 为 `wechat`
- 安装包名为 `wechat-claw`
- 命令入口仍使用 `openclaw`

这三项属于兼容层，不是对外品牌暴露。

## 核心能力

- 微信私聊与群聊接入
- 文本、图片、视频、文件、语音消息接入
- 群聊 @ 门控、命令前缀、黑白名单
- 关键词 / 命令规则驱动的路由覆写与自动动作
- 会话粒度控制，可按发送人、群、群成员拆分 session
- 群回群、群转私聊、静默入链路三种回复策略
- 敏感词、去重、限流等基础风控
- 内建运维命令：`/ping`、`/status`、`/help`
- 二维码登录与登录态轮询
- 单账号/多账号配置
- Webhook 回调接收与消息分发

## 安装

```bash
openclaw plugins install wechat-claw
```

## 升级

```bash
openclaw plugins update wechat
```

## 必填配置

```bash
openclaw config set channels.wechat.apiKey "your-api-key"
openclaw config set channels.wechat.proxyUrl "http://你的代理服务:13800"
openclaw config set channels.wechat.webhookHost "你的公网 IP 或域名"
openclaw config set channels.wechat.enabled true
```

## 推荐单账号配置

```yaml
channels:
  wechat:
    enabled: true
    apiKey: "your-api-key"
    proxyUrl: "http://127.0.0.1:13800"
    webhookHost: "1.2.3.4"
    webhookPort: 18790
    webhookPath: "/webhook/wechat"
    deviceType: "mac"
    proxy: "2"
    inbound:
      allowDirect: true
      allowGroup: true
      requireMentionInGroup: true
      commandPrefixes: ["/", "#"]
      allowedMessageTypes: ["text", "image", "file", "voice", "video"]
      allowGroups: ["vip_room@chatroom"]
      blockSenders: ["wxid_spam"]
    routing:
      defaultSessionMode: "group-member"
      rules:
        - name: "sales-handoff"
          chatType: "group"
          matchType: "keyword"
          pattern: "发包"
          routeKey: "sales-room"
          agentId: "agent-sales"
          sessionMode: "group-member"
          replyMode: "direct"
        - name: "manual-service"
          chatType: "direct"
          matchType: "command"
          pattern: "human"
          autoReplyText: "已为 {{sender}} 转人工，请稍候。"
          skipAgent: true
          auditTag: "manual-service"
    reply:
      defaultGroupReplyMode: "group"
      mentionSenderInGroup: true
      mentionTemplate: "@{name} "
    riskControl:
      dedupWindowMs: 1800000
      dedupMaxSize: 1000
      senderRateLimitPerMinute: 6
      groupRateLimitPerMinute: 30
      sensitiveWords: ["退款", "投诉", "人工"]
      sensitiveReplyText: "该类诉求已进入人工处理通道。"
      rateLimitReplyText: "消息较多，请稍后再试。"
    operations:
      enableBuiltinCommands: true
```

## 多账号配置示例

```yaml
channels:
  wechat:
    accounts:
      sales:
        enabled: true
        apiKey: "sales-key"
        proxyUrl: "http://127.0.0.1:13800"
        webhookHost: "1.2.3.4"
        webhookPort: 18791
      support:
        enabled: true
        apiKey: "support-key"
        proxyUrl: "http://127.0.0.1:13800"
        webhookHost: "1.2.3.4"
        webhookPort: 18792
```

## 首次登录

```bash
openclaw gateway start
```

首次启动会输出二维码或扫码链接。用微信完成扫码后，节点会自动轮询登录状态并注册回调地址。

## 运行说明

- `proxyUrl` 必填，示例统一使用 `13800`
- `webhookHost` 建议显式配置公网 IP 或域名，不要依赖自动探测
- `webhookPath` 默认是 `/webhook/wechat`，现在服务端和注册逻辑都支持自定义路径
- 节点会自动为 webhook 注册地址附加派生鉴权参数，反向代理不要丢弃查询参数
- 不带前缀的 `xxxx@chatroom` 会自动按群目标处理
- 规则 `autoReplyText` 支持模板变量：`{{sender}}`、`{{senderId}}`、`{{group}}`、`{{account}}`、`{{content}}`、`{{command}}`
- `reply.defaultGroupReplyMode` 支持 `group`、`direct`、`silent`
- `routing.defaultSessionMode` / `rules[].sessionMode` 支持 `default`、`sender`、`group`、`group-member`
- 命中 `rules[].routeKey` 时，会用该键参与智能体路由解析，适合把不同群或关键词导向不同业务智能体
- `/ping`、`/status`、`/help` 是内建命令；若不需要，可把 `operations.enableBuiltinCommands` 设为 `false`
- 回复分发与回调注册都依赖同一份 `proxyUrl`
- 非图片媒体外发会自动回退成文本链接，避免因为代理端能力不一致导致发送失败

## 常见业务模式

- 群里只有被 @ 才回复：`inbound.requireMentionInGroup: true`
- 某些群只走指定智能体：给 `routing.rules[]` 配 `groupIds + agentId + routeKey`
- 群里触发后改私聊继续：把对应规则的 `replyMode` 设为 `direct`
- 关键词直接执行动作不进智能体：设置 `autoReplyText` 并把 `skipAgent` 设为 `true`
- 风险话术直接拦截：配置 `riskControl.sensitiveWords` 和 `sensitiveReplyText`

## 服务器验证建议

调试和验证建议只在服务器执行：

```bash
npm run typecheck
npm run test
```

如果服务器宿主机没有 Node，也可以直接用 Docker 验证：

```bash
docker run --rm -v "$(pwd):/app" -w /app node:22-bullseye \
  bash -lc 'npm ci --ignore-scripts && npm run typecheck && npm run test'
```

本地工作区只保留源码，不落构建产物。

## License

MIT
