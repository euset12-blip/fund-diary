# 🐔 养基日记 · Fund Diary

> 基金组合量化分析工作台 —— 规则引擎做决策，LLM 做解释，自动邮件推送，Web 实时看板。

[![CI Test](https://github.com/euset12-blip/fund-diary/actions/workflows/ci-test.yml/badge.svg)](https://github.com/euset12-blip/fund-diary/actions/workflows/ci-test.yml)
[![Daily Analysis](https://github.com/euset12-blip/fund-diary/actions/workflows/daily-analysis.yml/badge.svg)](https://github.com/euset12-blip/fund-diary/actions/workflows/daily-analysis.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> ⚠️ **免责声明**：本项目输出仅用于个人投资研究和复盘，不构成投资建议。基金投资有风险，买卖决策请自行负责。

---

## 📖 项目简介

养基日记是一个**基金组合量化分析系统**。它不是为了告诉你"这只基金好不好"，而是回答一个更复杂的问题：**你手里这 15-20 只基金，作为一个组合，现在应该做什么。**

- 📊 **真实持仓对接**：直连支付宝养基宝 API，自动拉取实时持仓、估值、收益
- 🧠 **规则引擎决策**：Signal Engine 基于 MA 排列、HH/HL 结构、波动率、板块量比等 30+ 指标生成操作信号，三层优先级过滤误报
- 📋 **组合层分析**：跨基金板块集中度、相关性暴露、风险敞口——不只看单只，看全局
- 🤖 **LLM 做解释**：结构化 Prompt 将量化数据喂给 DeepSeek，AI 独立判断并与算法交叉验证（DISPUTE 机制）
- 📧 **全自动推送**：工作日 14:30 GitHub Actions 定时运行，生成操作建议 + AI 解读邮件
- 🌐 **Web 看板**：Express 实时大盘 + 持仓总览 + AI 投资助理在线对话

---

## 🏗️ 设计哲学

```
┌─────────────────────────────────────────────┐
│                                             │
│   Signal Engine（规则引擎）    ←── 决策层    │
│   三层防护 · 12 种信号 · 0 个 LLM 调用       │
│                                             │
│   Portfolio Analyzer（组合层）  ←── 分析层    │
│   板块集中度 · 相关性 · 风险敞口              │
│                                             │
│   LLM Agent（解释层）          ←── 表达层    │
│   结构化 Prompt · DISPUTE 交叉验证            │
│                                             │
└─────────────────────────────────────────────┘
```

**核心原则：规则引擎负责"该做什么"，LLM 负责"为什么这么做"。**

很多 AI 基金项目直接把行情数据丢给 GPT 问买卖建议——不可复现、不可审计、幻觉风险高。本项目的做法相反：量化规则引擎生成可追溯的信号，LLM 拿到这些信号 + 原始数据后独立研判，不同意的必须在 DISPUTE 段列出分歧。

---

## 🧠 Signal Engine（信号引擎）v2.1

`lib/signal-engine.js` 是核心决策引擎。它**不调用任何 LLM**，纯数学计算。

```
P0 风控层 → P1 仓位层 → P2 交易层 → P3 观察层
```

| 防护层 | 机制 | 拦截的典型错误 |
|--------|------|---------------|
| P0 信号优先级 | 止损 > 止盈 > 补仓 > 观察，冲突时取最高优先级 | 同一只基金同时触发"止损"和"补仓" |
| P1 大盘过滤 | 沪深300 跌超 -2% → 屏蔽所有买入信号 | 大盘暴跌时追底抄底 |
| P2 HH/HL 结构验证 | 要求更高的高点 + 更高的低点双确认才给"强势持有" | 下跌趋势中的假反弹被误判为反转 |
| P3 MA 污染修复 | 用纯历史净值判均线排列，今日估值只算偏离度 | 日内 +3% 造成"多头排列"假象 |

### 信号类型

| 信号 | 触发条件 | 优先级 |
|------|---------|--------|
| `stop_loss` | 连续 3 日收盘低于 MA20 | P0 |
| `protective_profit` | 盈利但首次跌破 MA20，保护利润 | P0 |
| `take_profit` / `partial_profit` | 盈利超阈值 | P1 |
| `dip_buy` | 回撤够深 + 短线企稳（大盘熊市自动屏蔽） | P2 |
| `hold_through_dip` | hold_dip 策略基金破位不直接止损 | P2 |
| `hold_dip_strong` | 多头排列 + HH/HL 双确认 | P3 |
| `hold_bullish` / `market_bear_wait` | 多头但未确认 / 大盘压制 | P3 |

---

## 📋 组合层分析

单只基金分析回答"这只好不好"，组合层分析回答"你的钱有没有全押在同一个赌注上"。

| 分析维度 | 检测内容 | 典型发现 |
|---------|---------|---------|
| 板块集中度 | 持仓基金的底层行业分布 | "纳指 + 半导体 + CPO + 恒科 = 70% 仓位押注 AI 产业链" |
| 相关性暴露 | 不同基金持有的重叠底层资产 | "A 股红利（012708）和 C 股红利（012709）跟踪同一指数，属重复持仓 |
| 跨市场敞口 | A 股 / 美股 / 港股 / 商品 配比 | "QDII 占比 45%，人民币汇率是隐藏风险因子" |
| 策略覆盖 | 每只基金 stop_loss / hold_dip / light_stop 策略覆盖率 | "20 只基金中 17 只有明确策略，3 只纯手动" |

这些分析结果会输入到 LLM 的 Prompt 中，作为 AI 解读的上下文。

---

## 🤖 LLM 解读层（Multi-Perspective Prompt）

系统采用**单次 LLM 调用 + 结构化 Prompt 实现多视角分析**。不是 7 次 API 调用，而是将全部数据组织到一个上下文中，让模型从多个维度独立研判：

| 分析视角 | 输入数据 | 输出 |
|---------|---------|------|
| 大盘环境 | 上证/沪深300/创业板/科创50 实时行情 | 市场状态判断 |
| 板块轮动 | 板块涨跌、量比、资金流向 | 行业热度排序 |
| 技术面 | MA 排列、HH/HL 结构、波动率 | 趋势强度评估 |
| 风控 | 最大回撤、止损线、仓位集中度 | 风险敞口 |
| 组合健康度 | 板块集中度、跨品种相关性 | 再平衡建议 |

### DISPUTE 机制

Prompt 中每只基金标注了**算法立场**（持有/买入/止损/止盈）。LLM 必须独立判断——如果不同意算法，在 `===DISPUTE===` 段列出：

```
基金代码 | 基金名称 | 算法判断 | AI 判断 | 分歧原因
012349   | 恒生科技 | 持有     | 减仓    | 港股权重过高，组合集中度风险
```

双方一致的不列。这本质是一个**对抗性审查**——不是让 LLM 复读算法结论，而是让它挑战算法。

> **为什么不拆成 7 个独立 Agent 调用？** 单日复盘场景下，所有数据可放入一个 ~8K token 上下文。多轮 Agent 通信引入延迟和错误传播，单次调用 + DISPUTE 在成本（1 次 vs 7 次 API）和可靠性之间取得更优平衡。

---

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js 20+ |
| 规则引擎 | 自研 Signal Engine（纯 JS，0 依赖） |
| LLM | DeepSeek API（chat 模式 + `reasoning_effort: high`） |
| 邮件 | Nodemailer + QQ SMTP |
| Web 看板 | Express 5 + 原生 HTML/CSS/JS |
| 数据源 | 东方财富 API、天天基金 API、养基宝 API |
| 调度 | GitHub Actions（工作日 14:30 CST） |
| 测试 | Vitest（218 tests · 7 files） |
| 开发模式 | AI 协同开发（Claude Code） |

---

## 🚀 快速开始

### 前置条件

| 需要 | 说明 |
|------|------|
| Node.js 20+ | [nodejs.org](https://nodejs.org) 下载安装 |
| 养基宝 APP（手机） | 苹果 App Store 或安卓应用商店搜"养基宝"，扫码登录用 |

### 1. 克隆 & 安装

```bash
git clone https://github.com/euset12-blip/fund-diary.git
cd fund-diary
npm install
```

> 💡 `npm install` 后如果看到 1 个 high severity 漏洞（nodemailer），不影响使用，可以忽略。

### 2. 启动 → 扫码登录

```bash
node server.js
```

浏览器打开 `http://localhost:3848`，点击 **「📱 获取二维码登录」**，用**养基宝 APP 内的扫一扫**扫码（不要用手机相机，会跳微信）。

扫码成功后自动跳转看板，Token 保存在 `~/.yjb_token.json`。

> **不需要**装 Python、不需要配 API Secret——代码已内置默认值。

### 3. 验证

看板里直接能看到你的持仓列表。也可以用命令行：

```bash
node fund-assistant.js --holdings
```

到此为止，你已经有了一套**可工作的持仓分析系统**——不需要配任何 env。

### 4. 可选：开启 AI 解读 / 邮件

只有以下两个功能需要配置，不配不影响量化分析和评分排名：

```bash
cp .env.example .env    # macOS / Linux / Git Bash
# Windows CMD / PowerShell 用:
copy .env.example .env
```

| 功能 | 要填的变量 | 不填的影响 |
|------|-----------|-----------|
| 🤖 AI 解读 | `DEEPSEEK_API_KEY`（去 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 注册即送额度） | 操作指令不含 AI 解读段，量化数据照常 |
| 📧 邮件推送 | `SMTP_USER` / `SMTP_PASS` / `SMTP_TO`（QQ邮箱 → 设置 → 账户 → POP3/SMTP → 生成授权码） | 只在终端输出，不发邮件 |

其他变量（`YJB_API_SECRET`、`YJB_ACCOUNT_ID`、`VPS_*`）全部可选，注释掉就行。

> 💡 如果你更喜欢命令行，仍然可以用 `python yjb-api/yjb_tool.py --login` 扫码（需要 Python 3.8+ 和 `pip install requests`）。

### 5. 运行

```bash
# 不需要任何配置就能跑：
node fund-assistant.js --holdings     # 查看持仓
node fund-scoring.js --simple         # 量化评分排名

# 配了 DEEPSEEK_API_KEY 后：
node fund-assistant.js                # 全组合分析 + AI 解读
node fund-assistant.js --action       # 操作建议 + AI 解读 + 邮件
node fund-assistant.js --ask "问题"   # AI 投资对话

# Web 看板：
node server.js                        # 浏览器打开 http://localhost:3848
```

---

## 📸 示例输出

### 终端 — 量化评分排名

```
排名  基金简称         板块       综合   趋势  动量  资金  回撤  板块    持仓盈亏      建议
─────────────────────────────────────────────────────────────────────────────────────────
 1   纳斯达克100      美股科技     82   ✅  85  83  80  --  --    +¥164.06     🟢 强烈加仓
 2   标普500 C        美股大盘     78   ✅  80  75  78  --  --    +¥61.84      🟢 考虑加仓
 3   黄金ETF          黄金         72   ✅  70  73  72  --  --    +¥114.93     🟢 考虑加仓
 4   红利低波          A股红利     58   ⚠️  55  60  58  50  45    -¥1301.22    🟡 持有观望
```

### 邮件报告

每天 14:30 自动发送，Hero 蓝色渐变头部 → 大盘快照 → 止损/补仓指令卡片 → 持仓概览 → AI 投资洞察。移动端邮箱开箱即读。

### Web 看板

`http://localhost:3848` — 实时大盘行情 + 持仓总览 + AI 投资助理在线对话。

---

## 🛡️ 工程健壮性

| 机制 | 实现 |
|------|------|
| HTTP 超时 | 全部外部请求 10s 超时 |
| 自动重试 | 指数退避，最多 3 次 |
| 多源 Fallback | 养基宝不可用 → `fund-config.json` 降级（至少知道持有哪些基金） |
| 流程保护 | `Promise.race` 6-8s 超时，单源异常不拖死全局 |
| 结构化日志 | Winston + 按天滚动，`logs/` 自动归档 |
| 错误边界 | 关键路径 try-catch，单只基金异常不影响全组合 |
| CI 门禁 | 每次 push 自动语法检查 + 218 项单元测试 |

---

## 🤖 AI 协同开发

本项目采用 AI 协同开发模式（Vibe Coding），在以下环节深度使用了大模型：

- **架构设计**：通过 Claude Code 进行系统分层和模块拆分
- **代码生成**：Signal Engine / LLM Agent 编排由 AI 辅助生成，人工审核
- **CI/CD 搭建**：GitHub Actions 工作流由 AI 根据项目结构自动配置
- **测试覆盖**：218 项测试用例设计由 AI 辅助完成
- **MCP 集成**：探索了基于 Model Context Protocol 的多源数据接入

> 高效利用 AI 节点构建自动化 Workflow，是当下工程团队稀缺的"AI Agent 落地能力"。

---

## 📁 项目结构

```text
fund-diary/
├── fund-assistant.js          # CLI 入口 — 全组合分析 + 操作指令
├── fund-scoring.js            # 五维量化评分排名
├── deep-analyze.js            # 亏损/关注基金深度分析
├── update-holdings.js         # 持仓记录和交易管理
├── sector-volume.js           # 板块量价分析
├── server.js                  # Web 看板服务
├── lib/
│   ├── signal-engine.js       # ★ Signal Engine — 规则决策核心
│   ├── analytics.js           # 技术指标计算（MA/波动率/回撤）
│   ├── data-layer.js          # 多源数据获取 + 超时重试 + Fallback
│   ├── llm.js                 # LLM API 调用 + Multi-Perspective Prompt
│   ├── fund-assistant-app.js  # 编排层：组合数据 → 信号 → AI → 邮件
│   ├── email-render.js        # 邮件 HTML 渲染
│   ├── email-service.js       # SMTP 发送
│   ├── news.js                # 财经新闻聚合
│   ├── logger.js              # Winston 日志系统
│   ├── colors.js / format.js / utils.js  # 工具
├── yjb-api/                   # 养基宝 API 客户端
├── yjb-api.js                 # Node.js 养基宝客户端
├── holdings-io.js             # 持仓统一读写 + 字段归一化
├── fund-config.json           # 基金元数据 · 板块映射 · 策略配置
├── public/index.html          # Web 看板前端
├── .github/workflows/         # CI/CD
│   ├── ci-test.yml            # Push → 语法检查 + 218 tests
│   └── daily-analysis.yml     # 工作日 14:30 → 分析 + 邮件
└── .env.example               # 环境变量模板
```

---

## 🔒 安全

- ⚠️ **绝不提交** `.env`、Token、API Key 到 Git（已在 `.gitignore` 排除）
- 养基宝登录 Token 仅保存在 `~/.yjb_token.json`（权限 600）
- 所有敏感值通过环境变量读取，CI 中使用 GitHub Secrets
- 定期轮换 API Key 和邮箱授权码

---

## 📄 License

MIT — 详见 [LICENSE](./LICENSE)

---

<p align="center">
  <sub>Built with ❤️ · Rules decide, AI explains · Powered by DeepSeek & Claude Code</sub>
</p>
