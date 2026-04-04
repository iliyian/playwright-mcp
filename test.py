import requests
from dotenv import dotenv_values

env = dotenv_values('.env')
TOKEN = env.get('AUTH_TOKEN', '')

URL = 'http://127.0.0.1:6000/playwright'
HEADERS = {
    'Authorization': f'Bearer {TOKEN}',
    'Content-Type': 'application/json'
}

# MCP initialize 请求
payload = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "0.1.0"}
    }
}

print(f"[*] 发送 initialize 请求到 {URL}")
try:
    resp = requests.post(URL, json=payload, headers=HEADERS, timeout=30)
    print(f"[*] 状态码: {resp.status_code}")
    print(f"[*] 响应: {resp.text[:500]}")
except Exception as e:
    print(f"[!] 请求失败: {e}")
