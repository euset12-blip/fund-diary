import paramiko, sys, io, os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

VPS_HOST = os.environ.get('VPS_HOST', 'YOUR_VPS_IP')
VPS_USER = os.environ.get('VPS_USER', 'root')
VPS_PASS = os.environ.get('VPS_PASS', 'YOUR_VPS_PASSWORD')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(VPS_HOST, username=VPS_USER, password=VPS_PASS, timeout=15)

def run(cmd, timeout=15):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    return out + err

print("=== 检查 fund-assistant.js 结构 ===")
print(run("wc -l /opt/fund-diary/fund-assistant.js"))
print(run(r"grep -n 'function\|async function\|// ===\|=====' /opt/fund-diary/fund-assistant.js | head -60"))

print("\n=== 检查报告生成和发送部分 ===")
print(run("sed -n '2050,2100p' /opt/fund-diary/fund-assistant.js"))

print("\n=== 检查 sendEmailNotification 函数 ===")
print(run("sed -n '2191,2260p' /opt/fund-diary/fund-assistant.js"))

print("\n=== 检查 --action 入口逻辑 ===")
print(run(r"grep -n 'action\|--action\|processAction\|async function main\|if.*action' /opt/fund-diary/fund-assistant.js | head -30"))

print("\n=== 检查 DeepSeek 相关 ===")
print(run(r"grep -n -i 'deepseek\|openai\|fetch.*api\|https://api' /opt/fund-diary/fund-assistant.js | head -20"))

print("\n=== 检查环境变量或配置中的 API key ===")
print(run(r"grep -n 'DEEPSEEK\|OPENAI\|API_KEY\|apiKey' /opt/fund-diary/fund-config.json 2>/dev/null; echo '---'; cat /opt/fund-diary/.env 2>/dev/null; echo '---'; env 2>/dev/null | grep -i deepseek"))

ssh.close()
