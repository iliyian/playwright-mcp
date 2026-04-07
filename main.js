require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// ==========================================
// 崩溃日志
// ==========================================
const CRASH_LOG = path.join(__dirname, 'crash.log');

function logCrash(type, err) {
    const ts = new Date().toISOString();
    const msg = `[${ts}] ${type}: ${err.stack || err}\n`;
    console.error(msg);
    fs.appendFileSync(CRASH_LOG, msg);
}

process.on('uncaughtException', (err) => { logCrash('uncaughtException', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { logCrash('unhandledRejection', reason); process.exit(1); });

const app = express();
app.use(express.text({ type: '*/*', limit: '50mb' }));

const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) {
    console.error('❌ 请在 .env 中设置 AUTH_TOKEN');
    process.exit(1);
}

// ==========================================
// MCP 进程管理器工厂
// ==========================================
let globalRequestId = 900000;

function createMCPManager(name, cmd, args, opts = {}) {
    let child = null;
    let rl = null;
    const pending = new Map();

    function start() {
        console.log(`[${name}] 启动 ${cmd} ${args.join(' ')} ...`);
        child = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_OPTIONS: '--unhandled-rejections=warn' }
        });

        rl = readline.createInterface({ input: child.stdout });
        rl.on('line', (line) => {
            console.log(`[${name}] [stdout] ${line.substring(0, 300)}${line.length > 300 ? '...' : ''}`);
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && pending.has(msg.id)) {
                    const { res, method } = pending.get(msg.id);
                    pending.delete(msg.id);

                    // 对 tools/list 响应注入 dummy 必填参数，
                    // 防止 Gemini 等模型调用无参数工具时不返回 arguments 字段
                    if (opts.injectDummy && method === 'tools/list' && msg.result && Array.isArray(msg.result.tools)) {
                        for (const tool of msg.result.tools) {
                            const schema = tool.inputSchema;
                            if (schema && (!schema.required || schema.required.length === 0)) {
                                schema.properties = schema.properties || {};
                                if (!schema.properties.dummy) {
                                    schema.properties.dummy = { type: 'string', description: 'Unused placeholder' };
                                }
                                schema.required = ['dummy'];
                                console.log(`[${name}] 已为工具 ${tool.name} 注入 dummy 必填参数`);
                            }
                        }
                        line = JSON.stringify(msg);
                    }

                    // 注入使用建议：推荐 DuckDuckGo，提示避免中国网站
                    if (opts.injectHints && method === 'tools/list' && msg.result && Array.isArray(msg.result.tools)) {
                        const HINTS = '\n\n[SYSTEM HINTS] When performing web searches, prefer using DuckDuckGo (https://duckduckgo.com). Avoid visiting Chinese websites (domains ending in .cn, or sites like baidu.com, qq.com, taobao.com, etc.) as they may be inaccessible or unreliable.';
                        for (const tool of msg.result.tools) {
                            if (tool.description) {
                                tool.description += HINTS;
                            }
                        }
                        line = JSON.stringify(msg);
                        console.log(`[${name}] 已为所有工具注入使用提示`);
                    }

                    res.setHeader('Content-Type', 'application/json');
                    res.end(line);
                }
            } catch (e) {
                console.error(`[${name}] JSON 解析失败: ${e.message}`);
            }
        });

        child.stderr.on('data', (data) => {
            console.error(`[${name}] [stderr] ${data.toString().trim()}`);
        });

        child.on('close', (code) => {
            console.log(`[${name}] 子进程退出 code: ${code}`);
            for (const [, { res }] of pending) {
                res.status(502).json({ error: 'MCP process exited' });
            }
            pending.clear();
            child = null;
            rl = null;
            console.log(`[${name}] 3秒后自动重启...`);
            setTimeout(start, 3000);
        });

        console.log(`[${name}] 子进程已启动 PID: ${child.pid}`);
    }

    // 发送内部指令（不经过 HTTP 层）
    function sendInternal(method, params, onDone) {
        if (!child || child.killed) return;
        const id = globalRequestId++;
        pending.set(id, {
            method,
            res: {
                status() { return this; },
                json() {},
                setHeader() {},
                end(data) { onDone && onDone(data); }
            }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return id;
    }

    function handle(req, res) {
        const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        let parsed;
        try {
            parsed = JSON.parse(payload);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid JSON' });
        }

        const reqId = parsed.id;
        console.log(`[${name}:${reqId}] <-- ${parsed.method} | 长度: ${payload.length}`);

        if (!child || child.killed) {
            console.log(`[${name}:${reqId}] MCP 子进程未就绪`);
            return res.status(503).json({ error: 'MCP process not ready' });
        }

        // 通知类消息没有 id，不需要等响应
        if (reqId === undefined) {
            child.stdin.write(JSON.stringify(parsed) + '\n');
            console.log(`[${name}:notification] --> 已转发 ${parsed.method}`);
            return res.status(204).end();
        }

        // 过滤掉注入的 dummy 参数
        if (opts.stripDummy && parsed.method === 'tools/call' && parsed.params?.arguments) {
            delete parsed.params.arguments.dummy;
        }

        pending.set(reqId, { res, method: parsed.method });
        child.stdin.write(JSON.stringify(parsed) + '\n');
        console.log(`[${name}:${reqId}] --> 已转发到 MCP 子进程`);

        res.on('close', () => {
            if (pending.has(reqId)) {
                console.log(`[${name}:${reqId}] 客户端断开，清理等待队列`);
                pending.delete(reqId);
            }
        });
    }

    return { start, handle, sendInternal };
}

// ==========================================
// 启动各 MCP 实例
// ==========================================
const playwrightMCP = createMCPManager(
    'Playwright',
    'bunx', ['@playwright/mcp@latest', '--browser', 'chromium'],
    { injectDummy: true, stripDummy: true, injectHints: true }
);
playwrightMCP.start();

const context7MCP = createMCPManager(
    'Context7',
    'bunx', ['@upstash/context7-mcp@latest']
);
context7MCP.start();

// ==========================================
// 认证中间件
// ==========================================
function auth(req, res, next) {
    const header = req.headers['authorization'];
    if (!header || header !== `Bearer ${AUTH_TOKEN}`) {
        console.log(`[AUTH] 认证失败 | IP: ${req.ip} | Authorization: ${header || '(空)'}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    console.log(`[AUTH] 认证通过 | IP: ${req.ip}`);
    next();
}

// ==========================================
// 1小时无活动自动关闭所有页面（仅 Playwright）
// ==========================================
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1小时
let lastActivityTime = Date.now();
let idleTimer = null;

function resetIdleTimer() {
    lastActivityTime = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeAllPagesOnIdle, IDLE_TIMEOUT_MS);
}

function closeAllPagesOnIdle() {
    const elapsed = Date.now() - lastActivityTime;
    if (elapsed < IDLE_TIMEOUT_MS) {
        idleTimer = setTimeout(closeAllPagesOnIdle, IDLE_TIMEOUT_MS - elapsed);
        return;
    }
    console.log('[IDLE] 1小时无活动，自动关闭所有浏览器页面...');
    playwrightMCP.sendInternal('tools/call', { name: 'browser_close', arguments: {} }, (data) => {
        console.log(`[IDLE] 关闭页面完成: ${data.substring(0, 200)}`);
    });
}

resetIdleTimer();

// ==========================================
// 路由
// ==========================================
app.post('/playwright', auth, (req, res) => {
    resetIdleTimer();
    playwrightMCP.handle(req, res);
});

app.post('/context7', auth, (req, res) => {
    context7MCP.handle(req, res);
});

// ==========================================
// 启动服务
// ==========================================
const PORT = 6000;
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
    console.log(`✅ 服务已启动`);
    console.log(`👉 Playwright: http://${HOST}:${PORT}/playwright`);
    console.log(`👉 Context7:   http://${HOST}:${PORT}/context7`);
    console.log(`🔑 请在请求头中添加: Authorization: Bearer <AUTH_TOKEN>`);
});
