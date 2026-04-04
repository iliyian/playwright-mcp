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
    payload = {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": method,
    }
    if params:
        payload["params"] = params
    resp = requests.post(URL, json=payload, headers=HEADERS, timeout=120)
    print(f"[{method}] 状态码: {resp.status_code}")
    print(f"[{method}] 响应: {resp.text[:1000]}")
    print()
    return resp.json()

# 1. initialize
print("=== 1. Initialize ===")
call_mcp("initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "test", "version": "0.1.0"}
}, req_id=1)

# 2. 调用 browser_navigate 访问 iliyian.com
print("=== 2. Navigate to iliyian.com ===")
call_mcp("tools/call", {
    "name": "browser_navigate",
    "arguments": {"url": "https://iliyian.com"}
}, req_id=2)

# 3. 截图看看
print("=== 3. Snapshot ===")
call_mcp("tools/call", {
    "name": "browser_snapshot",
    "arguments": {}
}, req_id=3)
