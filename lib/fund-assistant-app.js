#!/usr/bin/env node
/**
 * 养基助手 - Fund Investment Assistant
 *
 * 功能:
 * 1. 自选基金组合分析 - 净值、业绩、持仓板块分布
 * 2. 资金流向分析 - 主力资金、大单资金流向
 * 3. K线技术分析 - 均线、趋势、量价关系
 * 4. 热门板块发现 - 趋势已建立但未到顶的板块
 * 5. 加仓/持有/减仓建议 + 原因
 *
 * 用法:
 *   node fund-assistant.js                    # 使用默认自选基金
 *   node fund-assistant.js 000001 110011      # 指定基金代码
 *   node fund-assistant.js --scan             # 扫描热门板块
 *   node fund-assistant.js --all              # 完整分析
 */

const fs = require('fs');
const path = require('path');
const { sleep, scalePrice } = require('./utils.js');
const { formatMoney, formatPercent, formatProfit, barChart } = require('./format.js');
const { COLORS, c: color } = require('./colors.js');
const { calcVolatility, dynamicThresholds, calcMASlope, trendAdjustedMultipliers, countDaysBelowMA } = require('./analytics.js');
const log = require('./logger.js')('fund-assistant');
const { fetchSectorVolume, describeVolume, volumePriceSignal } = require('../sector-volume.js');
const {
  fetchYjbData, yjbApi, httpGet, loadHoldings,
  getFundValuation, getIndexChange, getFundValuationSina,
  estimateFundFromIndex, getFundHistoryNav, getFundHoldings,
  getStockQuote, getStockIndustry, getStockKline, getSectorQuote,
} = require('./data-layer.js');
const { stripDisputeMarkers } = require('./email-render.js');
const { initEmailService, sendEmailNotification } = require('./email-service.js');
const {
  calcMA, analyzeKlineTrend, analyzeCapitalFlow, generateRecommendation,
  calcFundCompositeMA, generateIntradayCommands, countDaysBelowMA20,
} = require('./signal-engine.js');

const ROOT_DIR = path.join(__dirname, '..');

// ═══════════════════════════════════════════════════════════
// 统一配置（从 fund-config.json 加载，避免双份维护）
// ═══════════════════════════════════════════════════════════
const sharedConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'fund-config.json'), 'utf-8'));
  } catch (e) {
    console.error('❌ 无法加载 fund-config.json:', e.message);
    process.exit(1);
  }
})();

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  // 我的养基宝持仓（存量 watchlist 从 fund-config.json 自动加载）
  watchlist: [
    '006479', '019305', '017641', '008164', '023639', '025209',
    '013416', '001549', '012349', '290008', '016874', '011452',
  ],

  // 操作日志文件
  logFile: path.join(ROOT_DIR, '操作日志.md'),

  // ⬇️ 以下从 fund-config.json 加载
  sectorMap: sharedConfig.sectorMap,
  fundStrategy: sharedConfig.fundStrategy,
  fundIndexMap: sharedConfig.fundIndexMap,
  indices: sharedConfig.indices,
  email: {
    ...sharedConfig.email,
    user: process.env.SMTP_USER || sharedConfig.email.user,
    pass: process.env.SMTP_PASS || sharedConfig.email.pass,
    to: process.env.SMTP_TO || sharedConfig.email.to,
  },
  profitLoss: {},  // 运行时从 holdings 数据填充

  // 请求间隔 (ms)
  requestDelay: 200,
};

// ── 初始化邮件服务（由 email-service.js 管理 nodemailer 生命周期）──
initEmailService({
  emailConfig: CONFIG.email,
  dashboardUrl: process.env.DASHBOARD_URL || '',
  log,
});

// ═══════════════════════════════════════════════════════════
// 持仓加载 → lib/data-layer.js（loadHoldings）
// ═══════════════════════════════════════════════════════════

// ?????????? lib/signal-engine.js

async function scanHotSectors() {
  console.log(color(COLORS.bold, '\n🔥 热门板块扫描中...\n'));

  const results = [];
  const codes = Object.keys(CONFIG.sectorMap);

  for (let i = 0; i < codes.length; i++) {
    const bk = codes[i];
    const name = CONFIG.sectorMap[bk];
    process.stdout.write(`\r  扫描进度: ${i + 1}/${codes.length} - ${name}    `);

    const quote = await getSectorQuote(bk);
    if (quote && quote.changePercent !== 0) {
      // 获取板块K线做趋势分析
      const kline = await getStockKline(`90.${bk}`, 30);
      const trend = kline.length >= 20 ? analyzeKlineTrend(kline) : null;

      results.push({
        bkCode: bk,
        name,
        change: quote.changePercent,
        price: quote.price,
        trend: trend?.trend || 'unknown',
        trendScore: trend?.score || 0,
        volRatio: trend?.volRatio || 0,
        signals: trend?.signals || [],
      });
    }
    await sleep(CONFIG.requestDelay);
  }

  // 筛选：趋势已建立（bullish/sideways偏多）但未过热
  const candidates = results
    .filter(r => r.trend === 'bullish' || (r.trend === 'sideways' && r.trendScore > 0))
    .filter(r => r.change < 8) // 排除单日涨幅过大的（可能已到顶）
    .sort((a, b) => {
      // 优先：趋势得分高 + 有资金介入（量比高）+ 涨幅适中
      const scoreA = a.trendScore * 0.6 + a.volRatio * 10 * 0.4;
      const scoreB = b.trendScore * 0.6 + b.volRatio * 10 * 0.4;
      return scoreB - scoreA;
    });

  return candidates.slice(0, 10);
}

// ============================================================
// 输出报告
// ============================================================

async function analyzePortfolio(fundCodes) {
  console.log(color(COLORS.bold, '\n' + '='.repeat(70)));
  console.log(color(COLORS.bold, '  养 基 助 手 - 基 金 投 资 分 析'));
  console.log(color(COLORS.bold, '='.repeat(70)));

  // 先获取市场环境
  console.log(color(COLORS.cyan, '\n📊 市场环境\n'));

  const indexData = {};
  for (const [secid, name] of Object.entries(CONFIG.indices)) {
    const fields = 'f43,f44,f45,f46,f57,f58,f170,f169';
    try {
      const text = await httpGet(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`,
        { referer: 'https://quote.eastmoney.com/' }
      );
      const json = JSON.parse(text);
      if (json.rc === 0 && json.data) {
        const d = json.data;
        const price = scalePrice(d.f43);
        const chg = (d.f170 || d.f169 || 0) / 100;
        const high = scalePrice(d.f44);
        const low = scalePrice(d.f45);
        const sign = chg >= 0 ? '+' : '';
        const chgColor = chg >= 0 ? COLORS.red : COLORS.green;
        indexData[secid] = {
          name: d.f58 || name,
          price,
          change: chg,
          high,
          low,
        };
        console.log(`  ${d.f58 || name}: ${price?.toFixed(2)}  ${chgColor}${sign}${chg?.toFixed(2)}%${COLORS.reset}  高:${high?.toFixed(2)}  低:${low?.toFixed(2)}`);
      }
    } catch (e) {}
    await sleep(100);
  }

  // 大盘环境评估
  const shComp = indexData['1.000001'];
  let marketEnv = 'neutral';
  if (shComp) {
    if (shComp.change > 1) marketEnv = 'risk_on';
    else if (shComp.change < -1) marketEnv = 'risk_off';
  }

  console.log(`\n  市场情绪: ${marketEnv === 'risk_on' ? color(COLORS.red, '🔥 偏暖') : marketEnv === 'risk_off' ? color(COLORS.green, '❄️ 偏冷') : color(COLORS.yellow, '😐 中性')}`);

  // 逐只基金分析
  for (const code of fundCodes) {
    console.log(color(COLORS.cyan, `\n${'─'.repeat(70)}`));
    console.log(color(COLORS.bold, `\n📈 基金 ${code} 深度分析\n`));

    // 1. 基金估值
    const fundVal = await getFundValuation(code);
    if (!fundVal) {
      console.log(`  ${color(COLORS.red, '获取基金数据失败')}`);
      continue;
    }

    const chgColor = fundVal.valuationChange >= 0 ? COLORS.red : COLORS.green;
    console.log(`  基金名称: ${color(COLORS.bold, fundVal.name)}`);
    console.log(`  净值日期: ${fundVal.navDate}`);
    console.log(`  单位净值: ${fundVal.nav}`);
    console.log(`  实时估值: ${fundVal.valuation}  ${chgColor}${formatPercent(fundVal.valuationChange)}${COLORS.reset}`);
    console.log(`  估值时间: ${fundVal.valuationTime}`);

    await sleep(CONFIG.requestDelay);

    // 2. 近期表现
    const history = await getFundHistoryNav(code, 30);
    let change1w = null, change1m = null;
    if (history.length >= 5) {
      const latest = history[0].nav;
      const weekAgo = history[Math.min(4, history.length - 1)].nav;
      change1w = ((latest - weekAgo) / weekAgo) * 100;
    }
    if (history.length >= 20) {
      const latest = history[0].nav;
      const monthAgo = history[Math.min(19, history.length - 1)].nav;
      change1m = ((latest - monthAgo) / monthAgo) * 100;
    }

    console.log(`\n  📅 近期表现:`);
    console.log(`    近1周: ${change1w ? (change1w >= 0 ? color(COLORS.red, formatPercent(change1w)) : color(COLORS.green, formatPercent(change1w))) : '--'}`);
    console.log(`    近1月: ${change1m ? (change1m >= 0 ? color(COLORS.red, formatPercent(change1m)) : color(COLORS.green, formatPercent(change1m))) : '--'}`);

    if (history.length >= 5) {
      const maxChg = 10;
      console.log(`\n  📉 近5日净值走势:`);
      const recent5 = history.slice(0, 5).reverse();
      for (const d of recent5) {
        const chgCol = d.change >= 0 ? COLORS.red : COLORS.green;
        console.log(`    ${d.date}  ${d.nav.toFixed(4)}  ${chgCol}${formatPercent(d.change)}${COLORS.reset}  ${barChart(d.change, maxChg, 15)}`);
      }
    }

    await sleep(CONFIG.requestDelay);

    // 3. 持仓分析
    const holdings = await getFundHoldings(code);
    if (holdings.length > 0) {
      console.log(`\n  🏢 前十大持仓股分析:`);

      let totalTechScore = 0;
      let totalFlowScore = 0;
      const sectorExposure = {};

      for (let i = 0; i < Math.min(holdings.length, 5); i++) {
        const h = holdings[i];
        const marketCode = h.stockCode.startsWith('6') ? '1' : '0';
        const secid = `${marketCode}.${h.stockCode}`;

        const stockQuote = await getStockQuote(secid);
        const industry = await getStockIndustry(secid);

        // 板块归集
        if (industry) {
          const key = industry.industry || '其他';
          sectorExposure[key] = (sectorExposure[key] || 0) + 1;
        }

        console.log(`\n    ${h.rank}. ${color(COLORS.bold, h.stockName)} (${h.stockCode})`);
        if (industry) {
          console.log(`       行业: ${industry.industry || '--'} | 概念: ${industry.concepts.slice(0, 3).join(', ')}`);
        }
        if (stockQuote) {
          const sChg = stockQuote.change || 0;
          const sChgCol = sChg >= 0 ? COLORS.red : COLORS.green;
          console.log(`       现价: ${stockQuote.price?.toFixed(2)}  ${sChgCol}${sChg > 0 ? '+' : ''}${sChg?.toFixed(2)}%${COLORS.reset}`);
          console.log(`       主力: ${(stockQuote.mainFlow || 0) > 0 ? color(COLORS.red, '净流入') : color(COLORS.green, '净流出')} ${formatMoney(Math.abs(stockQuote.mainFlow || 0))} | 换手: ${(stockQuote.turnover || 0)?.toFixed(1)}%`);
        }

        await sleep(CONFIG.requestDelay);
      }

      // 板块分布
      console.log(`\n  📊 持仓板块分布:`);
      const sortedSectors = Object.entries(sectorExposure).sort((a, b) => b[1] - a[1]);
      for (const [sector, count] of sortedSectors) {
        const pct = Math.round((count / holdings.length) * 100);
        console.log(`    ${sector}: ${barChart(pct, 100, 20)} ${pct}%`);
      }
    }

    // 4. 底层股票K线分析
    if (holdings.length > 0) {
      const firstHolding = holdings[0];
      const marketCode = firstHolding.stockCode.startsWith('6') ? '1' : '0';
      const secid = `${marketCode}.${firstHolding.stockCode}`;

      const kline = await getStockKline(secid, 60);
      if (kline.length >= 20) {
        const trend = analyzeKlineTrend(kline);
        console.log(`\n  📐 第一重仓股 ${firstHolding.stockName} 技术面:`);
        console.log(`    趋势: ${trend.trend === 'bullish' ? color(COLORS.red, '📈 多头') : trend.trend === 'bearish' ? color(COLORS.green, '📉 空头') : color(COLORS.yellow, '📊 震荡')}`);
        console.log(`    MA5: ${trend.ma5?.toFixed(2)} | MA10: ${trend.ma10?.toFixed(2)} | MA20: ${trend.ma20?.toFixed(2)}`);
        console.log(`    最新价: ${kline[kline.length-1].close} | 5日涨跌: ${formatPercent(trend.change5d)}`);
        console.log(`    波动率: ${trend.volatility?.toFixed(1)}% | 量比: ${trend.volRatio?.toFixed(1)}`);

        if (trend.signals.length > 0) {
          console.log(`    信号:`);
          for (const s of trend.signals) {
            const icon = s.type === 'positive' ? '✅' : s.type === 'negative' ? '❌' : s.type === 'warning' ? '⚠️' : '➖';
            console.log(`      ${icon} ${s.msg}`);
          }
        }
      }
    }

    // 5. 综合建议
    console.log(color(COLORS.bold, `\n  💡 综合建议:`));

    // 获取第一重仓股的综合分析
    let techScore = 0, flowScore = 0;
    const allSignals = [];

    if (holdings.length > 0) {
      const firstHolding = holdings[0];
      const mkt = firstHolding.stockCode.startsWith('6') ? '1' : '0';
      const secid = `${mkt}.${firstHolding.stockCode}`;

      const kline = await getStockKline(secid, 60);
      const stockQuote = await getStockQuote(secid);

      const tech = kline.length >= 20 ? analyzeKlineTrend(kline) : { score: 0, signals: [], trend: 'unknown' };
      const flow = analyzeCapitalFlow(stockQuote);

      const rec = generateRecommendation(tech, flow, {
        realtimeChange: fundVal.valuationChange,
        change1w,
      });

      const actionIcon = rec.score >= 65 ? '🟢' : rec.score >= 40 ? '🟡' : '🔴';
      console.log(`  ${actionIcon} 操作建议: ${rec.colorCode}${color(COLORS.bold, rec.action)}${COLORS.reset}`);
      console.log(`  信心指数: ${rec.score}/100`);
      console.log(`  理由: ${rec.desc}`);

      if (rec.signals.length > 0) {
        console.log(`\n  详细分析:`);
        // 按来源分组
        const bySource = {};
        for (const s of rec.signals) {
          if (!bySource[s.source]) bySource[s.source] = [];
          bySource[s.source].push(s);
        }
        for (const [source, sigs] of Object.entries(bySource)) {
          console.log(`    [${source}]`);
          for (const s of sigs.slice(0, 5)) {
            const icon = s.type === 'positive' ? '✅' : s.type === 'negative' ? '❌' : s.type === 'warning' ? '⚠️' : '➖';
            console.log(`      ${icon} ${s.msg}`);
          }
        }
      }
    }

    await sleep(CONFIG.requestDelay);
  }

  // 综合市场环境 + 各基金交叉分析
  console.log(color(COLORS.cyan, `\n${'─'.repeat(70)}`));
  console.log(color(COLORS.bold, `\n📋 整体组合建议:\n`));
  if (marketEnv === 'risk_off') {
    console.log(`  ${color(COLORS.yellow, '⚠️ 大盘走弱，建议整体仓位控制在50%以内')}`);
    console.log(`  ${color(COLORS.yellow, '  如有获利较多的基金，可考虑部分止盈')}`);
    console.log(`  ${color(COLORS.green, '  大跌时可分批逢低布局优质基金')}`);
  } else if (marketEnv === 'risk_on') {
    console.log(`  ${color(COLORS.red, '🔥 大盘偏暖，可维持较高仓位')}`);
    console.log(`  ${color(COLORS.yellow, '  但需注意追高风险，优先加仓趋势稳健的基金')}`);
  } else {
    console.log(`  ${color(COLORS.cyan, '📊 市场中性，精选个基，控制仓位')}`);
  }

  return { marketEnv, indexData };
}

// ============================================================
// 下午 2:30 即时操作模式
// ============================================================

async function runActionMode(fundCodes) {
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  // ═══════════════════════════════════════════════════════════
  // 头部
  // ═══════════════════════════════════════════════════════════
  console.log(color(COLORS.bold, '\n' + '═'.repeat(66)));
  console.log(color(COLORS.bold, `  🔴 养基日记 · 即时操作指令`));
  console.log(color(COLORS.dim,   `  ⏰ ${timeStr}  |  所有操作请在 15:00 前完成`));
  console.log(color(COLORS.bold, '═'.repeat(66)));

  // ──────── 大盘快照（养基宝优先 → 东方财富兜底）────────
  console.log(color(COLORS.cyan, '\n📊 大盘快照'));

  let shComp = null, szComp = null, cybComp = null;
  let yjbData = null; // 养基宝全量数据
  let yjbFundMap = {}; // code → 养基宝基金数据

  // 尝试从养基宝拉数据
  try {
    yjbData = await fetchYjbData();
    if (yjbData.indexData) {
      const idxMap = yjbApi.normalizeIndexData(yjbData.indexData);
      shComp = idxMap['1.000001'] || null;
      szComp = idxMap['0.399001'] || null;
      cybComp = idxMap['0.399006'] || null;
    }
    // 构建基金估值映射
    if (yjbData.holdings) {
      const norm = yjbApi.normalizeHoldings(yjbData.holdings);
      norm.forEach(h => { yjbFundMap[h.code] = h; });
      console.log(color(COLORS.dim, `  📡 养基宝已连接 · 支付宝账户 · ${norm.length} 只基金`));
    }
  } catch (e) {
    // 养基宝不可用，回退东方财富
  }

  // ──────── 板块量比数据（东方财富概念板块）────────
  let sectorVolMap = {}; // code → { volumeRatio, turnover, pctChg, name }
  try {
    const bkCodesNeeded = new Set();
    fundCodes.forEach(code => {
      const bk = CONFIG.fundIndexMap?.[code]?.sectorBK;
      if (bk) bkCodesNeeded.add(bk);
    });
    if (bkCodesNeeded.size > 0) {
      const bkVolData = await fetchSectorVolume([...bkCodesNeeded]);
      // 反向映射: BK码 → code[]
      fundCodes.forEach(code => {
        const bk = CONFIG.fundIndexMap?.[code]?.sectorBK;
        if (bk && bkVolData[bk]) {
          sectorVolMap[code] = bkVolData[bk];
        }
      });
    }
  } catch (e) {
    // 量比数据拉取失败不影响主流程
  }

  // 回退：东方财富指数
  if (!shComp && !szComp) {
    try {
      const fetchIdx = async (secid) => {
        try {
          const text = await httpGet(
            `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f58,f170`,
            { referer: 'https://quote.eastmoney.com/' }
          );
          const json = JSON.parse(text);
          if (json.rc === 0 && json.data) {
            return {
              name: json.data.f58,
              price: scalePrice(json.data.f43),
              change: (json.data.f170 || 0) / 100,
            };
          }
          return null;
        } catch (e) { return null; }
      };

      [shComp, szComp, cybComp] = await Promise.all([
        fetchIdx('1.000001'),
        fetchIdx('0.399001'),
        fetchIdx('0.399006'),
      ]);
    } catch (e) { /* fall through */ }
  }

  const idxParts = [];
  if (shComp) {
    const sign = shComp.change >= 0 ? '+' : '';
    const col  = shComp.change >= 0 ? COLORS.red : COLORS.green;
    idxParts.push(`${shComp.name}: ${shComp.price?.toFixed(2)} ${col}${sign}${shComp.change?.toFixed(2)}%${COLORS.reset}`);
  }
  if (szComp) {
    const sign = szComp.change >= 0 ? '+' : '';
    const col  = szComp.change >= 0 ? COLORS.red : COLORS.green;
    idxParts.push(`${szComp.name}: ${szComp.price?.toFixed(2)} ${col}${sign}${szComp.change?.toFixed(2)}%${COLORS.reset}`);
  }
  if (cybComp) {
    const sign = cybComp.change >= 0 ? '+' : '';
    const col  = cybComp.change >= 0 ? COLORS.red : COLORS.green;
    idxParts.push(`${cybComp.name}: ${cybComp.price?.toFixed(2)} ${col}${sign}${cybComp.change?.toFixed(2)}%${COLORS.reset}`);
  }
  if (idxParts.length > 0) {
    console.log(`  ${idxParts.join('  |  ')}`);
  } else {
    console.log(color(COLORS.dim, '  (大盘数据暂未获取，不影响基金层面分析)'));
  }

  // 养基宝收益快照
  if (yjbData?.summary) {
    const s = yjbData.summary;
    const incIcon = parseFloat(s.today_income) >= 0 ? '🔴' : '🟢';
    console.log(color(COLORS.cyan, `\n💰 养基宝收益: ${incIcon} 当日 ${s.today_income}  (${parseFloat(s.today_income_rate) >= 0 ? '+' : ''}${s.today_income_rate}%)  |  总资产 ¥${parseFloat(s.assets_collect || 0).toFixed(0)}`));
  }

  // 市场情绪
  let marketRisk = 'neutral';
  if (shComp && shComp.change < -2) marketRisk = 'panic';
  else if (shComp && shComp.change < -1) marketRisk = 'risk_off';
  else if (shComp && shComp.change > 1) marketRisk = 'risk_on';

  if (marketRisk === 'panic') {
    console.log(color(COLORS.red, '\n  ⚠️⚠️ 大盘暴跌！暂停所有加仓操作，优先执行止损/清仓！'));
  } else if (marketRisk === 'risk_off') {
    console.log(color(COLORS.yellow, '\n  ⚠️ 大盘走弱，加仓需格外谨慎，止损信号优先级提高。'));
  } else if (marketRisk === 'risk_on') {
    console.log(color(COLORS.red, '\n  🔥 大盘偏暖，可适当积极操作。'));
  }

  // ──────── 大盘环境（沪深300）→ 传入信号引擎做 Regime Filter ────
  const marketEnv = await getIndexChange('1.000300');

  // ──────── 逐只基金分析 ────────
  const fundResults = [];

  for (const code of fundCodes) {
    let profitLoss = CONFIG.profitLoss[code] || 0;        // 盈亏金额（元）
    let profitPct  = CONFIG.profitPct?.[code] || 0;       // 盈亏百分比（%）

    // 获取历史净值（90天，波动率要用足够样本）
    const history = await getFundHistoryNav(code, 90);
    await sleep(CONFIG.requestDelay);

    // ═══ 多数据源估值获取：养基宝 → 天天基金 → 新浪 → 指数估算 → 历史净值 ═══
    let fundVal = null;
    let valSource = '';

    // 数据源 0：养基宝真实账户（最优！实时估值 + 真实收益）
    const yjbFund = yjbFundMap[code];
    if (yjbFund && yjbFund.valuation > 0) {
      fundVal = {
        code,
        name: yjbFund.name,
        navDate: '',
        nav: yjbFund.nav,
        valuation: yjbFund.valuation,
        valuationChange: yjbFund.valuationChange,
        valuationTime: '养基宝实时',
        source: 'yjb',
      };
      valSource = 'yjb';
      // 用养基宝的真实收益数据覆盖
      profitLoss = yjbFund.profitAmount;
      profitPct = yjbFund.totalInvested > 0
        ? (yjbFund.profitAmount / yjbFund.totalInvested * 100)
        : 0;
      CONFIG.profitLoss[code] = profitLoss;
      CONFIG.profitPct[code] = profitPct;
    }

    // 数据源 1：天天基金实时估值
    if (!fundVal) {
      fundVal = await getFundValuation(code);
      if (fundVal) valSource = 'fundgz';
    }

    // 数据源 2：新浪财经基金 API
    if (!fundVal) {
      fundVal = await getFundValuationSina(code);
      if (fundVal) valSource = 'sina';
    }

    // 数据源 3：底层指数涨跌估算
    if (!fundVal && history.length > 0) {
      fundVal = await estimateFundFromIndex(code, history);
      if (fundVal) valSource = 'index';
    }

    if (!fundVal) {
      // 数据源 4：纯历史净值兜底
      if (history.length > 0) {
        const fallbackNav = history[0].nav;
        // 兜底也计算波动率信号
        const fbMaData = calcFundCompositeMA(history, fallbackNav);
        const fbSector = CONFIG.fundIndexMap?.[code]?.sector || '';
        const fbVol = calcVolatility(history, Math.min(history.length, 25));
        const fbPrices = history.map(d => d.nav).filter(n => n > 0);
        const fbSlope = calcMASlope(fbPrices, 20, 5);
        const fbTrend = fbSlope?.trend || 'flat';
        let fbBase = { stopLoss: -2.0, dipBuy: -1.5, takeProfit: 2.5 };
        if (fbSector.includes('QDII')) fbBase = { stopLoss: -2.5, dipBuy: -2.0, takeProfit: 2.0 };
        else if (fbSector.includes('黄金')) fbBase = { stopLoss: -1.5, dipBuy: -2.0, takeProfit: 2.5 };
        const fbDyn = dynamicThresholds(fbVol?.stddev || 0.008, trendAdjustedMultipliers(fbTrend, fbBase));
        const fbDev = fbMaData?.devMA20;
        const fbGold = fbSector.includes('黄金');
        let fbSig = 'neutral', fbLabel = '观望';
        if (fbGold && fbDev != null && fbDev < fbDyn.stopLoss && (fbMaData?.consecutiveBelowMA20 || 0) >= 3) { fbSig = 'stop_loss'; fbLabel = '止损'; }
        else if (fbGold && fbDev != null && fbDev < 0) { fbSig = 'watch'; fbLabel = '关注'; }
        else if (!fbGold && fbDev != null && fbDev < fbDyn.dipBuy) { fbSig = 'dip_buy'; fbLabel = '补仓机会'; }
        else if (profitPct >= 15 && fbDev != null && fbDev < 0) { fbSig = 'take_profit'; fbLabel = '止盈'; }
        else if (fbDev != null && fbDev > fbDyn.takeProfit && profitPct > 5) { fbSig = 'take_profit'; fbLabel = '止盈(过热)'; }
        else if (fbDev != null && fbDev > 0) { fbSig = 'hold'; fbLabel = '持有'; }

        fundResults.push({
          code, name: `基金${code}`, error: null,
          valuation: fallbackNav,
          valuationChange: history[0].change || 0,
          nav: fallbackNav,
          profitLoss, profitPct,
          maData: fbMaData,
          isFallback: true,
          valSource: 'history_nav',
          holdAmount: yjbFundMap[code]?.holdAmount || 0,
          algoSignal: fbSig, algoSignalLabel: fbLabel,
          change1w: history.length >= 5 ? ((history[0].nav - history[4].nav) / history[4].nav * 100) : null,
          change1m: history.length >= 20 ? ((history[0].nav - history[19].nav) / history[19].nav * 100) : null,
          recentNav5: history.slice(0, 5).map(d => ({ date: d.date, nav: d.nav, change: d.change })),
        });
        const strategyCfg = CONFIG.fundStrategy?.[code];
        const commands = generateIntradayCommands(
          { code, name: `基金${code}` },
          fbMaData,
          { code, name: `基金${code}`, nav: fallbackNav, valuation: fallbackNav, valuationChange: history[0].change || 0, navDate: history[0].date, valuationTime: '(历史净值)' },
          profitPct,
          history,
          strategyCfg,
          marketEnv
        );
        fundResults[fundResults.length - 1].commands = commands;
      } else {
        fundResults.push({ code, name: '--', error: '所有数据源均失败', profitLoss, profitPct, commands: [], maData: null, algoSignal: 'neutral', algoSignalLabel: '无数据' });
      }
      continue;
    }

    // 计算混合 MA
    const maData = calcFundCompositeMA(history, fundVal.valuation);

    // ─── 波动率动态信号（与 server.js 看板一致） ───
    const sector = CONFIG.fundIndexMap?.[code]?.sector || '';
    const prices = history.map(d => d.nav).filter(n => n > 0);
    const vol = calcVolatility(history, Math.min(history.length, 60));
    const fallbackVol = 0.008; // 日波动 0.8% 保守估计

    // 品种基础乘数
    let baseMultipliers = { stopLoss: -2.0, dipBuy: -1.5, takeProfit: 2.5 };
    if (sector.includes('美股') || sector.includes('QDII'))
      baseMultipliers = { stopLoss: -2.5, dipBuy: -2.0, takeProfit: 2.0 };
    else if (sector.includes('黄金'))
      baseMultipliers = { stopLoss: -1.5, dipBuy: -2.0, takeProfit: 2.5 };

    // 趋势调整
    const slopeData = calcMASlope(prices, 20, 5);
    const trend = slopeData?.trend || 'flat';
    const adjMultipliers = trendAdjustedMultipliers(trend, baseMultipliers);
    const dyn = dynamicThresholds(vol?.stddev || fallbackVol, adjMultipliers);

    // 信号判定（与 server.js 一致）
    const devMA20 = maData?.devMA20;
    const devMA5  = maData?.devMA5;
    const consec  = maData?.consecutiveBelowMA20 || countDaysBelowMA(history.slice(-30), maData?.ma20);
    const isGold  = sector.includes('黄金');
    let volSignal = 'neutral', volSignalLabel = '观望';
    if (isGold && devMA20 != null && devMA20 < dyn.stopLoss && consec >= 3) {
      volSignal = 'stop_loss'; volSignalLabel = '止损';
    } else if (isGold && devMA20 != null && devMA20 < 0 && consec >= 1) {
      volSignal = 'watch'; volSignalLabel = '关注';
    } else if (!isGold && devMA20 != null && devMA20 < dyn.dipBuy) {
      volSignal = 'dip_buy'; volSignalLabel = '补仓机会';
    } else if (profitPct >= 15 && devMA20 != null && devMA20 < 0) {
      volSignal = 'take_profit'; volSignalLabel = '止盈';
    } else if (devMA20 != null && devMA20 > dyn.takeProfit && profitPct > 5) {
      volSignal = 'take_profit'; volSignalLabel = '止盈(过热)';
    } else if (profitPct >= 30) {
      volSignal = 'take_profit'; volSignalLabel = '止盈';
    } else if (devMA20 != null && devMA20 > 0 && devMA5 != null && devMA5 > 0) {
      volSignal = 'hold'; volSignalLabel = '持有';
    } else if (devMA20 != null && devMA20 < dyn.stopLoss * 2) {
      volSignal = isGold ? 'stop_loss' : 'dip_buy';
      volSignalLabel = isGold ? '止损' : '补仓机会';
    }

    // 生成操作指令（保持旧逻辑用于详细建议文本）
    const strategyCfg = CONFIG.fundStrategy?.[code];
    const commands = generateIntradayCommands(
      { code, name: fundVal.name },
      maData,
      fundVal,
      profitPct,
      history,
      strategyCfg,
      marketEnv
    );

    fundResults.push({
      code,
      name: fundVal.name,
      valuation: fundVal.valuation,
      valuationChange: fundVal.valuationChange,
      nav: fundVal.nav,
      maData,
      profitLoss,
      profitPct,
      commands,
      valSource,
      // 养基宝真实持仓金额
      holdAmount: yjbFundMap[code]?.holdAmount || 0,
      // 波动率信号（与看板一致，喂给 AI 做 DISPUTE 对比）
      algoSignal: volSignal,
      algoSignalLabel: volSignalLabel,
      trend,
      volatility: dyn.dailyVolatility,
      // 近期走势（让AI看到价格轨迹）
      change1w: history.length >= 5 ? ((history[0].nav - history[4].nav) / history[4].nav * 100) : null,
      change1m: history.length >= 20 ? ((history[0].nav - history[19].nav) / history[19].nav * 100) : null,
      recentNav5: history.slice(0, 5).map(d => ({ date: d.date, nav: d.nav, change: d.change })),
    });
  }

  // ── 注入板块量比数据 ──
  for (const f of fundResults) {
    f.sectorVol = sectorVolMap[f.code] || null;
  }

  // ── 用最终命令覆盖算法信号标签（确保 AI 看到的信号与展示一致）──
  for (const f of fundResults) {
    if (f.commands && f.commands.length > 0) {
      const top = f.commands[0];
      if (top.type === 'hold_dip_strong') {
        f.algoSignal = 'hold_dip_strong';
        f.algoSignalLabel = '强势持有';
      } else if (top.type === 'buy_pullback' || top.type === 'buy_ma10') {
        f.algoSignalLabel = '买入';
      } else if (top.type === 'stop_loss') {
        f.algoSignalLabel = '止损';
      } else if (top.type === 'avoid') {
        f.algoSignalLabel = '观望';
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 输出：分类操作指令
  // ═══════════════════════════════════════════════════════════

  // 收集所有指令
  const allCommands = fundResults.flatMap(f => f.commands);

  const stopLossCmds       = allCommands.filter(c => c.type === 'stop_loss');
  const protectiveProfitCmds = allCommands.filter(c => c.type === 'protective_profit');
  const breakCmds          = allCommands.filter(c => c.type === 'first_break');
  const holdDipCmds        = allCommands.filter(c => c.type === 'hold_through_dip' || c.type === 'hold_dip_strong');
  const dipBuyCmds         = allCommands.filter(c => c.type?.startsWith('dip_buy'));
  const buyCmds            = allCommands.filter(c => c.type === 'buy_pullback' || c.type === 'buy_ma10');
  const profitCmds         = allCommands.filter(c => c.type === 'take_profit' || c.type === 'partial_profit');
  const holdBullCmds  = allCommands.filter(c => c.type === 'hold_bullish');
  const avoidCmds     = allCommands.filter(c => c.type === 'avoid');

  // ──── 第一优先级：止损/清仓 ────
  if (stopLossCmds.length > 0) {
    console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
    console.log(color(COLORS.red, '🚨 清仓 / 止损指令 — 请在 15:00 前执行！'));
    console.log(color(COLORS.bold, '━'.repeat(66)));

    for (const cmd of stopLossCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      console.log(color(COLORS.red, `\n  ❌ ${f.name} (${f.code})`));
      console.log(`     估值: ${f.valuation?.toFixed(4)}  |  净值: ${f.nav}  |  盈亏: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData?.ma20) {
        console.log(`     MA20: ${f.maData.ma20.toFixed(4)}  |  偏离: ${f.maData.devMA20?.toFixed(2)}%  |  均线: ${f.maData.alignment}`);
      }
      console.log(color(COLORS.red, `     → ${cmd.instruction}`));
    }
  }

  // ──── 1.5：保护性止盈（盈利≥30% + 首次破位）────
  if (protectiveProfitCmds.length > 0) {
    console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
    console.log(color(COLORS.yellow, '🟠 保护性止盈 — 高位回撤，请在 15:00 前执行！'));
    console.log(color(COLORS.bold, '━'.repeat(66)));

    for (const cmd of protectiveProfitCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      console.log(color(COLORS.yellow, `\n  💰 ${f.name} (${f.code})`));
      console.log(`     估值: ${f.valuation?.toFixed(4)}  |  净值: ${f.nav}  |  盈利: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData?.ma20) {
        console.log(`     MA20: ${f.maData.ma20.toFixed(4)}  |  偏离: ${f.maData.devMA20?.toFixed(2)}%  |  均线: ${f.maData.alignment}`);
      }
      console.log(color(COLORS.yellow, `     → ${cmd.instruction}`));
    }
  }

  // ──── 2：首次破位观察 ────
  if (breakCmds.length > 0) {
    console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
    console.log(color(COLORS.yellow, '🟡 首次破位观察 — 尾盘确认是否收复 MA20'));
    console.log(color(COLORS.bold, '━'.repeat(66)));

    for (const cmd of breakCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      console.log(color(COLORS.yellow, `\n  ⚠️ ${f.name} (${f.code})`));
      console.log(`     估值: ${f.valuation?.toFixed(4)}  |  净值: ${f.nav}  |  盈亏: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData?.ma20) {
        console.log(`     MA20: ${f.maData.ma20.toFixed(4)}  |  偏离: ${f.maData.devMA20?.toFixed(2)}%`);
      }
      console.log(color(COLORS.yellow, `     → ${cmd.instruction}`));
    }
  }

  // ──── hold_dip 类基金的持仓建议 ────
  if (holdDipCmds.length > 0) {
    const strongCmds = holdDipCmds.filter(c => c.type === 'hold_dip_strong');
    const dipCmds    = holdDipCmds.filter(c => c.type === 'hold_through_dip');

    if (strongCmds.length > 0) {
      console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
      console.log(color(COLORS.green, '🟢 强势持有信号 — 趋势健康，让利润奔跑'));
      console.log(color(COLORS.bold, '━'.repeat(66)));
      for (const cmd of strongCmds) {
        const f = fundResults.find(r => r.commands.includes(cmd));
        if (!f) continue;
        console.log(color(COLORS.green, `\n  🚀 ${f.name} (${f.code})`));
        console.log(`     估值: ${f.valuation?.toFixed(4)}  |  盈利: ${formatProfit(f.profitLoss, f.profitPct)}`);
        if (f.maData?.alignment) console.log(`     均线: ${f.maData.alignment}  |  偏离MA20: ${f.maData.devMA20?.toFixed(2)}%`);
        console.log(color(COLORS.green, `     → ${cmd.instruction}`));
      }
    }

    if (dipCmds.length > 0) {
      console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
      console.log(color(COLORS.cyan, '💪 坚持持有信号 — 回测显示此类基金止损不如持有'));
      console.log(color(COLORS.bold, '━'.repeat(66)));
      for (const cmd of dipCmds) {
        const f = fundResults.find(r => r.commands.includes(cmd));
        if (!f) continue;
        console.log(color(COLORS.cyan, `\n  📌 ${f.name} (${f.code})`));
        console.log(`     估值: ${f.valuation?.toFixed(4)}  |  盈亏: ${formatProfit(f.profitLoss, f.profitPct)}`);
        console.log(color(COLORS.cyan, `     → ${cmd.instruction}`));
      }
    }
  }

  // ──── 补仓信号 ────
  if (dipBuyCmds.length > 0) {
    console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
    console.log(color(COLORS.green, '🟢 补仓 / 抄底信号 — 回撤够深+企稳，可分批入场'));
    console.log(color(COLORS.bold, '━'.repeat(66)));

    for (const cmd of dipBuyCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      console.log(color(COLORS.green, `\n  💸 ${f.name} (${f.code})`));
      console.log(`     估值: ${f.valuation?.toFixed(4)}  |  日变动: ${formatPercent(f.valuationChange)}  |  盈亏: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData) {
        const md = f.maData;
        console.log(`     MA5: ${md.ma5?.toFixed(4)}  |  MA10: ${md.ma10?.toFixed(4)}  |  MA20: ${md.ma20?.toFixed(4)}`);
      }
      console.log(color(COLORS.green, `     → ${cmd.instruction}`));
    }
  }

  // ──── 第二优先级：买入/加仓 ────
  if (buyCmds.length > 0) {
    console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
    console.log(color(COLORS.green, '🟢 买入 / 加仓指令 — 请在 15:00 前下单！'));
    console.log(color(COLORS.bold, '━'.repeat(66)));

    for (const cmd of buyCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      console.log(color(COLORS.green, `\n  ✅ ${f.name} (${f.code})`));
      console.log(`     估值: ${f.valuation?.toFixed(4)}  |  日变动: ${formatPercent(f.valuationChange)}  |  盈亏: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData) {
        const md = f.maData;
        console.log(`     MA5: ${md.ma5?.toFixed(4)}  |  MA10: ${md.ma10?.toFixed(4)}  |  MA20: ${md.ma20?.toFixed(4)}`);
        console.log(`     排列: ${md.alignment}  |  偏离MA20: ${md.devMA20?.toFixed(2)}%`);
      }
      console.log(color(COLORS.green, `     → ${cmd.instruction}`));
    }

    // 大盘暴跌时覆盖
    if (marketRisk === 'panic') {
      console.log(color(COLORS.red, '\n  ⚠️⚠️ 大盘暴跌中！以上买入指令建议暂缓，等市场企稳后再执行！'));
    }
  }

  // ──── 第三优先级：止盈 ────
  if (profitCmds.length > 0) {
    console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
    console.log(color(COLORS.yellow, '🟡 止盈提醒'));
    console.log(color(COLORS.bold, '━'.repeat(66)));

    for (const cmd of profitCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      console.log(color(COLORS.yellow, `\n  💰 ${f.name} (${f.code})`));
      console.log(`     估值: ${f.valuation?.toFixed(4)}  |  日变动: ${formatPercent(f.valuationChange)}  |  盈利: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData?.alignment) {
        console.log(`     均线: ${f.maData.alignment}`);
      }
      console.log(color(COLORS.yellow, `     → ${cmd.instruction}`));
    }
  }

  // ──── 全量持仓状态速览表 ────
  console.log(color(COLORS.bold, '\n' + '━'.repeat(66)));
  console.log(color(COLORS.cyan, '📋 全部持仓状态速览'));
  console.log(color(COLORS.bold, '━'.repeat(66)));

  console.log(`\n  ${'基金简称'.padEnd(20)} ${'估值'.padEnd(10)} ${'日变'.padEnd(10)} ${'vsMA20'.padEnd(10)} ${'均线排列'.padEnd(14)} ${'量比'.padEnd(8)} ${'操作'}`);
  console.log(`  ${'─'.repeat(85)}`);

  for (const f of fundResults) {
    if (f.error) {
      console.log(`  ${f.code.padEnd(20)} ${color(COLORS.dim, f.error)}`);
      continue;
    }

    if (f.isFallback) {
      // 使用历史净值代替实时估值的基金
      const name = (f.name || '').length > 17 ? (f.name || '').substring(0, 16) + '…' : (f.name || '');
      const vChgCol = f.valuationChange >= 0 ? COLORS.red : COLORS.green;
      const vSign = f.valuationChange >= 0 ? '+' : '';
      const dev20Str = f.maData?.devMA20 != null ? `${f.maData.devMA20 >= 0 ? '+' : ''}${f.maData.devMA20.toFixed(1)}%` : '--';
      const dev20Col = f.maData?.devMA20 != null ? (f.maData.devMA20 > 0 ? COLORS.red : COLORS.green) : COLORS.reset;

      let alignmentStr = '--';
      if (f.maData?.alignment === 'bullish_aligned')  alignmentStr = color(COLORS.red, '多头↑↑↑');
      else if (f.maData?.alignment === 'bearish_aligned') alignmentStr = color(COLORS.green, '空头↓↓↓');
      else if (f.maData?.alignment === 'short_bullish')   alignmentStr = color(COLORS.yellow, '短多 ↑');
      else if (f.maData?.alignment === 'short_bearish')   alignmentStr = color(COLORS.yellow, '短空 ↓');

      const topCmd = f.commands[0];
      let actionStr = '';
      if (topCmd) {
        if (topCmd.type === 'stop_loss') actionStr = color(COLORS.red, '🔴 止损');
        else if (topCmd.type === 'protective_profit') actionStr = color(COLORS.yellow, '🟠 保护止盈');
        else if (topCmd.type === 'first_break') actionStr = color(COLORS.yellow, '🟡 观察');
        else if (topCmd.type === 'buy_pullback' || topCmd.type === 'buy_ma10') actionStr = color(COLORS.green, '🟢 买入');
        else if (topCmd.type?.startsWith('dip_buy')) actionStr = color(COLORS.green, '🟢 补仓');
        else if (topCmd.type === 'hold_through_dip') actionStr = color(COLORS.cyan, '💪 持有');
        else if (topCmd.type === 'hold_dip_strong') actionStr = color(COLORS.green, '🟢 强势持有');
        else if (topCmd.type === 'take_profit') actionStr = color(COLORS.yellow, '🟡 止盈');
        else if (topCmd.type === 'partial_profit') actionStr = color(COLORS.yellow, '🟡 部分止盈');
        else if (topCmd.type === 'hold_bullish') actionStr = color(COLORS.cyan, '🟢 持有');
        else if (topCmd.type === 'avoid') actionStr = color(COLORS.red, '🔴 观望');
        else if (topCmd.type?.startsWith('neutral')) actionStr = color(COLORS.yellow, '⚪ 观望');
        else actionStr = '--';
      } else {
        actionStr = color(COLORS.yellow, '⚪ 中性');
      }

      let volOut = '  --  ';
      if (f.sectorVol) {
        const vr = f.sectorVol.volumeRatio;
        const vCol = vr >= 1.2 ? COLORS.red : vr <= 0.8 ? COLORS.green : COLORS.reset;
        const arrow = vr >= 1.2 ? '↑' : vr <= 0.8 ? '↓' : ' ';
        volOut = ` ${vCol}${arrow}${vr.toFixed(2)}${COLORS.reset} `;
      }

      console.log(
        `  ${name.padEnd(18)} ` +
        `${(f.valuation?.toFixed(4) || '--').padEnd(10)} ` +
        `${vChgCol}${vSign}${(f.valuationChange?.toFixed(2) || '--')}%${COLORS.reset}   ` +
        `${dev20Col}${dev20Str.padEnd(10)}${COLORS.reset} ` +
        `${alignmentStr.padEnd(14)} ` +
        `${volOut}` +
        `${actionStr}` +
        ` ${color(COLORS.dim, f.valSource === 'index' ? '(指数估算)' : '(历史净值)')}`
      );
      continue;
    }

    const name = f.name.length > 17 ? f.name.substring(0, 16) + '…' : f.name;
    const vChgCol = f.valuationChange >= 0 ? COLORS.red : COLORS.green;
    const vSign   = f.valuationChange >= 0 ? '+' : '';

    const dev20Str = f.maData?.devMA20 != null ? `${f.maData.devMA20 >= 0 ? '+' : ''}${f.maData.devMA20.toFixed(1)}%` : '--';
    const dev20Col = f.maData?.devMA20 != null
      ? (f.maData.devMA20 > 0 ? COLORS.red : COLORS.green)
      : COLORS.reset;

    let alignmentStr = '--';
    if (f.maData?.alignment === 'bullish_aligned')  alignmentStr = color(COLORS.red,   '多头↑↑↑');
    else if (f.maData?.alignment === 'bearish_aligned') alignmentStr = color(COLORS.green, '空头↓↓↓');
    else if (f.maData?.alignment === 'short_bullish')   alignmentStr = color(COLORS.yellow,'短多 ↑');
    else if (f.maData?.alignment === 'short_bearish')   alignmentStr = color(COLORS.yellow,'短空 ↓');

    const topCmd = f.commands[0];
    let actionStr = '';
    if (topCmd) {
      if (topCmd.type === 'stop_loss')                              actionStr = color(COLORS.red,   '🔴 止损');
      else if (topCmd.type === 'protective_profit')                 actionStr = color(COLORS.yellow,'🟠 保护止盈');
      else if (topCmd.type === 'first_break')                       actionStr = color(COLORS.yellow,'🟡 观察');
      else if (topCmd.type === 'buy_pullback' || topCmd.type === 'buy_ma10') actionStr = color(COLORS.green, '🟢 买入');
        else if (topCmd.type?.startsWith('dip_buy')) actionStr = color(COLORS.green, '🟢 补仓');
        else if (topCmd.type === 'hold_through_dip') actionStr = color(COLORS.cyan, '💪 持有');
        else if (topCmd.type === 'hold_dip_strong') actionStr = color(COLORS.green, '🟢 强势持有');
      else if (topCmd.type === 'take_profit')                       actionStr = color(COLORS.yellow,'🟡 止盈');
      else if (topCmd.type === 'partial_profit')                    actionStr = color(COLORS.yellow,'🟡 部分止盈');
      else if (topCmd.type === 'hold_bullish')                      actionStr = color(COLORS.cyan,  '🟢 持有');
      else if (topCmd.type === 'avoid')                             actionStr = color(COLORS.red,   '🔴 观望');
      else if (topCmd.type?.startsWith('neutral'))                  actionStr = color(COLORS.yellow,'⚪ 观望');
      else actionStr = '--';
    } else {
      actionStr = color(COLORS.yellow, '⚪ 中性');
    }

    const srcTag = f.valSource === 'yjb' ? color(COLORS.cyan, ' [养基宝]') :
                   f.valSource === 'sina' ? color(COLORS.dim, ' [新浪]') :
                   f.valSource === 'index' ? color(COLORS.dim, ' [指数估算]') : '';

    // 板块量比
    let volOut = '  --  ';
    if (f.sectorVol) {
      const vr = f.sectorVol.volumeRatio;
      const vCol = vr >= 1.2 ? COLORS.red : vr <= 0.8 ? COLORS.green : COLORS.reset;
      const arrow = vr >= 1.2 ? '↑' : vr <= 0.8 ? '↓' : ' ';
      volOut = ` ${vCol}${arrow}${vr.toFixed(2)}${COLORS.reset} `;
    }

    console.log(
      `  ${name.padEnd(18)} ` +
      `${(f.valuation?.toFixed(4) || '--').padEnd(10)} ` +
      `${vChgCol}${vSign}${(f.valuationChange?.toFixed(2) || '--')}%${COLORS.reset}   ` +
      `${dev20Col}${dev20Str.padEnd(10)}${COLORS.reset} ` +
      `${alignmentStr.padEnd(14)} ` +
      `${volOut}` +
      `${actionStr}${srcTag}`
    );
  }

  // ──── 总结 ────
  const summaryParts = [];
  if (stopLossCmds.length > 0)        summaryParts.push(color(COLORS.red, `${stopLossCmds.length} 只需立即止损`));
  if (protectiveProfitCmds.length > 0) summaryParts.push(color(COLORS.yellow, `${protectiveProfitCmds.length} 只需保护性止盈`));
  if (breakCmds.length > 0)           summaryParts.push(color(COLORS.yellow, `${breakCmds.length} 只首次破位需观察`));
  if (dipBuyCmds.length > 0)          summaryParts.push(color(COLORS.green, `${dipBuyCmds.length} 只可补仓`));
  if (buyCmds.length > 0)             summaryParts.push(color(COLORS.green, `${buyCmds.length} 只可买入`));
  if (profitCmds.length > 0)          summaryParts.push(color(COLORS.yellow, `${profitCmds.length} 只可止盈`));
  if (holdBullCmds.length > 0)        summaryParts.push(color(COLORS.cyan, `${holdBullCmds.length} 只继续持有`));

  if (summaryParts.length > 0) {
    console.log(color(COLORS.bold, '\n📌 总结: ') + summaryParts.join(' | '));
  }

  console.log(color(COLORS.bold, '\n' + '═'.repeat(66)));
  console.log(color(COLORS.dim, '⚠️ 免责声明：以上为 AI 量化的数据参考，不构成投资建议。'));
  console.log(color(COLORS.dim, '   投资有风险，买卖需谨慎。请根据自身情况独立决策。'));
  console.log(color(COLORS.bold, '═'.repeat(66) + '\n'));

  // 构建纯文本报告（供邮件使用）
  const reportText = buildActionReportText(
    fundResults, { shComp, szComp, cybComp, marketRisk },
    { stopLossCmds, protectiveProfitCmds, breakCmds, buyCmds, profitCmds, holdBullCmds, avoidCmds }
  );

  return { fundResults, stopLossCmds, buyCmds, profitCmds, marketRisk, reportText,
    marketIndices: { shComp, szComp, cybComp },
  };
}

// ============================================================
// 邮件报告生成 & 推送
// ============================================================

/** 去除 ANSI 转义码 */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 根据 runActionMode 的结构化结果构建纯文本报告
 * 这份文本会同时用于控制台回显（已打印）和邮件 HTML 转换
 */
function buildActionReportText(fundResults, marketData, cmdGroups) {
  const lines = [];
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  lines.push('══════════════════════════════════════════');
  lines.push('  🔴 养基日记 · 今日盘中即时操作指令');
  lines.push(`  ⏰ ${timeStr}  |  所有操作请在 15:00 前完成`);
  lines.push('══════════════════════════════════════════');
  lines.push('');

  // 大盘快照
  lines.push('📊 大盘快照');
  const { shComp, szComp, cybComp, marketRisk } = marketData;
  const idxParts = [];
  if (shComp) {
    const sign = shComp.change >= 0 ? '+' : '';
    idxParts.push(`${shComp.name}: ${shComp.price?.toFixed(2)} ${sign}${shComp.change?.toFixed(2)}%`);
  }
  if (szComp) {
    const sign = szComp.change >= 0 ? '+' : '';
    idxParts.push(`${szComp.name}: ${szComp.price?.toFixed(2)} ${sign}${szComp.change?.toFixed(2)}%`);
  }
  if (cybComp) {
    const sign = cybComp.change >= 0 ? '+' : '';
    idxParts.push(`${cybComp.name}: ${cybComp.price?.toFixed(2)} ${sign}${cybComp.change?.toFixed(2)}%`);
  }
  if (idxParts.length > 0) {
    lines.push(`  ${idxParts.join('  |  ')}`);
  } else {
    lines.push('  (大盘数据暂未获取)');
  }

  if (marketRisk === 'panic') {
    lines.push('');
    lines.push('  ⚠️⚠️ 大盘暴跌！暂停所有加仓操作，优先执行止损/清仓！');
  } else if (marketRisk === 'risk_off') {
    lines.push('');
    lines.push('  ⚠️ 大盘走弱，加仓需格外谨慎，止损信号优先级提高。');
  } else if (marketRisk === 'risk_on') {
    lines.push('');
    lines.push('  🔥 大盘偏暖，可适当积极操作。');
  }
  lines.push('');

  const { stopLossCmds, protectiveProfitCmds, breakCmds, buyCmds, profitCmds, holdBullCmds, avoidCmds } = cmdGroups;

  // ──── 止损指令 ────
  if (stopLossCmds.length > 0) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🚨 清仓 / 止损指令 — 请在 15:00 前执行！');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const cmd of stopLossCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      lines.push('');
      lines.push(`  ❌ ${f.name} (${f.code})`);
      lines.push(`     估值: ${f.valuation?.toFixed(4)}  |  净值: ${f.nav}  |  盈亏: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData?.ma20) {
        lines.push(`     MA20: ${f.maData.ma20.toFixed(4)}  |  偏离: ${f.maData.devMA20?.toFixed(2)}%  |  均线: ${f.maData.alignment}`);
      }
      lines.push(`     → ${cmd.instruction}`);
    }
    lines.push('');
  }

  // ──── 保护性止盈 ────
  if (protectiveProfitCmds.length > 0) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🟠 保护性止盈 — 高位回撤，请在 15:00 前执行！');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const cmd of protectiveProfitCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      lines.push('');
      lines.push(`  💰 ${f.name} (${f.code})`);
      lines.push(`     估值: ${f.valuation?.toFixed(4)}  |  净值: ${f.nav}  |  盈利: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData?.ma20) {
        lines.push(`     MA20: ${f.maData.ma20.toFixed(4)}  |  偏离: ${f.maData.devMA20?.toFixed(2)}%  |  均线: ${f.maData.alignment}`);
      }
      lines.push(`     → ${cmd.instruction}`);
    }
    lines.push('');
  }

  // ──── 首次破位 ────
  if (breakCmds.length > 0) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🟡 首次破位观察 — 尾盘确认是否收复 MA20');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const cmd of breakCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      lines.push('');
      lines.push(`  ⚠️ ${f.name} (${f.code})`);
      lines.push(`     估值: ${f.valuation?.toFixed(4)}  |  净值: ${f.nav}  |  盈亏: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData?.ma20) {
        lines.push(`     MA20: ${f.maData.ma20.toFixed(4)}  |  偏离: ${f.maData.devMA20?.toFixed(2)}%`);
      }
      lines.push(`     → ${cmd.instruction}`);
    }
    lines.push('');
  }

  // ──── 买入指令 ────
  if (buyCmds.length > 0) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🟢 买入 / 加仓指令 — 请在 15:00 前下单！');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const cmd of buyCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      lines.push('');
      lines.push(`  ✅ ${f.name} (${f.code})`);
      lines.push(`     估值: ${f.valuation?.toFixed(4)}  |  日变动: ${f.valuationChange >= 0 ? '+' : ''}${f.valuationChange?.toFixed(2)}%  |  盈亏: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData) {
        lines.push(`     MA5: ${f.maData.ma5?.toFixed(4)}  |  MA10: ${f.maData.ma10?.toFixed(4)}  |  MA20: ${f.maData.ma20?.toFixed(4)}`);
        lines.push(`     排列: ${f.maData.alignment}  |  偏离MA20: ${f.maData.devMA20?.toFixed(2)}%`);
      }
      lines.push(`     → ${cmd.instruction}`);
    }
    if (marketRisk === 'panic') {
      lines.push('');
      lines.push('  ⚠️⚠️ 大盘暴跌中！以上买入指令建议暂缓，等市场企稳后再执行！');
    }
    lines.push('');
  }

  // ──── 止盈 ────
  if (profitCmds.length > 0) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🟡 止盈提醒');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const cmd of profitCmds) {
      const f = fundResults.find(r => r.commands.includes(cmd));
      if (!f) continue;
      lines.push('');
      lines.push(`  💰 ${f.name} (${f.code})`);
      lines.push(`     估值: ${f.valuation?.toFixed(4)}  |  日变动: ${f.valuationChange >= 0 ? '+' : ''}${f.valuationChange?.toFixed(2)}%  |  盈利: ${formatProfit(f.profitLoss, f.profitPct)}`);
      if (f.maData?.alignment) {
        lines.push(`     均线: ${f.maData.alignment}`);
      }
      lines.push(`     → ${cmd.instruction}`);
    }
    lines.push('');
  }

  // ──── 全量持仓状态速览表 ────
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('📋 全部持仓状态速览');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push(`  基金简称             估值       日变       vsMA20     均线排列       操作`);
  lines.push(`  ─────────────────────────────────────────────────────────────`);
  for (const f of fundResults) {
    if (f.error) {
      lines.push(`  ${f.code.padEnd(20)} ${f.error}`);
      continue;
    }
    const name = (f.name || '').length > 17 ? (f.name || '').substring(0, 16) + '…' : (f.name || '');
    const vSign = f.valuationChange >= 0 ? '+' : '';
    const dev20Str = f.maData?.devMA20 != null ? `${f.maData.devMA20 >= 0 ? '+' : ''}${f.maData.devMA20.toFixed(1)}%` : '--';

    let alignmentStr = '--';
    if (f.maData?.alignment === 'bullish_aligned')  alignmentStr = '多头↑↑↑';
    else if (f.maData?.alignment === 'bearish_aligned') alignmentStr = '空头↓↓↓';
    else if (f.maData?.alignment === 'short_bullish')   alignmentStr = '短多 ↑';
    else if (f.maData?.alignment === 'short_bearish')   alignmentStr = '短空 ↓';

    const topCmd = f.commands[0];
    let actionStr = '--';
    if (topCmd) {
      if (topCmd.type === 'stop_loss') actionStr = '🔴 止损';
      else if (topCmd.type === 'protective_profit') actionStr = '🟠 保护止盈';
      else if (topCmd.type === 'first_break') actionStr = '🟡 观察';
      else if (topCmd.type === 'buy_pullback' || topCmd.type === 'buy_ma10') actionStr = '🟢 买入';
      else if (topCmd.type === 'take_profit') actionStr = '🟡 止盈';
      else if (topCmd.type === 'partial_profit') actionStr = '🟡 部分止盈';
      else if (topCmd.type === 'hold_bullish') actionStr = '🟢 持有';
      else if (topCmd.type === 'avoid') actionStr = '🔴 观望';
      else if (topCmd.type?.startsWith('neutral')) actionStr = '⚪ 观望';
    } else {
      actionStr = '⚪ 中性';
    }

    const fallbackTag = f.isFallback ? ' (历史净值)' : '';
    lines.push(
      `  ${name.padEnd(18)} ` +
      `${(f.valuation?.toFixed(4) || '--').padEnd(10)} ` +
      `${vSign}${(f.valuationChange?.toFixed(2) || '--')}%   ` +
      `${dev20Str.padEnd(10)} ` +
      `${alignmentStr.padEnd(14)} ` +
      `${actionStr}${fallbackTag}`
    );
  }
  lines.push('');

  // 总结
  const summaryParts = [];
  if (stopLossCmds.length > 0)        summaryParts.push(`${stopLossCmds.length} 只需立即止损`);
  if (protectiveProfitCmds.length > 0) summaryParts.push(`${protectiveProfitCmds.length} 只需保护性止盈`);
  if (breakCmds.length > 0)           summaryParts.push(`${breakCmds.length} 只首次破位需观察`);
  if (buyCmds.length > 0)             summaryParts.push(`${buyCmds.length} 只可买入`);
  if (profitCmds.length > 0)          summaryParts.push(`${profitCmds.length} 只可止盈`);
  if (holdBullCmds.length > 0)        summaryParts.push(`${holdBullCmds.length} 只继续持有`);

  if (summaryParts.length > 0) {
    lines.push(`📌 总结: ${summaryParts.join(' | ')}`);
    lines.push('');
  }

  lines.push('══════════════════════════════════════════');
  lines.push('⚠️ 免责声明：以上为 AI 量化的数据参考，不构成投资建议。');
  lines.push('   投资有风险，买卖需谨慎。请根据自身情况独立决策。');
  lines.push('══════════════════════════════════════════');

  return lines.join('\n');
}

// EMAIL_CSS / escHtml / textToEmailHtml / renderMarketBlock / renderActionBlock /
// renderHoldingsBlock / renderSummaryBlock / renderTextBlock / parseDisputes /
// stripDisputeMarkers / sendEmailNotification → lib/email-render.js + lib/email-service.js

// ============================================================
// 主入口
// ============================================================
// ============================================================

// ═══════════════════════════════════════════════════════════
// 对话模式 — runAskMode
// ═══════════════════════════════════════════════════════════
async function runAskMode(question, holdingsData, CONFIG) {
  const { chat } = require('./llm.js');
  const { getPortfolioNews } = require('./news.js');

  console.log(color(COLORS.bold, '\n💬 养基日记 · 投资助理'));
  console.log(color(COLORS.dim, `  ⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`));
  console.log(color(COLORS.cyan, '\n🤔 你的问题:'), question);

  // ─── 加载打分数据 ───
  console.log(color(COLORS.dim, '\n📊 正在加载持仓数据...'));
  const holdings = holdingsData?.holdings || [];
  const profitMap = holdingsData?.profitPct || {};

  // 快速打分（仅趋势+动量，不拉全量实时数据）
  const { scoreAllFunds } = require('../fund-scoring.js');
  let scores = [];
  try {
    const data = await scoreAllFunds(holdings, { simple: true });
    scores = data.results || [];
  } catch (e) {
    // 打分失败不阻塞对话
  }

  // 构建持仓摘要（原始数据，不给 AI 预设策略标签）
  // 尝试拉养基宝实时估值
  let yjbMap = {};
  try {
    const yjbData = await Promise.race([
      fetchYjbData().catch(() => null),
      new Promise(r => setTimeout(() => r(null), 6000)),
    ]);
    const yjbH = yjbData?.holdings ? yjbApi.normalizeHoldings(yjbData.holdings) : [];
    yjbH.forEach(h => { yjbMap[h.code] = h; });
  } catch (e) { /* 非阻塞 */ }

  // 并行计算每只基金的MA20
  const { calcMA, countDaysBelowMA } = require('./analytics.js');
  const { httpGet: libHttpGet } = require('./utils.js');
  const maResults = await Promise.all(holdings.map(async h => {
    try {
      const pages = Math.ceil(30 / 20);
      const allNav = [];
      for (let p = 1; p <= pages; p++) {
        const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=cb&fundCode=${h.code}&pageIndex=${p}&pageSize=20`;
        const text = await libHttpGet(url, { silent: true, timeout: 8000 });
        if (!text) break;
        const m = text.match(/cb\((.*)\)/);
        if (!m) break;
        const json = JSON.parse(m[1]);
        if (!json?.Data?.LSJZList?.length) break;
        allNav.push(...json.Data.LSJZList);
      }
      const prices = allNav.map(d => parseFloat(d.DWJZ)).filter(n => n > 0);
      const ma20 = calcMA(prices.slice(-20), 20);
      return { code: h.code, ma20, prices };
    } catch (e) { return { code: h.code, ma20: null, prices: [] }; }
  }));
  const maMap = {};
  maResults.forEach(r => { maMap[r.code] = r; });

  const holdingsBrief = holdings.map(h => {
    const yjb = yjbMap[h.code] || {};
    const ma = maMap[h.code] || {};
    const val = yjb.valuation || h.nav || 0;
    const dev = ma.ma20 ? ((val - ma.ma20) / ma.ma20 * 100) : null;
    return {
      基金: `${h.shortName || h.name} (${h.code})`,
      板块: h.sector,
      估值: val > 0 ? val.toFixed(4) : '--',
      净值: (yjb.nav || h.nav || 0).toFixed(4),
      日变动: yjb.valuationChange != null ? `${yjb.valuationChange >= 0 ? '+' : ''}${yjb.valuationChange.toFixed(2)}%` : '?',
      MA20: ma.ma20 ? ma.ma20.toFixed(4) : '--',
      vsMA20偏离: dev != null ? `${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%` : '--',
      持仓盈亏: yjb.profitAmount != null ? `¥${yjb.profitAmount.toFixed(0)}` : (h.profit != null ? `¥${h.profit.toFixed(0)}` : '?'),
      收益率: h.totalInvested > 0 ? `${h.profit >= 0 ? '+' : ''}${(h.profit / h.totalInvested * 100).toFixed(1)}%` : '?',
      持有金额: yjb.holdAmount || h.holdAmount || 0,
    };
  });

  // ─── 拉取实时资讯 ───
  console.log(color(COLORS.dim, '📡 正在拉取实时金融资讯...'));
  let newsDigest = '';
  try {
    newsDigest = await getPortfolioNews(holdingsBrief, 3);
  } catch (e) {
    // 新闻拉取失败不阻塞对话
  }
  if (newsDigest) {
    console.log(color(COLORS.dim, `  已获取 ${newsDigest.split('\n').length} 条相关资讯`));
  } else {
    console.log(color(COLORS.dim, '  (未获取到新闻，基于持仓数据回答)'));
  }

  // ─── 市场快照 ───
  const market = {
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    holdings: holdingsBrief.length,
    fundCount: holdingsBrief.length,
  };

  // ─── 调用 LLM ───
  console.log(color(COLORS.cyan, '\n🤖 AI 正在思考...\n'));
  const answer = await chat({ question, holdings: holdingsBrief, newsDigest, market });

  console.log(color(COLORS.bold, '═'.repeat(66)));
  console.log(answer);
  console.log(color(COLORS.bold, '═'.repeat(66)));
  console.log(color(COLORS.dim, '\n⚠️ 以上分析仅供参考，不构成投资建议。'));
}

async function main() {
  const args = process.argv.slice(2);

  // ─── 加载持仓数据 ───
  const holdingsData = await loadHoldings();
  if (holdingsData) {
    CONFIG.watchlist = holdingsData.watchlist;
    CONFIG.profitLoss = holdingsData.profitLoss;
    CONFIG.profitPct = holdingsData.profitPct;
    CONFIG.holdings = holdingsData.holdings;
  }

  let mode = 'analyze'; // analyze | scan | all | action
  let fundCodes = [...CONFIG.watchlist];

  for (const arg of args) {
    if (arg === '--scan') mode = 'scan';
    else if (arg === '--all') mode = 'all';
    else if (arg === '--action') mode = 'action';
    else if (arg === '--holdings') {
      // 打印当前持仓表格
      console.log(color(COLORS.bold, '\n📋 当前持仓列表 (来源: 养基宝)\n'));
      if (holdingsData) {
        console.log(`  最后更新: ${holdingsData.lastUpdated || '--'}\n`);
        console.log(`  ${'代码'.padEnd(8)} ${'简称'.padEnd(14)} ${'板块'.padEnd(12)} ${'持有金额'.padEnd(10)} ${'投入本金'.padEnd(10)} ${'收益'.padEnd(10)} ${'状态'}`);
        console.log(`  ${'─'.repeat(80)}`);
        let totalHold = 0, totalInvested = 0, totalProfit = 0;
        for (const h of holdingsData.holdings) {
          const plStr = h.profit >= 0 ? `+${(h.profit||0).toFixed(2)}` : (h.profit||0).toFixed(2);
          const plCol  = h.profit >= 0 ? COLORS.red : COLORS.green;
          const statusMap = {
            holding: '🟢 持有',
            watching: '👀 观察',
            plan_to_sell: '🔴 待卖出',
            plan_to_buy: '🔵 待买入',
          };
          const status = statusMap[h.status] || h.status;
          const amt = h.holdAmount || 0;
          const inv = h.totalInvested || 0;
          totalHold += amt;
          totalInvested += inv;
          totalProfit += (h.profit || 0);
          console.log(
            `  ${h.code.padEnd(8)} ${(h.shortName || h.name).padEnd(14)} ` +
            `${h.sector.padEnd(12)} ${amt.toFixed(0).padEnd(10)} ${inv.toFixed(0).padEnd(10)} ${plCol}${plStr.padEnd(10)}${COLORS.reset} ${status}`
          );
        }
        console.log(`  ${'─'.repeat(80)}`);
        const tpCol = totalProfit >= 0 ? COLORS.red : COLORS.green;
        const tpSign = totalProfit >= 0 ? '+' : '';
        console.log(
          `  ${'合计'.padEnd(36)} ${totalHold.toFixed(0).padEnd(10)} ${totalInvested.toFixed(0).padEnd(10)} ${tpCol}${tpSign}${totalProfit.toFixed(2)}${COLORS.reset}`
        );
      } else {
        console.log('  (未找到持仓文件)');
      }
      console.log('');
      return;
    }
    else if (arg === '--ask') {
      mode = 'ask';
    }
    else if (arg === '--help' || arg === '-h') {
      console.log(`
养基助手 - Fund Investment Assistant

用法:
  node fund-assistant.js                 使用默认自选基金分析
  node fund-assistant.js 000001 110011   指定基金代码分析
  node fund-assistant.js --scan          扫描热门板块
  node fund-assistant.js --all           完整分析（基金+板块扫描）
  node fund-assistant.js --action        下午2:30即时操作指令（混合MA+实时估值）
  node fund-assistant.js --holdings      查看当前持仓列表
  node fund-assistant.js --ask "黄金该止损吗？"  对话模式 — 随时问你的投资助理

持仓管理:
  养基宝为持仓唯一数据源，fund-config.json 补充基金元数据（板块/策略）。
  通过 update-holdings.js 管理买入/卖出操作记录。
`);
      return;
    } else if (/^\d{6}$/.test(arg)) {
      fundCodes.push(arg);
    }
  }

  // 去重
  fundCodes = [...new Set(fundCodes)];

  // 提取 --ask 的问题
  const askIdx = args.indexOf('--ask');
  let askQuestion = '';
  if (askIdx >= 0 && askIdx + 1 < args.length) {
    askQuestion = args.slice(askIdx + 1).join(' ');
    // 去掉被合并进去的其他 flag
    const flagMatch = askQuestion.match(/(.*?)(\s+--\w+.*)$/);
    if (flagMatch) askQuestion = flagMatch[1].trim();
  }

  // ─── 对话模式 ───
  if (mode === 'ask') {
    if (!askQuestion) {
      console.log(color(COLORS.red, '❌ 请在 --ask 后面输入你的问题'));
      console.log(color(COLORS.dim, '  例: node fund-assistant.js --ask "黄金该止损吗？"'));
      return;
    }
    await runAskMode(askQuestion, holdingsData, CONFIG);
    return;
  }

  console.log(color(COLORS.bold, `\n🚀 养基助手启动 - ${new Date().toLocaleString('zh-CN')}`));
  console.log(`  自选基金: ${fundCodes.join(', ')}`);

  if (mode === 'scan' || mode === 'all') {
    const hotSectors = await scanHotSectors();

    console.log(color(COLORS.cyan, `\n${'─'.repeat(70)}`));
    console.log(color(COLORS.bold, '\n🔥 热门板块推荐（趋势已建立+未到顶）\n'));

    if (hotSectors.length === 0) {
      console.log('  暂无符合条件的板块');
    } else {
      console.log(`  ${'板块名称'.padEnd(16)} ${'涨跌幅'.padEnd(10)} ${'趋势'.padEnd(10)} ${'量比'.padEnd(8)} ${'综合评分'}`);
      console.log(`  ${'─'.repeat(60)}`);
      for (const s of hotSectors) {
        const chgCol = s.change >= 0 ? COLORS.red : COLORS.green;
        const trendIcon = s.trend === 'bullish' ? '📈' : '📊';
        console.log(`  ${s.name.padEnd(14)} ${chgCol}${formatPercent(s.change).padEnd(10)}${COLORS.reset} ${trendIcon} ${s.trend.padEnd(6)} ${s.volRatio.toFixed(1).padEnd(8)} ${s.trendScore}`);
        if (s.signals.length > 0) {
          for (const sig of s.signals.slice(0, 2)) {
            const icon = sig.type === 'positive' ? '✅' : sig.type === 'negative' ? '❌' : '➖';
            console.log(`    ${icon} ${sig.msg}`);
          }
        }
      }

      console.log(`\n  ${color(COLORS.yellow, '💡 提示：板块分析基于技术面+资金面，建议进一步了解板块基本面后再做决策')}`);
    }
  }

  if (mode === 'analyze' || mode === 'all') {
    await analyzePortfolio(fundCodes);
  }

  if (mode === 'action') {
    const actionResult = await runActionMode(fundCodes);

    // ─── AI 解读 ───
    if (actionResult && actionResult.reportText) {
      const { generateInsight } = require('./llm.js');
      // 构建每只基金的完整画像（板块+策略+估值+MA）
      const fundProfiles = actionResult.fundResults.map(f => {
        const meta = CONFIG.fundIndexMap?.[f.code] || {};
        return {
          code: f.code,
          name: f.name,
          sector: meta.sector || '',
          valuation: f.valuation,
          valuationChange: f.valuationChange,
          nav: f.nav,
          holdAmount: f.holdAmount || 0,
          profitLoss: f.profitLoss,
          profitPct: f.profitPct,
          change1w: f.change1w,
          change1m: f.change1m,
          recentNav5: f.recentNav5,
          volatility: f.volatility,
          maData: f.maData ? {
            ma5: f.maData.ma5,
            ma10: f.maData.ma10,
            ma20: f.maData.ma20,
            alignment: f.maData.alignment,
            devMA20: f.maData.devMA20,
          } : null,
          commands: (f.commands || []).map(c => ({ type: c.type, instruction: c.instruction })),
          strategy: CONFIG.fundStrategy?.[f.code]?.desc || '',
          // ⬇️ 波动率动态信号，与看板一致
          algoSignal: f.algoSignal || 'neutral',
          algoSignalLabel: f.algoSignalLabel || '观望',
          // ⬇️ 板块量比（量价配合）
          sectorVol: f.sectorVol || null,
        };
      });

      const aiText = await generateInsight({
        fundProfiles,
        commands: [
          ...(actionResult.stopLossCmds || []),
          ...(actionResult.buyCmds || []),
          ...(actionResult.profitCmds || []),
        ],
        market: {
          indices: actionResult.marketIndices || {},
          sentiment: actionResult.marketRisk || 'neutral',
        },
        summary: {
          totalFunds: actionResult.fundResults.length,
          stopCount: actionResult.stopLossCmds?.length || 0,
          buyCount: actionResult.buyCmds?.length || 0,
          profitCount: actionResult.profitCmds?.length || 0,
        },
      });
      if (aiText) {
        console.log(color(COLORS.bold, '\n🤖 AI 解读'));
        console.log(color(COLORS.dim, '─'.repeat(66)));
        console.log(stripDisputeMarkers(aiText));
        console.log(color(COLORS.dim, '─'.repeat(66)));
        actionResult.reportText += '\n\n🤖 AI 解读\n' + '─'.repeat(40) + '\n' + stripDisputeMarkers(aiText) + '\n' + '─'.repeat(40);
        actionResult.aiRawText = aiText;  // 挂到 actionResult 上避免作用域问题
      }
    }

    // ─── 邮件推送 ───
    if (actionResult && actionResult.reportText) {
      try {
        await sendEmailNotification(actionResult.reportText, actionResult.aiRawText || null);
      } catch (e) {
        console.log(`⚠️ 邮件推送异常: ${e.message}`);
      }
    }

    return; // action 模式有自己的免责声明，不需要到尾部重复
  }

  console.log(color(COLORS.bold, `\n${'='.repeat(70)}`));
  console.log(color(COLORS.dim, '⚠️ 免责声明：本工具仅提供数据分析参考，不构成投资建议。'));
  console.log(color(COLORS.dim, '   投资有风险，买卖需谨慎。请根据自身情况独立决策。'));
  console.log(color(COLORS.bold, '='.repeat(70) + '\n'));
}

module.exports = {
  main,
  runActionMode,
  analyzePortfolio,
  scanHotSectors,
};
