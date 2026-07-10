# 🐔 养基日记 · Fund Diary

> AI 驱动的基金组合量化分析工作台 —— 基于 LLM Multi-Agent 架构，集成多源行情数据、技术信号引擎、自动化邮件报告和 Web 看板。

[![CI](https://github.com/euset12-blip/fund-diary/actions/workflows/test.yml/badge.svg)](https://github.com/euset12-blip/fund-diary/actions/workflows/test.yml)
[![Daily Analysis](https://github.com/euset12-blip/fund-diary/actions/workflows/daily-analysis.yml/badge.svg)](https://github.com/euset12-blip/fund-diary/actions/workflows/daily-analysis.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> ⚠️ **免责声明**：本项目输出仅用于个人投资研究和复盘，不构成投资建议。基金投资有风险，买卖决策请自行负责。

---

## 📖 项目简介

养基日记是一个**基金组合量化分析和决策辅助系统**，专为个人基金投资者设计。它通过以下方式帮助投资者做出更理性的决策：

- 📊 **自动拉取真实持仓**：对接养基宝 API，获取支付宝基金账户的实时持仓、估值和收益
- 🔬 **多维量化分析**：MA 均线排列、波动率、回撤、HH/HL 结构、板块量比等 30+ 技术指标
- 🤖 **LLM Multi-Agent 协作**：7 个专业 Agent 各司其职（大盘分析、板块轮动、技术面、基本面、风控、组合优化、总结），协作生成投资洞察
- 📧 **自动化邮件报告**：工作日 14:30 自动生成操作建议 + AI 解读，推送到邮箱
- 🌐 **Web 看板**：实时大盘行情、持仓总览、AI 对话助手

## 🏗️ 核心架构

### 7-Agent 协作系统

系统采用 **LLM Multi-Agent 协作架构**，7 个专业 Agent 并行分析，由编排层统一调度：

| Agent | 职责 | 分析维度 |
|-------|------|----------|
| 🔭 大盘分析 Agent | 上证/沪深300/创业板/科创50 走势 | 市场环境、趋势判断 |
| 🔄 板块轮动 Agent | 板块涨跌、量比、资金流向 | 行业轮动、热点捕捉 |
| 📈 技术面 Agent | MA 排列、HH/HL 结构、波动率 | 趋势强度、入场时机 |
| 📋 基本面 Agent | 基金规模、跟踪误差、费率 | 基金质量评估 |
| 🛡️ 风控 Agent | 最大回撤、止损线、仓位上限 | 风险敞口、保护性止盈 |
| ⚖️ 组合优化 Agent | 板块集中度、相关性、再平衡 | 组合健康度 |
| 📝 总结 Agent | 综合所有 Agent 输出 | 最终操作建议 |

### Signal Engine（信号引擎）v2.1

`lib/signal-engine.js` 是核心决策引擎，采用**三层防护架构**：

```
P0 风控层 → P1 仓位层 → P2 交易层 → P3 观察层
```

| 防护层 | 机制 | 拦截的错误 |
|--------|------|-----------|
| 信号优先级 | P0 > P1 > P2 > P3 | 止损+补仓同时出现 |
| 大盘环境过滤 | 沪深300 跌超 -2% 自动屏蔽买入 | 大盘暴跌时追底 |
| HH/HL 结构验证 | 要求更高的高点 + 更高的低点双确认 | 下跌中的假反弹 |
| MA 污染修复 | histMA 判排列，今日估值不参与均线 | 上涨日假阳性 |

### 数据流

```text
养基宝 API（真实持仓）
  → holdings-io.js（归一化）
  → fund-config.json（元数据 + 策略配置）
  → data-layer.js（拉行情/历史净值/板块数据）
  → signal-engine.js（生成操作信号）
  → fund-assistant-app.js（编排报告 + AI 解读）
  → email-render.js / email-service.js（生成并发送邮件）
```

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js 20+ |
| LLM | DeepSeek API（chat / reasoner） |
| 邮件 | Nodemailer + QQ SMTP |
| Web 看板 | Express + 原生 HTML/CSS/JS |
| 数据源 | 东方财富 API、天天基金 API、养基宝 API |
| CI/CD | GitHub Actions（定时任务 + 自动测试） |
| 测试 | Vitest（218 tests, 7 files） |
| 开发工具 | Claude Code / Codex AI 辅助 |

## 🚀 快速开始

### 前置条件

- Node.js 20+
- Python 3.8+（养基宝登录脚本需要）
- QQ 邮箱（发送分析报告）
- DeepSeek API Key（AI 解读功能）→ [获取地址](https://platform.deepseek.com/api_keys)

### 1. 克隆项目

```bash
git clone https://github.com/euset12-blip/fund-diary.git
cd fund-diary
```

### 2. 安装依赖

```bash
npm install
pip install requests  # 养基宝登录脚本依赖
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入你的真实配置值
```

需要配置的环境变量详见 [`.env.example`](./.env.example)，主要包括：

- `SMTP_USER` / `SMTP_PASS` / `SMTP_TO` — QQ 邮箱 SMTP
- `YJB_API_SECRET` / `YJB_ACCOUNT_ID` — 养基宝 API
- `DEEPSEEK_API_KEY` / `LLM_MODEL` — DeepSeek AI 解读
- `DASHBOARD_URL` — Web 看板地址（可选）

### 4. 登录养基宝

```bash
cd yjb-api
python yjb_tool.py --login
# 用养基宝 APP 扫描二维码登录，Token 自动保存
cd ..
```

### 5. 运行

```bash
# 查看持仓
node fund-assistant.js --holdings

# 全组合分析
node fund-assistant.js

# 下午 2:30 操作建议 + AI 解读 + 邮件推送
node fund-assistant.js --action

# 量化评分排名
node fund-scoring.js --simple

# 对话式 AI 问答
node fund-assistant.js --ask "黄金该止损吗？"

# 启动 Web 看板
node server.js
# 浏览器打开 http://localhost:3848
```

## 📋 常用命令

### 操作建议

```bash
node fund-assistant.js                 # 全组合分析
node fund-assistant.js --action        # 即时操作指令 + AI 解读 + 邮件
node fund-assistant.js --holdings      # 查看当前持仓
node fund-assistant.js --scan          # 扫描热门板块
node fund-assistant.js --all           # 组合分析 + 板块扫描
node fund-assistant.js --ask "问题"    # 基于当前持仓问 AI
```

### 量化评分

```bash
node fund-scoring.js                   # 全量打分排名
node fund-scoring.js --simple          # 简洁排名表
node fund-scoring.js --detail 006479   # 单只基金详细拆解
node fund-scoring.js --json            # JSON 输出
```

### 深度分析

```bash
node deep-analyze.js                   # 默认：亏损 + 重点关注
node deep-analyze.js --loss            # 只看亏损基金
node deep-analyze.js --all             # 全量深度分析
node deep-analyze.js 006479            # 指定基金代码
```

### 持仓与交易记录

```bash
node update-holdings.js                              # 持仓总览
node update-holdings.js --buy 006479 1000 "定投"      # 记录买入
node update-holdings.js --sell 012349 500             # 记录卖出金额
node update-holdings.js --sell 290008 50%             # 记录卖出比例
node update-holdings.js --set 006479 -a 5000 -i 4800  # 手动修正
```

## 🧪 测试

```bash
# 语法检查
node --check fund-assistant.js
node --check lib/fund-assistant-app.js
node --check lib/signal-engine.js
node --check lib/data-layer.js

# 单元测试
npx vitest run
```

测试覆盖（218 tests, 7 files）：

| 测试文件 | 覆盖内容 |
|----------|----------|
| `lib/utils.test.js` | 工具函数 |
| `lib/format.test.js` | 数据格式化 |
| `lib/analytics.test.js` | 技术指标计算 |
| `lib/signal-engine.test.js` | 策略信号生成 |
| `sector-volume.test.js` | 板块量比分析 |
| `fund-scoring.test.js` | 量化评分模型 |
| `holdings-io.test.js` | 持仓数据归一化 |

## 📁 项目结构

```text
fund-diary/
├── fund-assistant.js          # CLI 入口 — 全组合分析 + 操作指令
├── fund-scoring.js            # 五维量化评分排名
├── deep-analyze.js            # 亏损/关注基金深度分析
├── update-holdings.js         # 持仓记录和交易管理
├── sector-volume.js           # 板块量价分析
├── scan-sectors.js            # 热门板块扫描
├── optimize-strategy.js       # 策略参数优化（回测）
├── server.js                  # Web 看板服务
├── lib/
│   ├── fund-assistant-app.js  # 编排层：组合数据、策略、AI、邮件
│   ├── data-layer.js          # 数据获取：多源行情聚合
│   ├── signal-engine.js       # 策略信号引擎（核心）
│   ├── llm.js                 # LLM API 调用 + Multi-Agent 编排
│   ├── analytics.js           # 技术指标计算
│   ├── email-render.js        # 邮件 HTML 渲染（_ivory 风格）
│   ├── email-service.js       # SMTP 邮件发送
│   ├── news.js                # 财经新闻聚合
│   ├── colors.js              # 终端颜色方案
│   ├── format.js              # 数据格式化工具
│   ├── utils.js               # 通用工具
│   └── logger.js              # 日志系统
├── yjb-api/                   # 养基宝 API 客户端
│   ├── yjb_tool.py            # Python CLI（登录 + API 调用）
│   ├── test_api.py            # API 测试脚本
│   └── README.md              # 养基宝对接文档
├── yjb-api.js                 # Node.js 养基宝客户端
├── holdings-io.js             # 持仓统一读写 + 字段归一化
├── fund-config.json           # 基金元数据 + 板块映射 + 策略配置
├── public/index.html          # Web 看板前端
├── .github/workflows/         # GitHub Actions CI/CD
│   ├── daily-analysis.yml     # 工作日 14:30 自动分析 + 邮件
│   └── test.yml               # 语法检查 + 单元测试
├── .env.example               # 环境变量配置模板
├── holdings.json              # 持仓本地快照（空模板）
├── 交易记录.json              # 买卖操作记录（空模板）
├── 操作日志.md                # 调仓复盘和市场点评（空模板）
└── SETUP.md                   # 详细部署指南
```

## ⚙️ 自动化

### GitHub Actions

| Workflow | 触发条件 | 功能 |
|----------|----------|------|
| `daily-analysis.yml` | 工作日 14:30 CST | 自动运行操作建议 + 邮件推送 |
| `test.yml` | Push / PR | 全项目语法检查 + 单元测试 |

### 环境变量配置

所有敏感信息通过环境变量管理，详见 [`.env.example`](./.env.example)。CI 中使用 GitHub Secrets 存储。

## 🔒 安全提醒

- ⚠️ **绝不提交** `.env`、token、API key 到 Git
- `.env` 已在 `.gitignore` 中排除
- 养基宝登录 Token 保存在 `~/.yjb_token.json`（仅本地，权限 600）
- 定期轮换 API key 和邮箱授权码
- 在 GitHub Actions 中使用 Secrets 存储敏感值

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

在提交 PR 前请确保：
1. 语法检查通过：`node --check <修改的文件>`
2. 单元测试通过：`npx vitest run`
3. 策略改动补全对应的测试用例

## 📄 License

MIT License — 详见 [LICENSE](./LICENSE)

---

<p align="center">
  <sub>Made with ❤️ by an AI-assisted fund investor · Powered by DeepSeek & Claude Code</sub>
</p>
