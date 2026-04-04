# Playwright MCP HTTP Proxy

将 [Playwright MCP](https://github.com/anthropics/playwright-mcp) 的 stdio 模式通过 HTTP 代理暴露，支持 Bearer Token 认证。

## 特性

- **Bearer Token 认证** — 从 `.env` 读取 `AUTH_TOKEN`
- **长驻子进程** — 浏览器状态跨请求保持，异常自动重启
- **Gemini 兼容** — 自动为无参数工具注入 dummy 必填参数，避免 `arguments undefined` 问题
- **请求日志** — 完整的认证、请求、子进程输出日志

## 快速开始

```bash
npm install
npx playwright install chromium
```

创建 `.env`：

```
AUTH_TOKEN=your_secret_token
```

启动：

```bash
node main.js
```

后台运行：

```bash
nohup node main.js >> mcp.log 2>&1 &
```

## 使用

服务默认监听 `http://127.0.0.1:6000/playwright`，请求时需携带 Authorization 头：

```
Authorization: Bearer your_secret_token
```

请求体为标准 MCP JSON-RPC 格式，例如：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "my-client", "version": "0.1.0" }
  }
}
```

## 配置

| 环境变量 | 说明 | 必填 |
|---------|------|------|
| `AUTH_TOKEN` | Bearer 认证 Token | 是 |
