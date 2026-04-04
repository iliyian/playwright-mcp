import requests
from dotenv import dotenv_values

env = dotenv_values('.env')
TOKEN = env.get('AUTH_TOKEN', '')

URL = 'http://127.0.0.1:6000/playwright'
HEADERS = {
    'Authorization': f'Bearer {TOKEN}',
    'Content-Type': 'application/json'
}

def call_mcp(method, params=None, req_id=1):
    payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params:
        payload["params"] = params
    resp = requests.post(URL, json=payload, headers=HEADERS, timeout=120)
    print(f"[{method}] 状态码: {resp.status_code}")
    print(f"[{method}] 响应: {resp.text[:800]}")
    print()
    return resp.json() if resp.text else {}

# 1. initialize
print("=== 1. Initialize ===")
call_mcp("initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "test", "version": "0.1.0"}
}, req_id=1)

# 2. tools/list - 检查 dummy 注入
print("=== 2. tools/list (检查 dummy 注入) ===")
result = call_mcp("tools/list", {}, req_id=2)
if result.get("result", {}).get("tools"):
    for tool in result["result"]["tools"]:
        schema = tool.get("inputSchema", {})
        required = schema.get("required", [])
        has_dummy = "dummy" in schema.get("properties", {})
        print(f"  {tool['name']}: required={required}, has_dummy={has_dummy}")
    print()

# 3. 模拟 Gemini 行为：调用 browser_snapshot 并带上 dummy 参数
print("=== 3. 模拟 Gemini: browser_snapshot(dummy='') ===")
call_mcp("tools/call", {
    "name": "browser_snapshot",
    "arguments": {"dummy": "placeholder"}
}, req_id=3)

# 4. 先导航再 snapshot
print("=== 4. Navigate to iliyian.com ===")
call_mcp("tools/call", {
    "name": "browser_navigate",
    "arguments": {"url": "https://iliyian.com"}
}, req_id=4)

print("=== 5. 模拟 Gemini: browser_snapshot(dummy='') after navigate ===")
call_mcp("tools/call", {
    "name": "browser_snapshot",
    "arguments": {"dummy": ""}
}, req_id=5)
