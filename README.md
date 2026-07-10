# 养基日记

AI 辅助基金组合工作台，用来读取养基宝真实持仓、拉取行情和技术数据、生成量化评分、盘中操作建议、AI 解读和邮件推送。

> 免责声明：本项目输出仅用于个人投资研究和复盘，不构成投资建议。基金投资有风险，买卖决策请自行负责。

## 快速开始

```bash
npm install

# 查看真实持仓
node fund-assistant.js --holdings

# 下午 2:30 操作建议 + 邮件推送
node fund-assistant.js --action

# 全组合分析
node fund-assistant.js

# 量化评分排名
node fund-scoring.js --simple

# 对话式问持仓
node fund-assistant.js --ask "黄金该止损吗？"
```

## 常用命令

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
node deep-analyze.js                   # 默认分析亏损/重点关注基金
node deep-analyze.js --loss            # 只分析亏损基金
node deep-analyze.js --all             # 全量深度分析
node deep-analyze.js 006479            # 指定基金
```

### 持仓与交易记录

```bash
node update-holdings.js                              # 持仓总览
node update-holdings.js --buy 006479 1000 "定投"      # 记录买入
node update-holdings.js --sell 012349 500             # 记录卖出金额
node update-holdings.js --sell 290008 50%             # 记录卖出比例
node update-holdings.js --set 006479 -a 5000 -i 4800  # 手动修正
```

### Web 看板

```bash
node server.js
```

默认访问：`http://localhost:3848`

## 重构后的架构

`fund-assistant.js` 已从原来的大文件拆成分层模块：

```text
fund-assistant.js              # CLI 入口
lib/fund-assistant-app.js      # 编排层：组合数据、策略、AI、邮件
lib/data-layer.js              # 数据获取：养基宝、东方财富、天天基金等
lib/signal-engine.js           # 策略信号：MA、波动率、止损、补仓、止盈
lib/email-render.js            # 邮件 HTML 渲染
lib/email-service.js           # SMTP 发送
```

职责边界：

- 改策略：主要看 `lib/signal-engine.js`
- 改邮件 UI：主要看 `lib/email-render.js`
- 改数据源/API：主要看 `lib/data-layer.js`
- 改 CLI 流程：主要看 `lib/fund-assistant-app.js`
- 改持仓读写：主要看 `holdings-io.js` 和 `update-holdings.js`

## 数据流

```text
养基宝真实持仓
  -> holdings-io.js 归一化
  -> fund-config.json 补充基金名称、板块、策略、指数映射
  -> data-layer.js 拉行情、估值、历史净值、板块数据
  -> signal-engine.js 生成操作信号
  -> fund-assistant-app.js 编排报告和 AI 解读
  -> email-render.js / email-service.js 生成并发送邮件
```

关键原则：

- 养基宝是持仓主数据源。
- `fund-config.json` 只补充元数据和策略配置。
- `holdings.json` 是本地快照和养基宝不可用时的降级来源。
- `交易记录.json` 记录每次买入/卖出操作。
- `操作日志.md` 记录调仓复盘和市场点评。

## 核心策略（v2.1）

策略信号集中在 `lib/signal-engine.js`，当前版本已修复三个关键缺陷并加入了两个新防护层。

### 信号生成

- `calcFundCompositeMA`：**纯历史净值**计算 MA5/MA10/MA20 排列（今日估值不参与，避免当日涨跌污染趋势判断）。
- `detectStructure`：检测 NAV 序列的 HH（更高的高点）+ HL（更高的低点）结构，双确认才给"强势持有"。
- `generateIntradayCommands`：生成止损、保护性止盈、补仓、持有、观望等盘中指令，接受大盘环境参数。

### 三层防护

| 防护层 | 机制 | 拦截的错误 |
|--------|------|-----------|
| 信号优先级 (P2) | P0 风控 > P1 仓位 > P2 交易 > P3 观察 | 止损+补仓同时出现 |
| 大盘环境过滤 (P1) | 沪深300 跌超 -2% 自动屏蔽所有买入信号 | 大盘暴跌时追底 |
| HH/HL 结构验证 | 要求更高的高点+更高的低点双确认 | 下跌中的假反弹被标为"趋势" |
| MA 污染修复 | histMA 判排列，今日估值不参与均线计算 | 上涨日假阳性 |

### 常见信号类型

- `stop_loss`：连续跌破 MA20，趋势转空。**P0 级，触发后屏蔽一切买入信号。**
- `protective_profit`：有较大盈利但首次跌破 MA20，优先保护利润。
- `hold_through_dip`：`hold_dip` 类基金破位时不直接止损，偏持有/定投。
- `dip_buy_*`：回撤够深且短线企稳，分层补仓。**大盘熊市时自动屏蔽。**
- `take_profit` / `partial_profit`：盈利达到阈值后的止盈提醒。
- `hold_dip_strong`：趋势强势（均线多头 + HH/HL 确认），让利润奔跑。
- `hold_bullish`：多头排列但结构未确认 → 降级为"反弹持有"，暂不加仓。
- `market_bear_wait`：大盘跌超阈值，所有买入信号被过滤后的兜底提示。

## 环境变量

复制 `.env.example` 为 `.env` 后填写：

```bash
# 养基宝
YJB_ACCOUNT_ID=your_account_id
YJB_API_SECRET=your_yjb_api_secret

# 邮件
SMTP_USER=your_qq_email@qq.com
SMTP_PASS=your_qq_smtp_password
SMTP_TO=recipient@qq.com

# AI 解读
DEEPSEEK_API_KEY=sk-your_deepseek_api_key
LLM_MODEL=deepseek-chat

# Web/邮件中的看板地址
DASHBOARD_URL=http://localhost:3848
```

养基宝登录 token 默认读取 `~/.yjb_token.json`，与 `yjb-api/` 下的 Python 工具共享。

## 数据源

| 数据 | 来源 | 用途 |
| --- | --- | --- |
| 真实持仓 | 养基宝 API | 持仓金额、份额、收益、账户汇总 |
| 基金实时估值 | 天天基金 / 养基宝 | 盘中操作建议 |
| 基金历史净值 | 东方财富 | MA、回撤、动量 |
| 指数和板块行情 | 东方财富 push2 | 大盘环境、板块联动 |
| 板块量比 | 东方财富 | 量价配合分析 |
| 新闻 | `lib/news.js` | AI 对话和报告上下文 |

## 邮件报告

邮件链路已拆分：

- `lib/email-render.js`：生成 ivory 风格 HTML。
- `lib/email-service.js`：负责 nodemailer SMTP 发送。

邮件结构：

```text
Hero 头部
-> 大盘快照
-> 操作指令卡片
-> 持仓卡列表
-> AI 解读
-> 总结与免责声明
```

## 测试与检查

```bash
node --check fund-assistant.js
node --check lib/fund-assistant-app.js
node --check lib/data-layer.js
node --check lib/signal-engine.js
node --check lib/email-render.js
node --check lib/email-service.js

npx vitest run
```

当前核心测试覆盖（218 tests, 7 files）：

- 工具函数：`lib/utils.test.js`
- 格式化：`lib/format.test.js`
- 技术指标：`lib/analytics.test.js`
- 板块量比：`sector-volume.test.js`
- 评分模型：`fund-scoring.test.js`
- 持仓归一化：`holdings-io.test.js`
- 策略信号：`lib/signal-engine.test.js`（新增 v2.1）

## 项目文件

```text
fund-config.json          # 基金元数据、板块映射、策略配置、邮件配置
holdings-io.js            # 持仓统一读写和字段归一化
yjb-api.js                # 养基宝 API 客户端
fund-assistant.js         # CLI 入口
fund-scoring.js           # 五维量化评分
deep-analyze.js           # 亏损/关注基金深度分析
update-holdings.js        # 交易记录和本地持仓修正
sector-volume.js          # 板块量价分析
server.js                 # Web 看板服务
public/index.html         # Web 看板前端
操作日志.md               # 调仓和市场复盘
交易记录.json             # 买卖流水
```

## 自动化

### GitHub Actions（主力）

```yaml
# .github/workflows/daily-analysis.yml
工作日 14:30 Asia/Shanghai (UTC 6:30)
→ node fund-assistant.js --action
→ 生成操作建议 + AI 解读
→ 发送邮件

# .github/workflows/test.yml
每次 push/PR
→ 全项目语法检查
→ vitest 单元测试 (218 tests)
```

### VPS 定时任务（备选）

`server.js` 内置工作日定时任务，部署到 VPS 后可通过进程守护长期运行。参见 `.github/workflows/` 目录下的 workflow 文件了解 CI 配置。

## 维护建议

- 策略改动必须优先补 `lib/signal-engine.test.js`。
- 邮件样式改动只动 `email-render.js`。
- 数据源异常先看 `data-layer.js` 和 `yjb-api.js`。
- 不要把 `.env`、token、邮箱授权码提交到 Git。
- `tests/**/*.zip`、`tests/**/*.png` 已忽略，避免测试产物污染仓库。
