import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wechatPlugin } from "./src/channel.js";
import { setWeChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "wechat",
  name: "OpenClaw WeChat",
  description: "OpenClaw 微信通道插件",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    setWeChatRuntime(api.runtime);
    api.registerChannel({ plugin: wechatPlugin });
    console.log("OpenClaw 微信通道已注册");
  },
};

export default plugin;
export { wechatPlugin } from "./src/channel.js";
export type { WechatConfig, WechatAccountConfig, ResolvedWeChatAccount } from "./src/types.js";
