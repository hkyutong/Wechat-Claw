# Wechat-Claw

Wechat-Claw is a YutoAI-branded WeChat gateway plugin that connects a WeChat account to a Proxy API and a compatible runtime.

[English](#english) | [中文](#中文)

---

## English

### Overview

Wechat-Claw provides:

- Direct message and group chat support
- Text and image delivery
- QR code login flow
- Multi-account configuration
- Webhook callback handling

### Installation

```bash
openclaw plugins install wechat-claw
```

### Upgrade

```bash
openclaw plugins update wechat
```

### Required Configuration

```bash
openclaw config set channels.wechat.apiKey "your-api-key"
openclaw config set channels.wechat.proxyUrl "http://your-proxy-server:3000"
openclaw config set channels.wechat.webhookHost "your-server-ip-or-domain"
openclaw config set channels.wechat.enabled true
```

### Configuration Example

```yaml
# runtime config
channels:
  wechat:
    enabled: true
    apiKey: "your-api-key"
    proxyUrl: "http://your-proxy:3000"
    webhookHost: "1.2.3.4"
    webhookPort: 18790
    webhookPath: "/webhook/wechat"
    deviceType: "mac"
```

### First Login

```bash
openclaw gateway start
```

The gateway shows a QR code on first startup. Scan it with WeChat to finish login.

### Multi-account Example

```yaml
channels:
  wechat:
    accounts:
      sales:
        apiKey: "sales-key"
        proxyUrl: "http://your-proxy:3000"
        webhookHost: "1.2.3.4"
      support:
        apiKey: "support-key"
        proxyUrl: "http://your-proxy:3000"
        webhookHost: "1.2.3.4"
```

### Notes

- `proxyUrl` is required
- `webhookHost` should be a reachable public IP or domain in cloud deployments
- The plugin keeps the technical channel id as `wechat` for compatibility

---

## 中文

### 概述

Wechat-Claw 是 YutoAI 品牌下的微信通道插件，用于把微信账号接到 Proxy API 和兼容运行时。

它提供：

- 私聊和群聊接入
- 文本和图片发送
- 扫码登录流程
- 多账号配置
- Webhook 回调接收

### 安装

```bash
openclaw plugins install wechat-claw
```

### 升级

```bash
openclaw plugins update wechat
```

### 必填配置

```bash
openclaw config set channels.wechat.apiKey "your-api-key"
openclaw config set channels.wechat.proxyUrl "http://你的代理服务:3000"
openclaw config set channels.wechat.webhookHost "你的服务器IP或域名"
openclaw config set channels.wechat.enabled true
```

### 配置示例

```yaml
# runtime config
channels:
  wechat:
    enabled: true
    apiKey: "your-api-key"
    proxyUrl: "http://你的代理:3000"
    webhookHost: "1.2.3.4"
    webhookPort: 18790
    webhookPath: "/webhook/wechat"
    deviceType: "mac"
```

### 首次登录

```bash
openclaw gateway start
```

首次启动会显示二维码，用微信扫码完成登录。

### 多账号示例

```yaml
channels:
  wechat:
    accounts:
      sales:
        apiKey: "sales-key"
        proxyUrl: "http://你的代理:3000"
        webhookHost: "1.2.3.4"
      support:
        apiKey: "support-key"
        proxyUrl: "http://你的代理:3000"
        webhookHost: "1.2.3.4"
```

### 说明

- `proxyUrl` 必填
- 云服务器部署时 `webhookHost` 应填写公网 IP 或域名
- 为了兼容运行时，技术通道 id 仍保留为 `wechat`

## License

MIT
