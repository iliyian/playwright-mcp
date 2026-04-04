require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const readline = require('readline');

const app = express();
app.use(express.text({ type: '*/*', limit: '50mb' }));

const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) {
    console.error('❌ 请在 .env 中设置 AUTH_TOKEN');
    process.exit(1);
}

// ==========================================
// 长驻 MCP 子进程管理
// ==========================================
let mcpChild = null;
let mcpRL = null;
const pendingRequests = new Map(); // id -> res

function startMCP() {
    console.log('[MCP] 启动 bunx @playwright/mcp@latest ...');
    mcpChild = spawn('bunx', ['@playwright/mcp@latest', '--browser', 'chromium'], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    mcpRL = readline.createInterface({ input: mcpChild.stdout });
    mcpRL.on('line', (line) => {
        console.log(`[MCP] [stdout] ${line.substring(0, 300)}${line.length > 300 ? '...' : ''}`);
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && pendingRequests.has(msg.id)) {
                const { res, method } = pendingRequests.get(msg.id);
                pendingRequests.delete(msg.id);

                // 对 tools/list 响应注入 dummy 必填参数，
                // 防止 Gemini 等模型调用无参数工具时不返回 arguments 字段
                if (method === 'tools/list' && msg.result && Array.isArray(msg.result.tools)) {
                    for (const tool of msg.result.tools) {
                        const schema = tool.inputSchema;
                        if (schema && (!schema.required || schema.required.length === 0)) {
                            schema.properties = schema.properties || {};
                            if (!schema.properties.dummy) {
                                schema.properties.dummy = { type: 'string', description: 'Unused placeholder' };
                            }
                            schema.required = ['dummy'];
                            console.log(`[MCP] 已为工具 ${tool.name} 注入 dummy 必填参数`);
                        }
                    }
                    line = JSON.stringify(msg);
                }

                res.setHeader('Content-Type', 'application/json');
                res.end(line);
            }
        } catch (e) {
            console.error(`[MCP] JSON 解析失败: ${e.message}`);
        }
    });

    mcpChild.stderr.on('data', (data) => {
        console.error(`[MCP] [stderr] ${data.toString().trim()}`);
    });

    mcpChild.on('close', (code) => {
        console.log(`[MCP] 子进程退出 code: ${code}`);
        // 清理所有等待中的请求
        for (const [id, { res }] of pendingRequests) {
            res.status(502).json({ error: 'MCP process exited' });
        }
        pendingRequests.clear();
        mcpChild = null;
        mcpRL = null;
        // 自动重启
        console.log('[MCP] 3秒后自动重启...');
        setTimeout(startMCP, 3000);
    });

    console.log(`[MCP] 子进程已启动 PID: ${mcpChild.pid}`);
}

startMCP();

// ==========================================
// Authorization Bearer 认证中间件
// ==========================================
app.use('/playwright', (req, res, next) => {
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
        console.log(`[AUTH] 认证失败 | IP: ${req.ip} | Authorization: ${auth || '(空)'}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    console.log(`[AUTH] 认证通过 | IP: ${req.ip}`);
    next();
});

// ==========================================
// 代理请求到长驻 MCP 子进程
// ==========================================
app.post('/playwright', (req, res) => {
    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    const reqId = parsed.id;
    console.log(`[REQ:${reqId}] <-- ${parsed.method} | 长度: ${payload.length}`);

    if (!mcpChild || mcpChild.killed) {
        console.log(`[REQ:${reqId}] MCP 子进程未就绪`);
        return res.status(503).json({ error: 'MCP process not ready' });
    }

    // 过滤掉注入的 dummy 参数
    if (parsed.method === 'tools/call' && parsed.params && parsed.params.arguments) {
        delete parsed.params.arguments.dummy;
    }

    pendingRequests.set(reqId, { res, method: parsed.method });

    const outPayload = JSON.stringify(parsed);
    mcpChild.stdin.write(outPayload + '\n');
    console.log(`[REQ:${reqId}] --> 已转发到 MCP 子进程`);

    // 客户端断开时清理
    res.on('close', () => {
        if (pendingRequests.has(reqId)) {
            console.log(`[REQ:${reqId}] 客户端断开，清理等待队列`);
            pendingRequests.delete(reqId);
        }
    });
});

// 绑定本地回环 6000 端口
const PORT = 6000;
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
    console.log(`✅ 服务已启动`);
    console.log(`👉 URL: http://${HOST}:${PORT}/playwright`);
    console.log(`🔑 请在请求头中添加: Authorization: Bearer <AUTH_TOKEN>`);
});
