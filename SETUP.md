# 养基日记 · Codex / AI 助手 自动部署指南

> 把这份文件全文复制，喂给你的 Codex / AI 助手，它会自动完成部署。

---

## 喂给 Claude 的 Prompt

```text
帮我部署「养基日记」这个基金分析工作台。按照以下步骤逐项完成，每完成一项向我确认。

## 第一步：环境检查
- 检查 Node.js >= 18，没装就报错
- npm install
- cp .env.example .env（如果还没有的话）

## 第二步：养基宝登录（需要自己扫二维码）

> ⚠️ 这一步需要你**自己拿手机扫二维码**，Claude 帮不了你。但 Claude 会帮你把命令跑好、二维码打出来。

用养基宝 APP 扫描二维码登录，token 会自动保存到 `~/.yjb_token.json`，之后 Node.js 和 Python 共享这个 token。

登录步骤（Claude 会引导你）：
1. Claude 先确认你有 Python 3 + pip
2. 帮你 `pip install requests qrcode Pillow`（如果没装的话）
3. 运行 `python yjb-api/yjb_tool.py --login`
4. 终端里会显示一个二维码，你用**养基宝 APP** 扫码
5. 扫完自动保存 token，然后 Claude 会自动拉你的持仓验证

> 💡 如果你的终端不支持显示二维码（比如 Windows CMD），Claude 会给你一个链接，在浏览器打开扫码。

## 第三步：找到你的账户 ID

登录成功后，Claude 会跑 `python yjb-api/yjb_tool.py --accounts` 列出你的账户。把那个 ID 告诉 Claude，他会写入 `.env` 的 `YJB_ACCOUNT_ID`。

## 第四步：板块映射（最关键）
- 从养基宝持仓中获取我持有的所有基金代码
- 读取 fund-config.json，理解 sectorMap、fundIndexMap、fundStrategy 的结构
- 对每只基金：
  a. 从东方财富基金档案页（https://fundf10.eastmoney.com/）拉基金全称和前十大重仓
  b. 根据重仓行业，在东方财富概念板块 BK 列表中匹配最合适的 sectorBK 码
  c. 确定 sector 分类名称（如"半导体/存储"、"光模块"、"白酒"等）
  d. 确定策略类型：QDII/港股 → stop_loss，A股行业 → hold_dip，红利/债券 → hold_dip
- 把所有映射写入 fund-config.json 的 fundIndexMap 和 fundStrategy
- 不要改已有的 sectorMap（板块码→名称映射），只新增缺失的

## 第五步：环境变量
检查 .env 并帮我补全：
- SMTP_USER / SMTP_PASS / SMTP_TO：QQ邮箱的授权码
- DEEPSEEK_API_KEY：DeepSeek API key（AI 解读用）
- DASHBOARD_URL：留空或填 http://localhost:3848

每补一个问我一次。

## 第六步：验证
- node fund-assistant.js --holdings（确认持仓能读到）
- node fund-assistant.js --action（跑一遍完整分析）
- 如果 AI 解读报错，检查 DEEPSEEK_API_KEY
- 如果邮件发送报错，检查 SMTP 配置
- 确认所有基金都有板块映射和策略，没有缺漏的

## 第七步：GitHub Actions（可选）
- 如果仓库是 GitHub 的，帮我把 SMTP_USER、SMTP_PASS、SMTP_TO、YJB_ACCOUNT_ID、YJB_API_SECRET、DEEPSEEK_API_KEY 添加到 GitHub Secrets
- 确认 .github/workflows/daily-analysis.yml 的 cron 时间正确（UTC 6:30 = 北京时间 14:30）

## 完成后
跑一遍完整输出给我看，确认所有信号合理。
```

## Codex 用户特别注意

Codex 不会像 Claude Code 那样自动读取 CLAUDE.md。所以 Prompt 开头要加一句：

> 先读 README.md 和 CLAUDE.md，了解项目结构和约定。然后按下面的步骤来。

## 注意事项

- **不要改** `lib/signal-engine.js` 和 `lib/email-render.js` —— 这两个是核心引擎，除非你理解信号优先级和 HH/HL 结构的逻辑
- **板块映射**是整个系统的基础，花时间做对。宁可少而精，不要凑数。
- 养基宝 API Secret 敏感，**绝对不要**提交到 Git。`.env` 已在 `.gitignore` 里。
- 部署过程中有任何报错，把报错内容完整贴给 Claude，它会读源码排错。

## 朋友之间的简版

如果你朋友只是想快速体验、不追求完美：

> "帮我部署这个基金分析工具：npm install，配好 .env，从我的养基宝拉持仓，自动匹配板块，跑一次 --action 给我看看效果。"

一句话就够了。Codex / AI 助手 会自己读 CLAUDE.md、README.md、源码，找到入口。上面那份详细 Prompt 是给追求完整的用户准备的。
