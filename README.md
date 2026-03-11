# YutoAI 微信节点

YutoAI 微信节点用于把微信账号接入 Proxy API 和兼容运行时，面向私聊、群聊、扫码登录和回调收发场景。

当前为了兼容既有运行时，仍保留以下技术标识：
- 通道 id 为 `wechat`
- 安装包名为 `wechat-claw`
- 命令入口仍使用 `openclaw`

这三项属于兼容层，不是对外品牌暴露。

## 核心能力

- 微信私聊与群聊接入
- 文本、图片、文件消息下发
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
- 回复分发与回调注册都依赖同一份 `proxyUrl`

## 服务器验证建议

调试和验证建议只在服务器执行：

```bash
npm run typecheck
npx tsx test-channel.ts
npx tsx test-plugin.ts
```

本地工作区只保留源码，不落构建产物。

## License

MIT
