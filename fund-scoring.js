#!/usr/bin/env node
/**
 * 养基量化打分卡 v2 - Fund Scoring Card
 *
 * 五维评分体系（0-100分），横向对比所有持仓基金：
 *   1. 趋势强度 (25%) — MA排列、价格位置、趋势方向
 *   2. 动量收益 (20%) — 近1周/1月/3月/6月收益率 + 相对基准强弱
 *   3. 资金流向 (20%) — 主力净流入、超大单方向、换手率 [仅交易时段可用]
 *   4. 回撤控制 (20%) — 最大回撤、当前回撤深度、恢复比例
 *   5. 板块热度 (15%) — 所属板块相对市场强弱 [仅交易时段可用]
 *
 * 自适应模式：
 *   - 交易时段 (9:30-15:00): 全维度评分
 *   - 盘后/周末: 自动降级为三维模式（趋势+动量+回撤），权重重新分配
 *
 * 用法:
 *   node fund-scoring.js                  # 全量打分排名
 *   node fund-scoring.js --simple         # 简洁模式（仅排名表）
 *   node fund-scoring.js --detail 006479  # 单只基金详细拆解
 *   node fund-scoring.js --json           # JSON输出（供其他脚本消费）
 */

const { readHoldings } = require('./holdings-io.js');
const { httpGet, parseJSONP, sleep } = require('./lib/utils.js');
const { COLORS, c, isTradingHours } = require('./lib/colors.js');
const log = require('./lib/logger.js')('fund-scoring');

// ═══════════════════════════════════════════
// 统一配置（从 fund-config.json 加载，避免双份维护）
// ═══════════════════════════════════════════
const sharedConfig = (() => {
  try {
    return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fund-config.json'), 'utf-8'));
  } catch (e) {
    console.error('❌ 无法加载 fund-config.json:', e.message);
    process.exit(1);
  }
})();

const CONFIG = {
  requestDelay: 150,
  timeout: 10000,
  fundIndexMap: sharedConfig.fundIndexMap,

  // 全维度权重（交易时段）
  weightsFull: {
    trend: 0.25, momentum: 0.20, flow: 0.20, drawdown: 0.20, sector: 0.15,
  },
  // 盘后三维权重（无实时数据时重新分配）
  weightsOffHours: {
    trend: 0.35, momentum: 0.30, drawdown: 0.35, flow: 0, sector: 0,
  },

  thresholds: {
    strongBuy: 75, buy: 65, hold: 45, reduce: 35,
  },
};

// COLORS, c, isTradingHours 从 lib/colors.js 加载
// httpGet, parseJSONP, sleep 从 lib/utils.js 加载

function getLastTradingDay() {
  const d = new Date();
  // 今天就是交易日（周一至周五），直接用今天，push2his 会返回到今天为止的 K 线
  // 只有周末才需要退到周五
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// HTTP 工具 -> lib/utils.js
// fund-scoring 需要 rejectUnauthorized: false + silent（中国金融 API 证书兼容）
function fetch(url, options = {}) {
  return httpGet(url, { ...options, rejectUnauthorized: false, silent: true });
}

// ═══════════════════════════════════════════
// 数据获取
// ═══════════════════════════════════════════

async function getFundValuation(code) {
  try {
    const text = await fetch(`http://fundgz.1234567.com.cn/js/${code}.js`);
    const data = parseJSONP(text);
    if (!data?.fundcode) return null;
    return {
      code: data.fundcode, name: data.name,
      nav: parseFloat(data.dwjz), valuation: parseFloat(data.gsz),
      valuationChange: parseFloat(data.gszzl),
      navDate: data.jzrq, valuationTime: data.gztime,
    };
  } catch (e) { return null; }
}

async function getHistoryNav(code, days = 120) {
  const allData = [];
  const pages = Math.ceil(days / 20);
  for (let p = 1; p <= pages; p++) {
    try {
      const text = await fetch(
        `https://api.fund.eastmoney.com/f10/lsjz?callback=callback&fundCode=${code}&pageIndex=${p}&pageSize=20`
      );
      const data = parseJSONP(text);
      if (data?.Data?.LSJZList) allData.push(...data.Data.LSJZList);
      await sleep(CONFIG.requestDelay);
    } catch (e) { break; }
  }
  return allData.map(d => ({
    date: d.FSRQ, nav: parseFloat(d.DWJZ),
    accNav: parseFloat(d.LJJZ), change: parseFloat(d.JZZZL) || 0,
  }));
}

async function getIndexQuote(secid) {
  try {
    const fields = 'f2,f3,f4,f12,f14,f43,f57,f58,f62,f64,f65,f66,f69,f70,f135,f136,f137,f170';
    const text = await fetch(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`,
      { referer: 'https://quote.eastmoney.com/' }
    );
    if (!text) return null;
    const json = JSON.parse(text);
    if (json.rc !== 0 || !json.data) return null;
    const d = json.data;
    return {
      code: d.f57 || d.f12, name: d.f58 || d.f14,
      price: (d.f43 || 0) / 100, changePct: (d.f170 || 0) / 100,
      mainFlow: (d.f62 || 0), superLargeNet: (d.f64 || 0),
      largeNet: (d.f65 || 0), midNet: (d.f66 || 0), smallNet: (d.f69 || 0),
      mainFlowDir: d.f135, turnover: (d.f137 || 0) / 100,
    };
  } catch (e) { return null; }
}

async function getSectorKline(secid, days = 60) {
  try {
    const end = getLastTradingDay();
    const d = new Date();
    d.setDate(d.getDate() - days - 10);
    // 退到最近的交易日
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    const beg = d.toISOString().slice(0, 10).replace(/-/g, '');

    const text = await fetch(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=${beg}&end=${end}`,
      { referer: 'https://quote.eastmoney.com/' }
    );
    if (!text) return [];
    const json = JSON.parse(text);
    if (json.rc !== 0 || !json.data?.klines) return [];
    return json.data.klines.map(l => {
      const p = l.split(',');
      return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], vol: +p[5], amt: +p[6] };
    });
  } catch (e) { return []; }
}

async function getBenchmarkKline() {
  return getSectorKline('1.000300', 120);
}

// ═══════════════════════════════════════════
// 维度一：趋势强度 (0-100)
// ═══════════════════════════════════════════

function calcMA(arr, period) {
  if (arr.length < period) return [];
  const result = [];
  for (let i = period - 1; i < arr.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += arr[j];
    result.push({ idx: i, value: sum / period });
  }
  return result;
}

function scoreTrend(historyNav, valuation) {
  const recent = historyNav.slice(0, 60).reverse(); // 旧→新
  const values = recent.map(d => d.nav);
  const today = valuation?.valuation || values[values.length - 1];
  const prices = [...values, today];

  if (prices.length < 20) return { score: 50, detail: { note: '数据不足' }, signals: [] };

  const last = prices[prices.length - 1];
  const ma5v = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma10v = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma20v = prices.slice(-20).reduce((a, b) => a + b, 0) / 20;
  // MA60 if available
  const n60 = Math.min(60, prices.length);
  const ma60v = prices.slice(-n60).reduce((a, b) => a + b, 0) / n60;

  let score = 50;
  const signals = [], detail = { price: last, ma5: ma5v, ma10: ma10v, ma20: ma20v, ma60: ma60v };

  // 均线排列 (45分)
  if (ma5v > ma10v && ma10v > ma20v && ma20v > ma60v) {
    score += 45; detail.alignment = '多头完美排列';
    signals.push('✅ MA5>MA10>MA20>MA60 完美多头排列');
  } else if (ma5v > ma10v && ma10v > ma20v) {
    score += 30; detail.alignment = '短期多头排列';
    signals.push('✅ MA5>MA10>MA20 短期多头');
  } else if (ma5v > ma20v) {
    score += 10; detail.alignment = '震荡偏多';
  } else if (ma5v < ma10v && ma10v < ma20v && ma20v < ma60v) {
    score -= 45; detail.alignment = '空头排列';
    signals.push('❌ MA5<MA10<MA20<MA60 空头排列，趋势走坏');
  } else if (ma5v < ma20v) {
    score -= 15; detail.alignment = '震荡偏空';
  } else {
    detail.alignment = '均线缠绕';
  }

  // 价格相对MA20偏离 (25分)
  if (ma20v > 0) {
    const pctFromMA20 = ((last - ma20v) / ma20v) * 100;
    detail.pctFromMA20 = pctFromMA20;
    if (pctFromMA20 > 5) { score -= 10; signals.push('⚠️ 偏离MA20过远，短期超买'); }
    else if (pctFromMA20 >= 0) { score += 15; }
    else if (pctFromMA20 > -5) { score -= 5; signals.push('⚠️ 价格在MA20下方'); }
    else { score -= 20; signals.push('❌ 深度破位MA20'); }
  }

  // 均线斜率 (30分)
  if (prices.length >= 12) {
    const ma5Prev = prices.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    const ma5Slope = ma5v - ma5Prev;
    // 数据不足25条时MA20斜率设为中性，避免空数组导致虚假斜率
    const ma20Prev = prices.length >= 25
      ? prices.slice(-25, -20).reduce((a, b) => a + b, 0) / 5
      : ma20v;
    const ma20Slope = ma20v - ma20Prev;
    if (ma5Slope > 0 && ma20Slope > 0) { score += 20; }
    else if (ma5Slope > 0) { score += 8; }
    else if (ma5Slope < 0 && ma20Slope < 0) { score -= 20; signals.push('❌ MA5和MA20均向下'); }
  }

  return { score: Math.max(0, Math.min(100, score)), detail, signals };
}

// ═══════════════════════════════════════════
// 维度二：动量收益 (0-100)
// ═══════════════════════════════════════════

function scoreMomentum(historyNav, benchmarkData) {
  if (historyNav.length < 5) return { score: 50, detail: {}, signals: [] };

  const navs = historyNav.map(d => d.nav);
  const signals = [];
  const returns = {};

  // 各周期收益
  for (const [label, d] of [['1周', 5], ['1月', 22], ['3月', 66], ['6月', 132]]) {
    if (navs.length > d) {
      const denom = navs[Math.min(d, navs.length - 1)];
      if (denom > 0 && isFinite(denom) && isFinite(navs[0])) {
        returns[label] = ((navs[0] - denom) / denom) * 100;
      } else returns[label] = null;
    } else returns[label] = null;
  }

  let score = 50;

  // 近1月 (40分)
  if (returns['1月'] !== null) {
    const r = returns['1月'];
    if (r > 8) { score += 35; signals.push(`✅ 近1月大涨 +${r.toFixed(1)}%`); }
    else if (r > 3) { score += 25; signals.push(`✅ 近1月上涨 +${r.toFixed(1)}%`); }
    else if (r > 0) { score += 12; }
    else if (r > -3) { score += 0; }
    else if (r > -8) { score -= 15; signals.push(`❌ 近1月下跌 ${r.toFixed(1)}%`); }
    else { score -= 30; signals.push(`❌ 近1月大跌 ${r.toFixed(1)}%`); }
  }

  // 近3月 (25分)
  if (returns['3月'] !== null) {
    const r = returns['3月'];
    if (r > 15) { score += 20; }
    else if (r > 5) { score += 12; }
    else if (r > 0) { score += 5; }
    else if (r > -15) { score -= 8; }
    else if (r > -25) { score -= 15; signals.push(`⚠️ 近3月跌幅 ${r.toFixed(1)}%`); }
    else { score += 5; signals.push(`⚠️ 近3月超跌 ${r.toFixed(1)}%，可能有反弹机会`); }
  }

  // 动量持续性 (15分)
  if (returns['1周'] !== null && returns['1月'] !== null) {
    if (returns['1周'] > 0 && returns['1月'] > 0) score += 10;
    else if (returns['1周'] < 0 && returns['1月'] < 0) score -= 10;
    else if (returns['1周'] > 0 && returns['1月'] < 0) { score += 5; signals.push('↗ 短期反弹中，但中期仍偏弱'); }
  }

  // 相对基准 (20分)
  let relativeStr = 0;
  if (benchmarkData && benchmarkData.length > 0 && returns['1月'] !== null) {
    const bmNavs = benchmarkData.map(d => d.close);
    if (bmNavs.length > 22) {
      const bmDenom = bmNavs[bmNavs.length - 23];
      if (bmDenom > 0 && isFinite(bmDenom) && isFinite(bmNavs[bmNavs.length - 1])) {
        const bm1m = ((bmNavs[bmNavs.length - 1] - bmDenom) / bmDenom) * 100;
        relativeStr = returns['1月'] - bm1m;
        if (relativeStr > 5) { score += 20; signals.push(`✅ 跑赢沪深300 ${relativeStr.toFixed(1)}%`); }
        else if (relativeStr > 0) { score += 10; }
        else if (relativeStr > -5) { score -= 5; }
        else { score -= 15; signals.push(`❌ 跑输沪深300 ${Math.abs(relativeStr).toFixed(1)}%`); }
      }
    }
  }

  return { score: Math.max(0, Math.min(100, score)), detail: { returns, relativeStrength: relativeStr }, signals };
}

// ═══════════════════════════════════════════
// 维度三：资金流向 (0-100) [仅交易时段]
// ═══════════════════════════════════════════

function scoreFlow(indexQuote, fundType) {
  if (!indexQuote) {
    return { score: null, available: false, detail: {}, signals: ['⏸ 实时数据不可用（盘后/非交易日）'] };
  }
  if (fundType === 'qdii' || fundType === 'hk' || fundType === 'commodity') {
    return { score: null, available: false, detail: {}, signals: ['⏸ QDII/境外基金无A股资金流数据'] };
  }

  let score = 50;
  const signals = [], detail = {};
  const mf = indexQuote.mainFlow || 0;
  const sl = indexQuote.superLargeNet || 0;
  const lg = indexQuote.largeNet || 0;
  const to = indexQuote.turnover || 0;
  detail.mainFlow = mf; detail.superLargeNet = sl; detail.largeNet = lg; detail.turnover = to;

  // 主力净流入 (50分)
  if (mf > 1e8) { score += 50; signals.push(`✅ 主力大额净流入 ${fmtMoney(mf)}`); }
  else if (mf > 0) { score += 30; signals.push(`✅ 主力净流入 ${fmtMoney(mf)}`); }
  else if (mf > -1e8) { score += 0; }
  else { score -= 30; signals.push(`❌ 主力净流出 ${fmtMoney(Math.abs(mf))}`); }

  // 超大单 (25分)
  if (sl > 1e8) { score += 25; signals.push(`✅ 超大单大幅流入 ${fmtMoney(sl)}`); }
  else if (sl > 0) { score += 10; }
  else if (sl < -1e8) { score -= 20; signals.push(`❌ 超大单大幅流出 ${fmtMoney(Math.abs(sl))}`); }

  // 换手率 (25分)
  if (to > 0) {
    if (to >= 2 && to <= 8) { score += 15; }
    else if (to > 15) { score -= 15; signals.push(`⚠️ 换手率${to.toFixed(1)}%过高`); }
    else if (to > 8) { score += 5; }
    else if (to < 1) { score -= 5; }
  }

  return { score: Math.max(0, Math.min(100, score)), available: true, detail, signals };
}

// ═══════════════════════════════════════════
// 维度四：回撤控制 (0-100)
// ═══════════════════════════════════════════

function scoreDrawdown(historyNav) {
  if (historyNav.length < 20) return { score: 50, detail: {}, signals: [] };

  const navs = historyNav.map(d => d.nav).reverse(); // 旧→新
  let peak = navs[0], maxDD = 0;
  for (const nav of navs) { if (nav > peak) peak = nav; const dd = (peak - nav) / peak * 100; if (dd > maxDD) maxDD = dd; }
  // peak无效（0/NaN/负值）时返回默认分，避免除零导致NaN传播
  if (!peak || peak <= 0 || isNaN(peak) || !isFinite(peak)) {
    return { score: 50, detail: { note: '净值数据异常' }, signals: [] };
  }
  const currentDD = (peak - navs[navs.length - 1]) / peak * 100;

  let score = 50;
  const signals = [], detail = { maxDrawdown: maxDD, currentDrawdown: currentDD, peak };

  // 当前回撤深度 (60分)
  if (currentDD < 3) { score += 35; signals.push('✅ 回撤仅' + currentDD.toFixed(1) + '%，接近前高'); }
  else if (currentDD < 8) { score += 20; }
  else if (currentDD < 15) { score -= 10; signals.push('⚠️ 回撤' + currentDD.toFixed(1) + '%'); }
  else if (currentDD < 25) { score -= 25; signals.push('❌ 回撤' + currentDD.toFixed(1) + '%，大幅回撤中'); }
  else { score -= 40; signals.push('❌ 深度套牢 -' + currentDD.toFixed(1) + '%'); }

  // 恢复比例 (30分)
  if (maxDD > 0 && currentDD < maxDD) {
    const recovered = ((maxDD - currentDD) / maxDD * 100);
    detail.recoveryPct = recovered;
    if (recovered > 80) { score += 25; signals.push('✅ 从最大回撤恢复' + recovered.toFixed(0) + '%'); }
    else if (recovered > 50) { score += 10; }
  }

  // 历史最大回撤惩罚 (10分)
  if (maxDD > 40) { score -= 10; signals.push('⚠️ 历史最大回撤' + maxDD.toFixed(1) + '%，高风险品种'); }

  return { score: Math.max(0, Math.min(100, score)), detail, signals };
}

// ═══════════════════════════════════════════
// 维度五：板块热度 (0-100) [仅交易时段]
// ═══════════════════════════════════════════

function scoreSectorHeat(sectorKlines, benchmarkData) {
  if (!sectorKlines || sectorKlines.length < 20) {
    return { score: null, available: false, detail: {}, signals: ['⏸ 板块K线数据不可用'] };
  }

  const closes = sectorKlines.map(k => k.close);
  const last = closes[closes.length - 1], first = closes[0];
  if (!first || first <= 0 || isNaN(first) || !isFinite(first)) {
    return { score: null, available: false, detail: {}, signals: ['⏸ 板块数据异常'] };
  }
  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const sectorRet = ((last - first) / first * 100);

  let score = 50;
  const signals = [], detail = { sectorReturn: sectorRet };

  // 板块趋势 (40分)
  if (ma5 > ma10 && ma10 > ma20) { score += 35; signals.push('✅ 板块多头排列'); }
  else if (ma5 > ma10) { score += 15; }
  else if (ma5 < ma10 && ma10 < ma20) { score -= 25; signals.push('❌ 板块空头排列'); }

  // 相对基准 (40分)
  if (benchmarkData && benchmarkData.length > 0) {
    const bmCl = benchmarkData.map(d => d.close);
    const bmRet = ((bmCl[bmCl.length - 1] - bmCl[0]) / bmCl[0] * 100);
    const rel = sectorRet - bmRet;
    detail.relativeReturn = rel;
    if (rel > 10) { score += 40; signals.push('✅ 大幅跑赢市场 +' + rel.toFixed(1) + '%'); }
    else if (rel > 3) { score += 25; signals.push('✅ 跑赢市场 +' + rel.toFixed(1) + '%'); }
    else if (rel > 0) { score += 10; }
    else if (rel > -5) { score -= 10; }
    else { score -= 20; signals.push('❌ 跑输市场 ' + rel.toFixed(1) + '%'); }
  }

  // 短期动量 (20分)
  const recent5 = closes.slice(-5);
  const upDays = recent5.filter((val, i) => i > 0 && val > recent5[i - 1]).length;
  if (upDays >= 4) score += 15; else if (upDays <= 1) score -= 10;

  return { score: Math.max(0, Math.min(100, score)), available: true, detail, signals };
}

// ═══════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toFixed(0);
}

function getAction(score) {
  if (isNaN(score) || score == null) return { label: '⚪ 数据不足', color: 'dim', priority: 99 };
  const t = CONFIG.thresholds;
  if (score >= t.strongBuy) return { label: '🟢 强烈加仓', color: 'green', priority: 1 };
  if (score >= t.buy) return { label: '🟢 考虑加仓', color: 'green', priority: 2 };
  if (score >= t.hold) return { label: '🟡 持有观望', color: 'yellow', priority: 3 };
  if (score >= t.reduce) return { label: '🟠 考虑减仓', color: 'red', priority: 4 };
  return { label: '🔴 强烈卖出', color: 'red', priority: 5 };
}

// ═══════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════

async function scoreAllFunds(holdings, options = {}) {
  const isTrading = isTradingHours();
  const modeLabel = isTrading ? '交易时段 · 全维度评分' : '盘后模式 · 三维评分（无实时数据）';
  const weights = isTrading ? CONFIG.weightsFull : CONFIG.weightsOffHours;

  console.log(c(COLORS.bold, '\n📊 养基量化打分卡 v2'));
  console.log(c(COLORS.dim, `  时间: ${new Date().toLocaleString('zh-CN')} | ${modeLabel}`));

  // 预取基准K线（盘后也能用，用 lastTradingDay）
  console.log(c(COLORS.dim, '  获取基准和板块数据...'));
  const benchmark = await getBenchmarkKline();
  const benchmarkOk = benchmark && benchmark.length > 0;

  // 预取板块K线
  const sectorCache = {};
  const bkSet = new Set();
  for (const h of holdings) {
    const map = CONFIG.fundIndexMap[h.code];
    if (map?.sectorBK) bkSet.add(map.sectorBK);
  }
  const bkPromises = [];
  for (const bk of bkSet) {
    bkPromises.push(
      getSectorKline(`90.${bk}`, 60).then(kl => { sectorCache[bk] = kl; })
    );
  }
  await Promise.all(bkPromises);
  const bkReady = Object.values(sectorCache).filter(kl => kl && kl.length >= 20).length;

  // 预取所有指数报价（交易时段才有效）
  let quoteCache = {};
  if (isTrading) {
    const secidSet = new Set();
    for (const h of holdings) {
      const map = CONFIG.fundIndexMap[h.code];
      if (map?.secid && map.type !== 'qdii' && map.type !== 'hk' && map.type !== 'commodity') secidSet.add(map.secid);
    }
    const qPromises = [];
    for (const sid of secidSet) {
      qPromises.push(
        getIndexQuote(sid).then(q => { if (q) quoteCache[sid] = q; })
      );
    }
    await Promise.all(qPromises);
  }

  console.log(c(COLORS.dim, `  基准: ${benchmarkOk ? '✅' : '❌'} | 板块K线: ${bkReady}/${bkSet.size} | 实时报价: ${Object.keys(quoteCache).length}`));

  // 逐个基金打分
  const results = [];
  const total = holdings.length;
  for (let i = 0; i < total; i++) {
    const h = holdings[i];
    const code = h.code;
    const map = CONFIG.fundIndexMap[code] || {};
    const fundType = map.type || 'unknown';

    process.stdout.write(`  [${String(i + 1).padStart(2)}/${total}] ${h.shortName || code}...`);

    // 获取数据
    const [valuation, historyNav, indexQuote] = await Promise.all([
      getFundValuation(code),
      getHistoryNav(code, 120),
      (isTrading && fundType !== 'qdii' && fundType !== 'hk' && fundType !== 'commodity' && map.secid) ? getIndexQuote(map.secid) : Promise.resolve(null),
    ]);

    if (!historyNav || historyNav.length < 10) {
      console.log(' ⚠️ 数据不足');
      continue;
    }

    // 五个维度
    const trend = scoreTrend(historyNav, valuation);
    const momentum = scoreMomentum(historyNav, benchmark);
    const flow = scoreFlow(indexQuote, fundType);
    const drawdown = scoreDrawdown(historyNav);
    const sector = scoreSectorHeat(map.sectorBK ? sectorCache[map.sectorBK] : null, benchmark);

    // 加权汇总：不可用维度的权重按比例分配给可用维度
    let finalScore = 0, totalWeight = 0;
    const dimScores = {};
    for (const [dim, w] of Object.entries(weights)) {
      const dimData = { trend, momentum, flow, drawdown, sector }[dim];
      const isAvailable = dimData.score !== null && !isNaN(dimData.score);
      if (isAvailable) {
        finalScore += dimData.score * w;
        totalWeight += w;
      }
    }
    if (totalWeight > 0) finalScore = Math.round(finalScore / totalWeight);
    else finalScore = NaN;  // 所有维度不可用时标记数据不足

    const action = getAction(finalScore);

    const dimLabel = { trend: '趋势', momentum: '动量', flow: '资金', drawdown: '回撤', sector: '板块' };
    const dims = {};
    for (const [dim, w] of Object.entries(weights)) {
      const dimData = { trend, momentum, flow, drawdown, sector }[dim];
      const avail = dimData.score !== null;
      dims[dim] = {
        score: avail ? dimData.score : '--',
        available: avail,
        weight: Math.round(w * 100),
        signals: dimData.signals || [],
        detail: dimData.detail || {},
      };
    }

    const profitPct = h.totalInvested > 0 ? (h.profit / h.totalInvested * 100) : 0;
    results.push({
      code, name: h.shortName || h.name || code,
      sector: map.sector || h.sector || '',
      holdAmount: h.holdAmount || 0, profit: h.profit || 0, profitPct,
      finalScore, action, dimensions: dims,
    });

    console.log(` ✓ ${finalScore}分 ${action.label}`);
    await sleep(CONFIG.requestDelay);
  }

  // NaN（数据不足）排最后
  results.sort((a, b) => {
    if (isNaN(a.finalScore) && isNaN(b.finalScore)) return 0;
    if (isNaN(a.finalScore)) return 1;
    if (isNaN(b.finalScore)) return -1;
    return b.finalScore - a.finalScore;
  });
  return { results, isTrading, weights };
}

// ═══════════════════════════════════════════
// 输出
// ═══════════════════════════════════════════

function printResults(data, options = {}) {
  const { results, isTrading } = data;

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const scoreC = (s) => {
    if (typeof s === 'string') return ' --';
    if (s >= 75) return c(COLORS.green, String(s).padStart(3));
    if (s >= 65) return c(COLORS.green, String(s).padStart(3));
    if (s >= 45) return c(COLORS.yellow, String(s).padStart(3));
    if (s >= 35) return c(COLORS.red, String(s).padStart(3));
    return c(COLORS.red, String(s).padStart(3));
  };

  // === 排名总表 ===
  console.log(c(COLORS.bold, '\n╔══════════════════════════════════════════════════════════════════════╗'));
  console.log(c(COLORS.bold, '║  量化打分排名                                        ║'));
  console.log(c(COLORS.bold, '╚══════════════════════════════════════════════════════════════════════╝\n'));

  const modeNote = isTrading ? '' : c(COLORS.dim, '  (盘后模式: 资金/板块数据不可用，仅趋势+动量+回撤)\n');
  console.log('排名  基金简称         板块       综合   趋势  动量  资金  回撤  板块    持仓盈亏      建议');
  console.log('─'.repeat(105));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rank = String(i + 1).padStart(2);
    const name = r.name.slice(0, 12).padEnd(12);
    const sect = (r.sector || '').slice(0, 8).padEnd(8);
    const d = r.dimensions;
    const profitStr = r.profit >= 0
      ? c(COLORS.red, `+${r.profit} (${r.profitPct.toFixed(1)}%)`)
      : c(COLORS.green, `${r.profit} (${r.profitPct.toFixed(1)}%)`);

    console.log(
      `${rank}   ${name} ${sect}` +
      `${c(COLORS.bold, String(r.finalScore).padStart(3))}  ` +
      `${scoreC(d.trend.score)}  ${scoreC(d.momentum.score)}  ${scoreC(d.flow.score)}  ${scoreC(d.drawdown.score)}  ${scoreC(d.sector.score)}  ` +
      `${profitStr.padStart(18)}  ${r.action.label}`
    );
  }
  console.log('─'.repeat(105));
  console.log(c(COLORS.dim, '  趋势:MA排列 | 动量:多周期收益 | 资金:主力流向 | 回撤:风控 | 板块:行业热度'));

  // === 操作建议分组 ===
  console.log(c(COLORS.bold, '\n📋 操作建议\n'));
  const groups = [
    ['🟢 强烈加仓 (≥75)', 'green', r => r.finalScore >= 75],
    ['🟢 考虑加仓 (65-74)', 'green', r => r.finalScore >= 65 && r.finalScore < 75],
    ['🟡 持有观望 (45-64)', 'yellow', r => r.finalScore >= 45 && r.finalScore < 65],
    ['🟠 考虑减仓 (35-44)', 'red', r => r.finalScore >= 35 && r.finalScore < 45],
    ['🔴 强烈卖出 (<35)', 'red', r => r.finalScore < 35],
  ];
  for (const [label, clr, fn] of groups) {
    const items = results.filter(fn);
    if (items.length) {
      console.log(c(COLORS[clr], `${label}：`));
      items.forEach(r => console.log(`  ${r.name} (${r.code}) — ${r.finalScore}分 | ${r.sector} | ${r.profit >= 0 ? '+' : ''}${r.profit}`));
      console.log();
    }
  }

  // === 各基金详情 ===
  if (!options.simple) {
    console.log(c(COLORS.bold, '\n━━━ 各基金信号详情 ━━━'));
    for (const r of results) {
      console.log(c(COLORS.bold, `\n${r.name} (${r.code}) — ${r.finalScore}分 ${r.action.label}`));
      console.log(c(COLORS.dim, `  板块:${r.sector} | 持仓:¥${r.holdAmount} | 盈亏:${r.profit >= 0 ? '+' : ''}¥${r.profit} (${r.profitPct >= 0 ? '+' : ''}${r.profitPct.toFixed(1)}%)`));
      for (const [dim, dd] of Object.entries(r.dimensions)) {
        const short = { trend: '趋势', momentum: '动量', flow: '资金', drawdown: '回撤', sector: '板块' }[dim];
        const scoreStr = dd.available ? `${dd.score}分` : 'N/A';
        console.log(c(COLORS.dim, `  ${short}(${dd.weight}%) ${scoreStr}`));
        for (const sig of dd.signals) console.log(`    ${sig}`);
      }
    }
  }

  console.log(c(COLORS.dim, '\n⚠️ 免责声明：量化评分仅供参考，不构成投资建议。投资有风险，操作需谨慎。\n'));
}

// ═══════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════

(async () => {
  const args = process.argv.slice(2);
  const options = {
    simple: args.includes('--simple'),
    json: args.includes('--json'),
    detail: args.includes('--detail') ? args[args.indexOf('--detail') + 1] : null,
  };

  let holdings;
  try {
    holdings = await readHoldings();
    if (!holdings || holdings.length === 0) throw new Error('持仓为空');
  } catch (e) {
    console.error('❌ 读取持仓失败:', e.message);
    process.exit(1);
  }

  const data = await scoreAllFunds(holdings, options);
  log.info('打分完成', { funds: data.results.length, avgScore: data.results.length ? (data.results.reduce((s, r) => s + r.finalScore, 0) / data.results.length).toFixed(1) : 0 });

  if (options.detail) {
    const r = data.results.find(r => r.code === options.detail);
    if (!r) { console.log(`❌ 未找到 ${options.detail}`); process.exit(1); }
    console.log(c(COLORS.bold, `\n${r.name} 详细拆解`));
    console.log(`综合: ${r.finalScore}分 ${r.action.label}\n`);
    for (const [dim, dd] of Object.entries(r.dimensions)) {
      console.log(`${dim}: ${dd.available ? dd.score + '/100' : 'N/A'}`);
      console.log('  明细:', JSON.stringify(dd.detail));
      for (const s of dd.signals) console.log('  ' + s);
      console.log();
    }
  } else {
    printResults(data, options);
  }
})();
