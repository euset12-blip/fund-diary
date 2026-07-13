# 养基日记 · AI 助手自动部署指南

> 把下面这段 Prompt 全文复制，喂给你的 AI 助手（Claude Code / Codex / Cursor 等），它会自动完成部署。

---

## 喂给 AI 助手的 Prompt

```text
帮我部署「养基日记」这个基金分析工作台。按照以下步骤逐项完成，每完成一项向我确认。

## 第一步：环境检查
- 检查 Node.js >= 20，没装就报错并给出下载链接
- npm install
- 检查 Python >= 3.8

## 第二步：养基宝登录（需要我扫二维码）

> ⚠️ 这一步需要**我自己拿手机扫二维码**，你帮不了我。你只需要帮我把命令跑起来、把码打出来。

```bash
pip install requests qrcode Pillow
python yjb-api/yjb_tool.py --login
```

终端会显示二维码 → 我打开手机上的**养基宝 APP** 扫码 → Token 自动保存，完成。

> **注意：不需要去养基宝 APP 里翻 API Secret。** 代码已内置默认值，直接 `--login` 就能用。
> 如果 QR 码没显示出来，加 `--debug` 重跑。

## 第三步：验证持仓

登录成功后，跑：

```bash
node fund-assistant.js --holdings
```

确认能看到基金列表。如果报"未登录养基宝"，重做第二步。

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

## 第五步：环境变量（按需配置）

> 只有 AI 解读和邮件功能需要配。不配也能跑量化分析和评分排名。

检查 .env 并帮我补全：
- DEEPSEEK_API_KEY：DeepSeek API key → https://platform.deepseek.com/api_keys（AI 解读用，不配就跳过）
- SMTP_USER / SMTP_PASS / SMTP_TO：QQ邮箱授权码（邮件推送用，不配就只在终端输出）

每补一个问我一次。YJB_API_SECRET 和 YJB_ACCOUNT_ID 不需要填。

## 第六步：验证
- node fund-assistant.js --holdings（确认持仓能读到）
- node fund-scoring.js --simple（量化评分排名）
- node fund-assistant.js（全组合分析）
- 如果配了 DEEPSEEK_API_KEY，确认 AI 解读段有输出
- 如果配了 SMTP，跑 node fund-assistant.js --action 确认邮件能收到
- 确认所有基金都有板块映射和策略，没有缺漏的

## 第七步：GitHub Actions（可选）
- 如果仓库是 GitHub 的，帮我把 SMTP_USER、SMTP_PASS、SMTP_TO、YJB_ACCOUNT_ID、DEEPSEEK_API_KEY 添加到 GitHub Secrets
- 确认 .github/workflows/daily-analysis.yml 的 cron 时间正确（UTC 6:30 = 北京时间 14:30）

## 完成后
跑一遍完整输出给我看，确认所有信号合理。
```

---

## Codex / Cursor 用户特别注意

Codex 和 Cursor 不会像 Claude Code 那样自动读取 CLAUDE.md。Prompt 开头要加一句：

> 先读 README.md 和 CLAUDE.md，了解项目结构和约定。然后按下面的步骤来。

---

## 注意事项

- **不要改** `lib/signal-engine.js` 和 `lib/email-render.js` —— 这两个是核心引擎，除非你理解信号优先级和 HH/HL 结构的逻辑
- **板块映射**是整个系统的基础，花时间做对。宁可少而精，不要凑数
- **API Secret 不用配**——代码已内置默认值，AI 助手纠结这个的话让它跳过
- `.env` 已在 `.gitignore` 里，不用担心泄露
- 部署过程中有任何报错，把报错内容完整贴给 AI，它会读源码排错

---

## 朋友之间的简版

如果你朋友只是想快速体验、不追求完美，一句话就行：

> "帮我部署这个基金分析工具：npm install，python yjb-api/yjb_tool.py --login 扫码登录，然后跑 node fund-assistant.js 看看效果。"

不需要提 .env、不需要提 Secret。AI 助手会自己读 README.md、CLAUDE.md、源码，找到入口。
