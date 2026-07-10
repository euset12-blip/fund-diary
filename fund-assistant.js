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

require('dotenv').config();

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseJSONP, parseJSObject, sleep, scalePrice } = require('./lib/utils.js');
const { formatMoney, formatPercent, formatProfit, barChart } = require('./lib/format.js');
const { COLORS, c: color } = require('./lib/colors.js');
const { calcVolatility, dynamicThresholds, calcMASlope, trendAdjustedMultipliers, countDaysBelowMA } = require('./lib/analytics.js');
const log = require('./lib/logger.js')('fund-assistant');
const { fetchSectorVolume, describeVolume, volumePriceSignal } = require('./sector-volume.js');

// ═══════════════════════════════════════════════════════════
// 邮件推送（需要 npm install nodemailer）
// ═══════════════════════════════════════════════════════════
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
  console.log('📧 nodemailer 已就绪，邮件推送可用');
} catch (e) {
  console.log('⚠️  nodemailer 未安装，邮件功能禁用。安装方法: npm install nodemailer');
}

// ═══════════════════════════════════════════════════════════
// 统一配置（从 fund-config.json 加载，避免双份维护）
// ═══════════════════════════════════════════════════════════
const sharedConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'fund-config.json'), 'utf-8'));
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
  logFile: path.join(__dirname, '操作日志.md'),

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

// ============================================================
// 持仓数据加载 — 养基宝 API（holdings-io 模块）+ fund-config.json 元数据
// ============================================================

const { readHoldings: loadHoldingsFromFile } = require('./holdings-io.js');
const yjbApi = require('./yjb-api.js');  // 养基宝 API — 真实账户数据

async function loadHoldings() {
  try {
    const holdings = await loadHoldingsFromFile();
    if (!holdings || holdings.length === 0) {
      console.warn('⚠️ 养基宝暂无持仓数据，使用 fund-config.json 基金列表');
      return null;
    }
    const watchlist = holdings.map(h => h.code);
    const profitLoss = {};
    const profitPct = {};
    holdings.forEach(h => {
      profitLoss[h.code] = h.profit || 0;
      profitPct[h.code] = h.totalInvested > 0 ? ((h.profit || 0) / h.totalInvested * 100) : 0;
    });

    console.log(`📋 已加载持仓: ${holdings.length} 只基金 (来源: 养基宝)`);
    return { holdings, watchlist, profitLoss, profitPct, lastUpdated: new Date().toISOString().slice(0, 10) };
  } catch (e) {
    console.warn(`⚠️ 读取持仓失败: ${e.message}，使用 fund-config.json 默认持仓`);
    return null;
  }
}

// ============================================================
// 工具函数
// ============================================================

// COLORS, color(=c), sleep, httpGet, parseJSONP, parseJSObject, scalePrice,
// formatMoney, formatPercent, formatProfit, barChart 已从 lib/ 公共模块加载
// fund-assistant 保留自己的 httpGet（支持重试 + yjb-api 签名等特有需求）

function httpGet(url, options = {}) {
  const maxRetries = options.retries || 0;
  const retryDelay = options.retryDelay || 500;

  return new Promise((resolve, reject) => {
    const doRequest = (attempt) => {
      const client = url.startsWith('https') ? https : http;
      const u = new URL(url);
      const reqOptions = {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': options.referer || 'https://fund.eastmoney.com/',
          'Accept': '*/*',
          ...options.headers,
        },
        timeout: options.timeout || 10000,
      };

      const req = client.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // Handle redirect
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return httpGet(res.headers.location, options).then(resolve).catch(reject);
          }
          resolve(data);
        });
      });

      req.on('error', (e) => {
        if (attempt < maxRetries) {
          setTimeout(() => doRequest(attempt + 1), retryDelay * (attempt + 1));
        } else {
          reject(e);
        }
      });
      req.on('timeout', () => {
        req.destroy();
        if (attempt < maxRetries) {
          setTimeout(() => doRequest(attempt + 1), retryDelay * (attempt + 1));
        } else {
          reject(new Error('Timeout'));
        }
      });
      req.end();
    };
    doRequest(0);
  });
}

// ═══════════════════════════════════════════════════════════
// parseJSONP, parseJSObject, scalePrice, formatMoney, formatPercent,
// formatProfit, barChart, sleep, COLORS, color 已提取到 lib/ 公共模块
// ═══════════════════════════════════════════════════════════

// ============================================================
// 数据获取
// ============================================================

async function getFundValuation(code) {
  try {
    const url = `http://fundgz.1234567.com.cn/js/${code}.js`;
    const text = await httpGet(url);
    const data = parseJSONP(text, 'jsonpgz');
    if (!data) return null;
    return {
      code: data.fundcode,
      name: data.name,
      navDate: data.jzrq,
      nav: parseFloat(data.dwjz),
      valuation: parseFloat(data.gsz),
      valuationChange: parseFloat(data.gszzl),
      valuationTime: data.gztime,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 获取指数/板块的实时涨跌幅（用于估算基金估值）
 * @param {string} secid - 指数代码，如 '1.000016'（上证50）、'90.BK0521'（半导体）
 * @returns {Object|null} { name, price, changePercent, change } 或 null
 */
async function getIndexChange(secid) {
  try {
    const fields = 'f2,f3,f4,f12,f14,f43,f57,f58,f170';
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`;
    const text = await httpGet(url, { referer: 'https://quote.eastmoney.com/', retries: 2 });
    const json = JSON.parse(text);
    if (json.rc !== 0 || !json.data) return null;
    const d = json.data;
    return {
      name: d.f58 || d.f14 || '',
      price: d.f43 ? d.f43 / 100 : null,
      changePercent: (d.f170 || 0) / 100,  // 转为百分比
      change: (d.f169 || 0) / 100,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 备选数据源：新浪财经基金估值 API
 * 天天基金失败时的第一备选
 */
async function getFundValuationSina(code) {
  try {
    const url = `https://hq.sinajs.cn/list=f_${code}`;
    const text = await httpGet(url, {
      referer: 'https://finance.sina.com.cn/',
      headers: { 'Referer': 'https://finance.sina.com.cn/fund/' },
      retries: 1,
      timeout: 8000,
    });
    // 格式: var hq_str_f_006479="名称,净值,估值,累计净值,日期,...";
    const m = text.match(/hq_str_f_\d+="([^"]*)"/);
    if (!m) return null;
    const parts = m[1].split(',');
    if (parts.length < 5) return null;
    const nav = parseFloat(parts[1]);
    const valuation = parseFloat(parts[2]);
    if (!nav || !valuation) return null;
    return {
      code,
      name: parts[0],
      navDate: parts[4] || '',
      nav,
      valuation,
      valuationChange: nav ? ((valuation - nav) / nav * 100) : 0,
      valuationTime: parts[5] || '',
      source: 'sina',
    };
  } catch (e) {
    return null;
  }
}

/**
 * 用底层指数涨跌估算基金实时估值（最可靠的备选方案）
 * @param {string} code - 基金代码
 * @param {Array} historyNav - 历史净值 [{date, nav}, ...] 最新在前
 * @returns {Object|null} 估值估算结果
 */
async function estimateFundFromIndex(code, historyNav) {
  const mapping = CONFIG.fundIndexMap[code];
  if (!mapping || !historyNav || historyNav.length === 0) return null;

  const idxData = await getIndexChange(mapping.secid);
  if (!idxData || idxData.changePercent == null) return null;

  const latestNav = historyNav[0].nav;
  // 假设基金涨跌幅 ≈ 跟踪指数涨跌幅（ETF 误差极小，主动基金略有偏差）
  const estimatedValuation = latestNav * (1 + idxData.changePercent / 100);

  return {
    code,
    name: `基金${code}`,
    navDate: historyNav[0].date,
    nav: latestNav,
    valuation: estimatedValuation,
    valuationChange: idxData.changePercent,
    valuationTime: `指数估算:${mapping.name} ${idxData.changePercent >= 0 ? '+' : ''}${idxData.changePercent.toFixed(2)}%`,
    source: 'index_estimate',
  };
}

async function getFundHistoryNav(code, days = 30) {
  try {
    const pages = Math.ceil(days / 20);
    const allData = [];
    for (let p = 1; p <= pages; p++) {
      const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=callback&fundCode=${code}&pageIndex=${p}&pageSize=20`;
      const text = await httpGet(url, { referer: 'https://fund.eastmoney.com/' });
      const data = parseJSONP(text, 'callback');
      if (data?.Data?.LSJZList) {
        allData.push(...data.Data.LSJZList);
      }
      await sleep(CONFIG.requestDelay);
    }
    return allData.map(d => ({
      date: d.FSRQ,
      nav: parseFloat(d.DWJZ),
      accNav: parseFloat(d.LJJZ),
      change: parseFloat(d.JZZZL) || 0,
    }));
  } catch (e) {
    return [];
  }
}

async function getFundHoldings(code) {
  try {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=2026&month=3`;
    const text = await httpGet(url, { referer: 'https://fundf10.eastmoney.com/' });
    const m = text.match(/var apidata=\s*(\{[\s\S]*\});/);
    if (!m) return [];

    const data = parseJSObject(m[1]);
    if (!data || !data.content) return [];
    const html = data.content;
    // Parse HTML table to extract stock holdings
    const holdings = [];
    const rowRegex = /<tr><td>(\d+)<\/td><td[^>]*><a[^>]*>(\d+)<\/a><\/td><td[^>]*><a[^>]*>([^<]+)<\/a><\/td>/g;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      holdings.push({
        rank: parseInt(match[1]),
        stockCode: match[2],
        stockName: match[3],
      });
    }
    return holdings;
  } catch (e) {
    return [];
  }
}

async function getStockQuote(secid) {
  try {
    const fields = 'f2,f3,f4,f12,f14,f43,f44,f45,f46,f47,f48,f57,f58,f62,f64,f65,f66,f69,f70,f71,f72,f78,f135,f136,f137,f184,f292';
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`;
    const text = await httpGet(url, { referer: 'https://quote.eastmoney.com/' });
    const json = JSON.parse(text);
    if (json.rc !== 0 || !json.data) return null;
    const d = json.data;
    return {
      code: d.f57 || d.f12,
      name: d.f58 || d.f14,
      price: scalePrice(d.f43),
      high: scalePrice(d.f44),
      low: scalePrice(d.f45),
      open: scalePrice(d.f46),
      volume: d.f47,
      amount: d.f48,
      change: (d.f170 || d.f169 || 0) / 100,
      changePercent: (d.f170 || d.f169 || 0) / 100,
      marketCap: d.f135,
      floatCap: d.f136,
      mainFlow: d.f137 || 0,
      superLargeNet: d.f138 || 0,
      largeNet: d.f140 || d.f139 || 0,
      turnover: d.f184 || 0,
      mainFlowDir: d.f62,
    };
  } catch (e) {
    return null;
  }
}

async function getStockIndustry(secid) {
  try {
    const fields = 'f57,f58,f100,f101,f102,f127,f128,f129';
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`;
    const text = await httpGet(url, { referer: 'https://quote.eastmoney.com/' });
    const json = JSON.parse(text);
    if (json.rc !== 0 || !json.data) return null;
    return {
      industry: json.data.f127 || '',
      region: json.data.f128 || '',
      concepts: (json.data.f129 || '').split(',').filter(Boolean),
    };
  } catch (e) {
    return null;
  }
}

async function getStockKline(secid, days = 60) {
  try {
    const d = new Date();
    const end = d.toISOString().slice(0, 10).replace(/-/g, '');
    d.setDate(d.getDate() - days - 5);
    const beg = d.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=${beg}&end=${end}`;
    const text = await httpGet(url, { referer: 'https://quote.eastmoney.com/' });
    const json = JSON.parse(text);
    if (json.rc !== 0 || !json.data?.klines) return [];
    return json.data.klines.map(line => {
      const parts = line.split(',');
      return {
        date: parts[0],
        open: parseFloat(parts[1]),
        close: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        volume: parseFloat(parts[5]),
        amount: parseFloat(parts[6]),
        change: parseFloat(parts[8]) || 0,
        changePercent: parseFloat(parts[9]) || 0,
        turnover: parseFloat(parts[10]) || 0,
      };
    });
  } catch (e) {
    return [];
  }
}

async function getSectorQuote(bkCode) {
  try {
    const secid = `90.${bkCode}`;
    const fields = 'f2,f3,f4,f12,f14,f43,f44,f45,f46,f47,f48,f57,f58,f62,f184';
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`;
    const text = await httpGet(url, { referer: 'https://quote.eastmoney.com/' });
    const json = JSON.parse(text);
    if (json.rc !== 0 || !json.data) return null;
    const d = json.data;
    return {
      code: d.f57 || d.f12,
      name: d.f58 || d.f14,
      price: d.f43,
      high: d.f44,
      low: d.f45,
      change: d.f169 || 0,
      changePercent: d.f170 || 0,
      mainFlow: d.f62,
      turnover: d.f184,
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// 技术分析
// ============================================================

function calcMA(kline, period) {
  if (kline.length < period) return [];
  const mas = [];
  for (let i = period - 1; i < kline.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += kline[j].close;
    }
    mas.push({ date: kline[i].date, value: sum / period });
  }
  return mas;
}

function analyzeKlineTrend(kline) {
  if (kline.length < 20) return { trend: 'insufficient_data', signals: [] };

  const closes = kline.map(k => k.close);
  const volumes = kline.map(k => k.volume);
  const latest = kline[kline.length - 1];
  const prev = kline[kline.length - 2];

  // 计算均线
  const ma5 = calcMA(kline, 5);
  const ma10 = calcMA(kline, 10);
  const ma20 = calcMA(kline, 20);

  const latestMA5 = ma5.length > 0 ? ma5[ma5.length - 1].value : null;
  const latestMA10 = ma10.length > 0 ? ma10[ma10.length - 1].value : null;
  const latestMA20 = ma20.length > 0 ? ma20[ma20.length - 1].value : null;

  const signals = [];
  let score = 0;

  // 1. 价格 vs 均线位置
  if (latestMA5 && latestMA10 && latestMA20) {
    if (latest.close > latestMA5 && latestMA5 > latestMA10 && latestMA10 > latestMA20) {
      signals.push({ type: 'positive', msg: '多头排列，价格在所有均线之上' });
      score += 25;
    } else if (latest.close < latestMA5 && latestMA5 < latestMA10 && latestMA10 < latestMA20) {
      signals.push({ type: 'negative', msg: '空头排列，价格在所有均线之下' });
      score -= 25;
    } else if (latest.close > latestMA20) {
      signals.push({ type: 'neutral', msg: '价格在20日均线上方，中期趋势偏多' });
      score += 10;
    } else if (latest.close < latestMA20) {
      signals.push({ type: 'neutral', msg: '价格在20日均线下方，中期趋势偏空' });
      score -= 10;
    }
  }

  // 2. 近期趋势（5日涨跌）
  const recent5 = kline.slice(-5);
  const change5d = ((latest.close - recent5[0].close) / recent5[0].close) * 100;
  if (change5d > 5) {
    signals.push({ type: 'warning', msg: `5日涨幅 ${change5d.toFixed(1)}%，短线涨幅过大，注意回调风险` });
    score -= 5;
  } else if (change5d < -5) {
    signals.push({ type: 'positive', msg: `5日跌幅 ${change5d.toFixed(1)}%，短线超跌，可能反弹` });
    score += 5;
  }

  // 3. 量价关系
  const avgVol10 = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
  const latestVol = volumes[volumes.length - 1];
  const volRatio = latestVol / avgVol10;

  if (volRatio > 1.5 && latest.close > prev.close) {
    signals.push({ type: 'positive', msg: `放量上涨（量比${volRatio.toFixed(1)}），资金介入积极` });
    score += 10;
  } else if (volRatio > 1.5 && latest.close < prev.close) {
    signals.push({ type: 'negative', msg: `放量下跌（量比${volRatio.toFixed(1)}），资金出逃` });
    score -= 15;
  } else if (volRatio < 0.5) {
    signals.push({ type: 'neutral', msg: `缩量（量比${volRatio.toFixed(1)}），市场观望情绪浓` });
  }

  // 4. 连续涨跌
  let consecutiveUp = 0, consecutiveDown = 0;
  for (let i = kline.length - 1; i > 0; i--) {
    if (kline[i].close > kline[i-1].close) consecutiveUp++;
    else break;
  }
  for (let i = kline.length - 1; i > 0; i--) {
    if (kline[i].close < kline[i-1].close) consecutiveDown++;
    else break;
  }

  if (consecutiveUp >= 5) {
    signals.push({ type: 'warning', msg: `连涨${consecutiveUp}天，注意获利回吐` });
    score -= 8;
  } else if (consecutiveDown >= 5) {
    signals.push({ type: 'positive', msg: `连跌${consecutiveDown}天，超卖明显` });
    score += 8;
  }

  // 5. 波动率
  const returns = [];
  for (let i = 1; i < kline.length; i++) {
    returns.push((kline[i].close - kline[i-1].close) / kline[i-1].close);
  }
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;

  return {
    trend: score > 20 ? 'bullish' : score < -20 ? 'bearish' : 'sideways',
    score,
    ma5: latestMA5,
    ma10: latestMA10,
    ma20: latestMA20,
    change5d,
    volRatio,
    consecutiveUp,
    consecutiveDown,
    volatility,
    signals,
  };
}

function analyzeCapitalFlow(stockData) {
  if (!stockData) return { score: 0, signals: [] };
  const signals = [];
  let score = 0;

  // 主力净流入方向
  if (stockData.mainFlow > 0) {
    signals.push({ type: 'positive', msg: `主力净流入 ${formatMoney(stockData.mainFlow)}` });
    score += 20;
  } else if (stockData.mainFlow < 0) {
    signals.push({ type: 'negative', msg: `主力净流出 ${formatMoney(Math.abs(stockData.mainFlow))}` });
    score -= 20;
  }

  // 超大单
  if (stockData.superLargeNet > 0) {
    score += 15;
    signals.push({ type: 'positive', msg: `超大单净流入 ${formatMoney(stockData.superLargeNet)}` });
  } else if (stockData.superLargeNet < 0) {
    score -= 15;
    signals.push({ type: 'negative', msg: `超大单净流出 ${formatMoney(Math.abs(stockData.superLargeNet))}` });
  }

  // 大单
  if (stockData.largeNet > 0) score += 5;
  else if (stockData.largeNet < 0) score -= 5;

  // 换手率
  if (stockData.turnover > 10) {
    signals.push({ type: 'warning', msg: `换手率 ${stockData.turnover.toFixed(1)}%，交易异常活跃` });
    score -= 5;
  } else if (stockData.turnover > 5) {
    signals.push({ type: 'neutral', msg: `换手率 ${stockData.turnover.toFixed(1)}%，交易活跃` });
    score += 3;
  }

  return { score, signals };
}

// ============================================================
// 综合分析与建议
// ============================================================

function generateRecommendation(techAnalysis, flowAnalysis, fundPerf) {
  const signals = [];
  let score = 50; // 中性起点

  // 技术面权重 40%
  score += techAnalysis.score * 0.4;
  signals.push(...techAnalysis.signals.map(s => ({ ...s, source: '技术面' })));

  // 资金面权重 40%
  score += flowAnalysis.score * 0.4;
  signals.push(...flowAnalysis.signals.map(s => ({ ...s, source: '资金面' })));

  // 基金表现权重 20%
  if (fundPerf) {
    if (fundPerf.realtimeChange < -3) {
      score -= 10;
      signals.push({ type: 'negative', msg: `今日估值大跌 ${formatPercent(fundPerf.realtimeChange)}`, source: '估值' });
    } else if (fundPerf.realtimeChange > 2) {
      score += 5;
      signals.push({ type: 'positive', msg: `今日估值大涨 ${formatPercent(fundPerf.realtimeChange)}`, source: '估值' });
    }
    if (fundPerf.change1w && fundPerf.change1w < -5) {
      score += 5;
      signals.push({ type: 'positive', msg: '近一周跌幅较大，可能超跌反弹', source: '估值' });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let action, colorCode, desc;
  if (score >= 65) {
    action = '加仓/买入';
    colorCode = COLORS.green;
    desc = '多项指标积极，建议考虑加仓';
  } else if (score >= 40) {
    action = '持有观望';
    colorCode = COLORS.yellow;
    desc = '信号中性，建议持仓观望';
  } else {
    action = '减仓/卖出';
    colorCode = COLORS.red;
    desc = '多项指标偏空，建议考虑减仓避险';
  }

  return { action, colorCode, desc, score, signals };
}

// ============================================================
// 混合MA计算（历史NAV + 实时估值）
// ============================================================

/**
 * 计算基金的混合均线系统
 * 使用历史 NAV（每日更新）作为基准，将当日实时估值作为"今日临时收盘价"代入计算
 *
 * @param {Array} historyNav - 历史净值 [{date, nav, accNav, change}, ...] 最新在前
 * @param {number} todayValuation - 当日实时估值
 * @returns {Object} { valuation, ma5, ma10, ma20, alignment, nearMA20, ... }
 */
function calcFundCompositeMA(historyNav, todayValuation) {
  if (!todayValuation || !historyNav || historyNav.length < 5) return null;

  // 翻转为最旧→最新，方便做切片计算
  const navs = historyNav.map(h => h.nav).reverse();

  // 混合序列：历史 NAV + 今日估值（作为"今天收盘"的替身）
  const composite = [...navs, todayValuation];

  const calc = (arr, period) => {
    if (arr.length < period) return null;
    const slice = arr.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  };

  const ma5  = calc(composite, 5);
  const ma10 = calc(composite, 10);
  const ma20 = calc(composite, 20);

  // 纯历史 NAV 均线（用于对比参考）
  const histMA5  = navs.length >= 5  ? navs.slice(-5).reduce((a, b) => a + b, 0) / 5  : null;
  const histMA10 = navs.length >= 10 ? navs.slice(-10).reduce((a, b) => a + b, 0) / 10 : null;
  const histMA20 = navs.length >= 20 ? navs.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;

  // 估值偏离均线的百分比
  const devMA5  = ma5  ? ((todayValuation - ma5)  / ma5  * 100) : null;
  const devMA10 = ma10 ? ((todayValuation - ma10) / ma10 * 100) : null;
  const devMA20 = ma20 ? ((todayValuation - ma20) / ma20 * 100) : null;

  // 均线排列判断
  let alignment = 'unknown';
  if (ma5 && ma10 && ma20) {
    if (todayValuation > ma5 && ma5 > ma10 && ma10 > ma20) {
      alignment = 'bullish_aligned';         // 多头排列：价 > MA5 > MA10 > MA20
    } else if (todayValuation < ma5 && ma5 < ma10 && ma10 < ma20) {
      alignment = 'bearish_aligned';         // 空头排列：价 < MA5 < MA10 < MA20
    } else if (ma5 > ma10) {
      alignment = 'short_bullish';           // 短期偏多
    } else if (ma5 < ma10) {
      alignment = 'short_bearish';           // 短期偏空
    } else {
      alignment = 'sideways';
    }
  }

  // 估值是否在 MA20 附近（±2%）——回踩企稳信号
  const nearMA20 = ma20 ? Math.abs(todayValuation - ma20) / ma20 < 0.02 : false;
  // 估值是否在 MA10 附近（±1.5%）
  const nearMA10 = ma10 ? Math.abs(todayValuation - ma10) / ma10 < 0.015 : false;

  // 历史 5 日涨跌幅（纯 NAV，不含今日估值）
  const recent5Nav = navs.slice(-5);
  const change5dHist = recent5Nav.length >= 5
    ? ((recent5Nav[recent5Nav.length - 1] - recent5Nav[0]) / recent5Nav[0] * 100)
    : null;

  return {
    valuation: todayValuation,
    ma5, ma10, ma20,
    histMA5, histMA10, histMA20,
    devMA5, devMA10, devMA20,
    alignment,
    nearMA20, nearMA10,
    change5dHist,
    latestNav: navs[navs.length - 1],
  };
}

// ============================================================
// 即时操作指令生成器（专为下午 2:30 设计）
// ============================================================

/**
 * 根据混合均线 + 估值 + 盈亏情况，生成可执行的操作指令
 *
 * 优先级规则（从高到低，纯右侧趋势驱动）：
 * 1. 🔴 立即止损：连续 3 日低于 MA20（不看盈亏，只看趋势）
 * 2. 🟠 保护性止盈：盈利≥10% + 首次跌破 MA20（高位回撤信号）
 * 3. 🟡 首次破位：第一天跌破 MA20，观察尾盘
 * 4. 🟢 买入：回踩 MA20 企稳 + 短期多头 → 加仓
 * 5. 🟢 买入：回踩 MA10 企稳 + 多头排列 → 加仓
 * 6. 🟡 常规止盈：盈利≥20/10/5（仅当未触发保护性止盈时）
 * 7. 🟢 趋势持有：多头排列
 * 8. 🔴 空头回避：空头排列
 * 9. ⚪ 默认观望：无明确信号
 *
 * @param {Object} fundInfo - {code, name}
 * @param {Object} maData - calcFundCompositeMA 的返回值
 * @param {Object} fundVal - 实时估值数据
 * @param {number} profitPct - 持仓盈亏百分比（%）
 * @param {Array}  historyNav - 历史净值（用于连续破位判断）
 * @returns {Array} 操作指令列表（按优先级排序）
 */
function generateIntradayCommands(fundInfo, maData, fundVal, profitLoss, historyNav, strategyConfig) {
  const commands = [];
  if (!maData || !fundVal) return commands;

  const { valuation, ma5, ma10, ma20, alignment, nearMA20, nearMA10, devMA20 } = maData;
  const strategyType = (strategyConfig || {}).type || 'stop_loss';

  // 连续低于 MA20 的天数（巩固空头）
  const consecBelowMA20 = ma20 ? countDaysBelowMA20(historyNav, ma20, 5) : 0;

  // ──────── 优先级 1：止损 — 连续 3 日低于 MA20 ────────
  // 回测结论：只有黄金/港股适合止损，美股/A股止损反而亏钱
  const stopLossEnabled = strategyType === 'stop_loss' || strategyType === 'light_stop';
  const isUrgent = strategyType === 'stop_loss';

  if (stopLossEnabled && ma20 && valuation < ma20 && consecBelowMA20 >= 3) {
    const breakPct = ((ma20 - valuation) / ma20 * 100).toFixed(2);

    if (profitLoss < 0) {
      const urgency = isUrgent
        ? '请在 15:00 前果断赎回全部仓位，不要犹豫！'
        : '建议减仓 30-50%，保留部分仓位观察。';
      const label = isUrgent ? '🔴 立即止损' : '🟠 轻仓止损';
      commands.push({
        priority: 1, type: 'stop_loss', label, color: 'red',
        instruction: `【${isUrgent ? '立即止损' : '趋势破位'}】估值 ${valuation.toFixed(4)} 已连续 ${consecBelowMA20} 日低于 MA20(${ma20.toFixed(4)})，空头趋势确认！亏损 ${Math.abs(profitLoss).toFixed(1)}%，${urgency}`,
        action: '赎回/卖出', deadline: '15:00',
      });
    } else {
      const urgency = isUrgent
        ? '请在 15:00 前减仓 40-50% 保护利润！'
        : '建议减仓 20-30% 锁定部分利润。';
      commands.push({
        priority: 1, type: 'stop_loss', label: '🔴 破位止损', color: 'red',
        instruction: `【破位止损】估值 ${valuation.toFixed(4)} 已连续 ${consecBelowMA20} 日低于 MA20(${ma20.toFixed(4)})，跌破幅度 ${breakPct}%。趋势已转空，虽仍有 +${profitLoss.toFixed(1)}% 盈利，${urgency}`,
        action: '减仓/卖出', deadline: '15:00',
      });
    }
  }

  // ──────── hold_dip 基金破位 MA20：不喊止损，喊补仓 ────────
  if (!stopLossEnabled && ma20 && valuation < ma20 && consecBelowMA20 >= 3) {
    const breakPct = ((ma20 - valuation) / ma20 * 100).toFixed(2);
    const stratDesc = (strategyConfig || {}).desc || '';
    commands.push({
      priority: 2, type: 'hold_through_dip', label: '💪 坚持持有', color: 'cyan',
      instruction: `【${stratDesc}策略】估值已连续 ${consecBelowMA20} 日低于 MA20，偏离 ${breakPct}%。回测显示 ${stratDesc}类止损不如持有，建议继续定投，回撤 ${Math.abs(profitLoss) >= 10 ? '≥10%可分批补仓' : '中耐心持有'}！`,
      action: '持有+定投', deadline: null,
    });
  }

  // ──────── 优先级 2：保护性止盈 — 盈利≥10% + 首次破位（高位回撤）────────
  if (stopLossEnabled && ma20 && valuation < ma20 && profitLoss >= 10 && consecBelowMA20 < 3) {
    const breakPct = ((ma20 - valuation) / ma20 * 100).toFixed(2);
    commands.push({
      priority: 2, type: 'protective_profit', label: '🟠 保护性止盈', color: 'yellow',
      instruction: `【保护性止盈】盈利 +${profitLoss.toFixed(1)}%，但今日首次跌破 MA20(${ma20.toFixed(4)})，偏离 ${breakPct}%。高位回撤信号！请在 15:00 前卖出 40-50% 仓位，锁定大部分利润！`,
      action: '分批止盈(保护)', deadline: '15:00',
    });
  }

  // ──────── 优先级 3：首次破位观察（仅止损策略基金）────────
  if (stopLossEnabled && ma20 && valuation < ma20 && consecBelowMA20 < 3) {
    const breakPct = ((ma20 - valuation) / ma20 * 100).toFixed(2);

    if (profitLoss < 0) {
      commands.push({
        priority: 3, type: 'first_break', label: '🟡 首破止损', color: 'yellow',
        instruction: `【首次破位】估值 ${valuation.toFixed(4)} 今日跌破 MA20(${ma20.toFixed(4)})，偏离 ${breakPct}%，亏损 ${Math.abs(profitLoss).toFixed(1)}%。观察尾盘：若收回 MA20 则持有，若确认跌破则在 15:00 前赎回止损！`,
        action: '观察尾盘/准备止损', deadline: '14:50 确认',
      });
    } else {
      commands.push({
        priority: 3, type: 'first_break', label: '🟡 首次破位', color: 'yellow',
        instruction: `【首次破位】估值 ${valuation.toFixed(4)} 今日首次跌破 MA20(${ma20.toFixed(4)})，偏离 ${breakPct}%。观察尾盘能否收复，若尾盘仍低于 MA20 则减仓！`,
        action: '观察尾盘', deadline: '14:50 确认',
      });
    }
  }

  // ──────── 优先级 2：回踩 MA20 企稳 + 短期多头 → 买入 ────────
  if (ma20 && nearMA20 && alignment === 'short_bullish' && valuation > ma20) {
    commands.push({
      priority: 2, type: 'buy_pullback', label: '🟢 回踩买入', color: 'green',
      instruction: `【立即行动】估值 ${valuation.toFixed(4)} 回踩 MA20(${ma20.toFixed(4)}) 附近企稳，短期均线多头。大盘若无暴跌，请在 15:00 前下单买入/加仓！`,
      action: '买入/加仓', deadline: '15:00',
    });
  }

  // ──────── 优先级 3：回踩 MA10 企稳 + 多头排列 → 加仓 ────────
  if (ma10 && nearMA10 && alignment === 'bullish_aligned' && valuation > ma20) {
    if (!commands.find(c => c.type === 'buy_pullback')) {
      commands.push({
        priority: 3, type: 'buy_ma10', label: '🟢 均线支撑', color: 'green',
        instruction: `【加仓机会】估值 ${valuation.toFixed(4)} 回踩 MA10(${ma10.toFixed(4)})，多头排列中。可在 15:00 前适量加仓！`,
        action: '加仓', deadline: '15:00',
      });
    }
  }

  // ──────── 优先级 4：补仓信号 — 回撤够深 + 企稳信号 → 分批抄底 ────────
  if (historyNav && historyNav.length >= 20) {
    const navs = historyNav.map(h => h.nav).reverse(); // 旧→新
    const high30d = Math.max(...navs.slice(-30));
    const drawdown = ((high30d - valuation) / high30d) * 100;

    // 近3日是否不再创新低（最低价不再下降）
    const recent3 = navs.slice(-4); // 取近4天（含昨天），判断最近3天
    const newLow = recent3.length >= 3 &&
      recent3[recent3.length - 1] <= Math.min(...recent3.slice(0, -1));

    // MA5 方向：今日 MA5 vs 昨日 MA5（纯历史 NAV 算的昨日 MA5）
    const histNavs = historyNav.map(h => h.nav).reverse(); // 旧→新
    const yesterdayMA5 = histNavs.length >= 6
      ? histNavs.slice(-6, -1).reduce((a, b) => a + b, 0) / 5
      : null;
    const ma5TurningUp = yesterdayMA5 && ma5 && ma5 > yesterdayMA5;

    // 估值站上 MA5
    const aboveMA5 = ma5 && valuation > ma5;

    if (drawdown >= 30 && ma5TurningUp && aboveMA5 && !newLow) {
      commands.push({
        priority: 4, type: 'dip_buy_heavy', label: '🟢 重仓抄底', color: 'green',
        instruction: `【重仓抄底】累计回撤 ${drawdown.toFixed(1)}%，MA5 已拐头向上，近3日止跌企稳。可在 15:00 前加仓 20-30%，分批建仓！`,
        action: '重仓加仓', deadline: '15:00',
      });
    } else if (drawdown >= 20 && aboveMA5 && !newLow) {
      commands.push({
        priority: 4, type: 'dip_buy_medium', label: '🟢 中仓补仓', color: 'green',
        instruction: `【中仓补仓】累计回撤 ${drawdown.toFixed(1)}%，估值站上 MA5，近3日不再创新低。可在 15:00 前加仓 10-15%！`,
        action: '中仓加仓', deadline: '15:00',
      });
    } else if (drawdown >= 10 && aboveMA5) {
      commands.push({
        priority: 5, type: 'dip_buy_light', label: '🟢 轻仓试探', color: 'green',
        instruction: `【轻仓试探】累计回撤 ${drawdown.toFixed(1)}%，已站上 MA5 短线企稳。可用小仓位(5-10%)试探性买入！`,
        action: '轻仓试探', deadline: '15:00',
      });
    }
  }

  // ──────── 优先级 5：常规止盈 — 未被保护性止盈覆盖时触发 ────────
  // hold_dip 策略：让利润奔跑，止盈阈值大幅提高（仅在趋势转弱时触发）
  const hasProtectiveProfit = commands.some(c => c.type === 'protective_profit');
  const isHoldDip = strategyType === 'hold_dip';

  if (!hasProtectiveProfit && profitLoss >= 20) {
    if (!isHoldDip || profitLoss >= 50) {
      commands.push({
        priority: 5, type: 'take_profit', label: '🟡 大额止盈', color: 'yellow',
        instruction: `【大额止盈】持仓盈利 +${profitLoss.toFixed(1)}%，已达高收益目标！建议在 15:00 前卖出 30-40% 仓位，锁定大部分利润！`,
        action: '分批止盈', deadline: '15:00',
      });
    }
  } else if (!hasProtectiveProfit && profitLoss >= 10) {
    if (!isHoldDip || profitLoss >= 40) {
      commands.push({
        priority: 5, type: 'take_profit', label: '🟡 分批止盈', color: 'yellow',
        instruction: `【分批止盈】持仓盈利 +${profitLoss.toFixed(1)}%，已达收益目标。建议在 15:00 前卖出 20-30% 仓位，锁定利润！`,
        action: '分批止盈', deadline: '15:00',
      });
    }
  } else if (!hasProtectiveProfit && profitLoss >= 5) {
    if (!isHoldDip) {
      commands.push({
        priority: 6, type: 'partial_profit', label: '🟡 部分止盈', color: 'yellow',
        instruction: `【部分止盈】持仓盈利 +${profitLoss.toFixed(1)}%，可考虑卖出 10-20% 仓位，锁定部分利润。`,
        action: '部分止盈', deadline: '15:00',
      });
    }
  }

  // ──────── hold_dip 多头持有：强势趋势中建议持有/加仓而非止盈 ────────
  if (isHoldDip && !hasProtectiveProfit && alignment === 'bullish_aligned') {
    if (!commands.find(c => c.type === 'take_profit')) {
      commands.push({
        priority: 4, type: 'hold_dip_strong', label: '🟢 强势持有', color: 'green',
        instruction: `【让利润奔跑】趋势强势，均线多头排列，${strategyConfig?.desc || ''}策略下建议继续持有，逢回调加仓。回测显示此类基金止损不如持有！`,
        action: '持有/加仓', deadline: null,
      });
    }
  }

  // ──────── 优先级 7：多头排列 → 持有/加仓 ────────
  if (alignment === 'bullish_aligned' && !commands.find(c => c.type === 'buy_pullback' || c.type === 'buy_ma10')) {
    commands.push({
      priority: 7, type: 'hold_bullish', label: '🟢 趋势持有', color: 'green',
      instruction: `【趋势持有】均线多头排列，估值在 MA5/MA10/MA20 之上，趋势健康。可继续持有，逢回调加仓。`,
      action: '持有/加仓', deadline: null,
    });
  }

  // ──────── 优先级 8：空头排列 → 观望/减仓 ────────
  if (alignment === 'bearish_aligned') {
    if (!commands.find(c => c.type === 'stop_loss')) {
      commands.push({
        priority: 8, type: 'avoid', label: '🔴 空头回避', color: 'red',
        instruction: `【空头排列】估值在 MA5/MA10/MA20 之下，趋势偏空。不建议加仓，已有仓位考虑减仓。`,
        action: '减仓/观望', deadline: null,
      });
    }
  }

  // ──────── 优先级 9：默认 — 无明确信号 → 观望/持有 ────────
  if (commands.length === 0) {
    if (alignment === 'short_bullish' || alignment === 'bullish_aligned') {
      commands.push({
        priority: 9, type: 'neutral_hold', label: '⚪ 继续持有', color: 'yellow',
        instruction: `【继续持有】估值 ${valuation.toFixed(4)} 在均线附近，无明确买卖信号，观望为主。`,
        action: '持有', deadline: null,
      });
    } else if (alignment === 'short_bearish' || alignment === 'bearish_aligned') {
      commands.push({
        priority: 9, type: 'neutral_caution', label: '⚪ 谨慎持有', color: 'yellow',
        instruction: `【谨慎持有】短期偏弱但未破 MA20，暂持观望，若后续跌破 MA20 则止损。`,
        action: '观望', deadline: null,
      });
    } else {
      commands.push({
        priority: 9, type: 'neutral_wait', label: '⚪ 等待信号', color: 'yellow',
        instruction: `【等待信号】均线交织，方向不明，建议观望不操作。`,
        action: '观望', deadline: null,
      });
    }
  }

  // 按优先级排序
  commands.sort((a, b) => a.priority - b.priority);
  return commands;
}

/**
 * 判断是否连续 N 日低于 MA20（巩固空头趋势）
 * @param {Array} historyNav - 历史净值 [{date, nav}, ...] 最新在前
 * @param {number} ma20 - MA20 值
 * @param {number} days - 检查天数，默认 3
 * @returns {number} 连续低于 MA20 的天数
 */
function countDaysBelowMA20(historyNav, ma20, days = 5) {
  if (!historyNav || !ma20) return 0;
  let count = 0;
  for (let i = 0; i < Math.min(days, historyNav.length); i++) {
    if (historyNav[i].nav < ma20) count++;
    else break;
  }
  return count;
}

// ============================================================
// 热门板块扫描
// ============================================================

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
    yjbData = await yjbApi.fetchAllData(process.env.YJB_ACCOUNT_ID || '');
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
          strategyCfg
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
      strategyCfg
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

// ═══════════════════════════════════════════════════════════════
// 邮件 HTML 样式常量（_ivory 风格：浅色专业金融主题）
// ═══════════════════════════════════════════════════════════════
const EMAIL_CSS = {
  // 颜色
  up: '#ef4444', upBg: '#fef2f2',
  down: '#10b981', downBg: '#ecfdf5',
  warn: '#f59e0b', warnBg: '#fffbeb',
  info: '#3b82f6', infoBg: '#eff6ff',
  primary: '#1677ff',
  text: '#1f2937', text2: '#6b7280', text3: '#9ca3af',
  bg: '#f5f7fa', cardBg: '#ffffff',
  border: '#e5e7eb',
};

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 解析纯文本报告为结构化段落，输出卡片式 HTML */
function textToEmailHtml(text) {
  const lines = text.split('\n');
  const blocks = [];       // [{ type, title, titleEmoji, lines: [] }]
  let current = null;
  let inHoldingsTable = false;
  let holdingsHeader = null;
  let holdingsRows = [];

  const SECTION_MAP = [
    { re: /🚨\s*(清仓|止损)/, type: 'stop_loss',   color: '#ef4444', bg: '#fef2f2', icon: '!' },
    { re: /🟠\s*(保护性止盈|保护止盈)/, type: 'profit_protect', color: '#f59e0b', bg: '#fffbeb', icon: '⬆' },
    { re: /🟡\s*(首次破位|止盈提醒)/, type: 'warn', color: '#f59e0b', bg: '#fffbeb', icon: '·' },
    { re: /🟢\s*(买入|加仓)/, type: 'buy',     color: '#10b981', bg: '#ecfdf5', icon: '+' },
    { re: /📊\s*大盘/, type: 'market',  color: '#3b82f6', bg: '#eff6ff', icon: '📊' },
    { re: /📋\s*全部持仓/, type: 'holdings', color: '#1f2937', bg: '#fafbfc', icon: '📋' },
    { re: /📌\s*总结/, type: 'summary', color: '#1f2937', bg: '#fafbfc', icon: '📌' },
  ];

  function flushBlock() {
    if (!current || current.lines.length === 0) return;
    // 识别 section 类型
    const title = current.title || '';
    let sec = { type: 'text', color: '#1f2937', bg: '#ffffff', icon: '' };
    for (const m of SECTION_MAP) {
      if (m.re.test(title)) { sec = m; break; }
    }
    current.type = sec.type;
    current.color = sec.color;
    current.bg = sec.bg;
    current.icon = sec.icon;
    blocks.push(current);
    current = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // 分隔线 → flush
    if (/^[═━]{3,}$/.test(trimmed) || /^[━]{3,}$/.test(trimmed)) {
      flushBlock();
      continue;
    }

    // 空行
    if (trimmed === '') {
      // 表格内空行也 flush
      if (inHoldingsTable) {
        inHoldingsTable = false;
      }
      continue;
    }

    // 标题行（不是缩进行、不是表格行）→ 新 block
    const isTitle = !raw.startsWith('  ') && !raw.startsWith('\t') &&
                    (trimmed.startsWith('🚨') || trimmed.startsWith('🟠') ||
                     trimmed.startsWith('🟡') || trimmed.startsWith('🟢') ||
                     trimmed.startsWith('📊') || trimmed.startsWith('📋') ||
                     trimmed.startsWith('📌') || trimmed.startsWith('🤖') ||
                     trimmed.startsWith('❌') || trimmed.startsWith('✅') ||
                     trimmed.startsWith('⚠️') || trimmed.startsWith('💰'));

    if (isTitle && !raw.startsWith('  ')) {
      flushBlock();
      current = { title: trimmed, lines: [] };
      // 如果是 📋 持仓 section，标记进入表格模式
      if (/📋/.test(trimmed)) {
        inHoldingsTable = true;
        holdingsRows = [];
        holdingsHeader = null;
      }
      continue;
    }

    // 持仓表格解析
    if (inHoldingsTable) {
      if (!holdingsHeader && trimmed.includes('基金简称') && trimmed.includes('估值')) {
        holdingsHeader = trimmed;
        continue;
      }
      if (trimmed.startsWith('─') || trimmed.startsWith('┈')) continue;
      // 表格数据行：缩进开头 + 足够字段
      if (raw.startsWith('  ') && trimmed.length > 10) {
        holdingsRows.push(trimmed);
        continue;
      }
      // 非表格内容 → 结束表格
      if (!raw.startsWith('  ') && holdingsRows.length > 0) {
        inHoldingsTable = false;
      }
    }

    // 普通内容行
    if (!current) {
      current = { title: '', lines: [] };
    }
    current.lines.push(escHtml(trimmed));
  }
  flushBlock();

  // ═══ 生成 HTML ═══
  const html = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'market':
        html.push(renderMarketBlock(block));
        break;
      case 'stop_loss':
        html.push(renderActionBlock(block, '止损指令'));
        break;
      case 'profit_protect':
        html.push(renderActionBlock(block, '保护性止盈'));
        break;
      case 'warn':
        html.push(renderActionBlock(block, '观察/止盈'));
        break;
      case 'buy':
        html.push(renderActionBlock(block, '买入加仓'));
        break;
      case 'holdings':
        html.push(renderHoldingsBlock(holdingsRows, block));
        break;
      case 'summary':
        html.push(renderSummaryBlock(block));
        break;
      default:
        html.push(renderTextBlock(block));
    }
  }

  return html.join('\n');
}

/** 大盘快照 — 横向指标卡 */
function renderMarketBlock(block) {
  const items = [];
  for (const line of block.lines) {
    const m = line.match(/(.+?):\s*([\d.]+)\s*([+-][\d.]+)%/);
    if (m) {
      const up = m[3].startsWith('+');
      items.push(`
        <td style="background:${EMAIL_CSS.cardBg};border-radius:8px;padding:10px 12px;text-align:center;border:1px solid ${EMAIL_CSS.border};${up?'border-top:3px solid '+EMAIL_CSS.up:'border-top:3px solid '+EMAIL_CSS.down}">
          <div style="font-size:11px;color:${EMAIL_CSS.text2};margin-bottom:4px">${escHtml(m[1])}</div>
          <div style="font-size:16px;font-weight:700;color:${up?EMAIL_CSS.up:EMAIL_CSS.down}">${m[2]}</div>
          <div style="font-size:12px;font-weight:600;color:${up?EMAIL_CSS.up:EMAIL_CSS.down}">${m[3]}%</div>
        </td>`);
    }
  }
  // 找恐慌/风险提示
  let alertHtml = '';
  for (const line of block.lines) {
    if (line.includes('暴跌') || line.includes('暂停')) {
      alertHtml = `<div style="margin-top:10px;padding:10px 14px;background:${EMAIL_CSS.upBg};border-radius:8px;border-left:4px solid ${EMAIL_CSS.up};font-size:13px;font-weight:600;color:${EMAIL_CSS.up}">${line}</div>`;
    } else if (line.includes('走弱') || line.includes('偏暖')) {
      alertHtml = `<div style="margin-top:10px;padding:10px 14px;background:${EMAIL_CSS.warnBg};border-radius:8px;border-left:4px solid ${EMAIL_CSS.warn};font-size:13px;color:${EMAIL_CSS.text}">${line}</div>`;
    }
  }

  if (items.length === 0) return '';
  // 响应式：3列变2列在小屏
  const cols = Math.min(items.length, 4);
  return `
    <div style="margin:14px 0">
      <div style="font-size:13px;font-weight:700;color:${EMAIL_CSS.text};margin-bottom:8px;display:flex;align-items:center;gap:4px">
        <span style="width:3px;height:14px;border-radius:2px;background:${EMAIL_CSS.primary};display:inline-block"></span>
        大盘快照
      </div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout:fixed">
        <tr>${items.join('')}</tr>
      </table>
      ${alertHtml}
    </div>`;
}

/** 操作指令卡片（止损/止盈/买入） */
function renderActionBlock(block, label) {
  const cardClass = { bg: block.bg, border: block.color, tagBg: block.color, tagColor: '#fff', icon: block.icon };
  const lines = block.lines;

  // 解析每只基金的详情：行格式大致是 "❌ 基金名 (代码)" 然后缩进行是估值/盈亏/MA/指令
  const funds = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    // 基金名行
    const nameMatch = t.match(/^[❌✅⚠️💰]\s*(.+?)\s*\((\d{6})\)/);
    if (nameMatch) {
      if (cur) funds.push(cur);
      cur = { name: nameMatch[1], code: nameMatch[2], meta: [] };
    } else if (cur && t.startsWith('→')) {
      cur.instruction = t.replace(/^→\s*/, '');
    } else if (cur) {
      // 过滤掉分隔线类的内容
      if (!/^[━═─]+$/.test(t) && t.length > 2) {
        cur.meta.push(t);
      }
    }
  }
  if (cur) funds.push(cur);

  if (funds.length === 0) return '';

  const cards = funds.map(f => {
    const metaRows = f.meta.map(m => {
      // 高亮估值、MA、盈亏
      const hl = m
        .replace(/估值:\s*([\d.]+)/, '估值: <b>$1</b>')
        .replace(/MA\d+:\s*([\d.]+)/g, 'MA: <b>$1</b>')
        .replace(/盈亏:\s*(.*)/, '盈亏: <b>$1</b>')
        .replace(/盈利:\s*(.*)/, '盈利: <b>$1</b>')
        .replace(/偏离.*?:\s*([+-][\d.]+%)/g, '偏离: <b>$1</b>');
      return `<div style="font-size:12px;color:${EMAIL_CSS.text2};line-height:1.6">${hl}</div>`;
    }).join('');

    return `
      <div style="background:${EMAIL_CSS.cardBg};border-radius:10px;padding:14px;margin-bottom:8px;border-left:4px solid ${block.color};box-shadow:0 1px 3px rgba(0,0,0,0.06)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:14px;font-weight:700;color:${EMAIL_CSS.text}">${escHtml(f.name)}</span>
          <span style="font-size:10px;color:${EMAIL_CSS.text3}">${f.code}</span>
        </div>
        ${metaRows}
        ${f.instruction ? `<div style="margin-top:8px;padding:6px 10px;background:${block.bg};border-radius:6px;font-size:13px;font-weight:600;color:${block.color}">→ ${escHtml(f.instruction)}</div>` : ''}
      </div>`;
  }).join('');

  return `
    <div style="margin:14px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:13px;font-weight:700;color:${EMAIL_CSS.text};display:flex;align-items:center;gap:4px">
          <span style="width:3px;height:14px;border-radius:2px;background:${block.color};display:inline-block"></span>
          ${block.title}
        </span>
        <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:${block.bg};color:${block.color}">${funds.length} 只</span>
      </div>
      ${cards}
    </div>`;
}

/** 持仓表格 → 响应式卡片列表（每只基金一张卡片，手机直接看） */
function renderHoldingsBlock(rows, block) {
  if (rows.length === 0) return '';

  // 解析固定宽度列（每列起始位置用多个空格判断）
  const cards = rows.map(row => {
    // 行格式: "基金名       估值     日变     vsMA20    均线排列     操作"
    // 使用多个连续空格(2+)拆分
    const cols = row.split(/\s{2,}/).filter(Boolean);
    if (cols.length < 4) {
      return `<div style="font-size:11px;color:${EMAIL_CSS.text3};padding:6px 0">${escHtml(row)}</div>`;
    }

    const name = cols[0] || '';
    const price = cols[1] || '--';
    const dayChg = cols[2] || '--';
    const devMA = cols[3] || '--';
    const alignment = cols[4] || '--';
    const action = cols[5] || '--';

    // 操作类型染色
    let actionColor = EMAIL_CSS.text2;
    let cardBorder = EMAIL_CSS.border;
    if (action.includes('止损')) { actionColor = EMAIL_CSS.up; cardBorder = EMAIL_CSS.up; }
    else if (action.includes('保护止盈') || action.includes('止盈')) { actionColor = EMAIL_CSS.warn; cardBorder = EMAIL_CSS.warn; }
    else if (action.includes('买入') || action.includes('持有')) { actionColor = EMAIL_CSS.down; cardBorder = EMAIL_CSS.down; }
    else if (action.includes('观察') || action.includes('观望')) { actionColor = EMAIL_CSS.warn; cardBorder = EMAIL_CSS.warn; }

    // 均线排列染色
    let alignColor = EMAIL_CSS.text2;
    if (alignment.includes('多头')) alignColor = EMAIL_CSS.up;
    else if (alignment.includes('空头')) alignColor = EMAIL_CSS.down;

    // vsMA20 偏离
    const devUp = devMA.startsWith('+');
    const devColor = devUp ? EMAIL_CSS.up : EMAIL_CSS.down;

    return `
      <div style="background:${EMAIL_CSS.cardBg};border-radius:8px;padding:10px 12px;margin-bottom:4px;border-left:3px solid ${cardBorder};box-shadow:0 1px 2px rgba(0,0,0,0.04)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;color:${EMAIL_CSS.text};max-width:55%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escHtml(name)}</span>
          <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${actionColor}15;color:${actionColor}">${escHtml(action)}</span>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px">
          <span style="color:${EMAIL_CSS.text3}">净值 <b style="color:${EMAIL_CSS.text}">${escHtml(price)}</b></span>
          <span style="color:${EMAIL_CSS.text3}">日变 <b>${escHtml(dayChg)}</b></span>
          <span style="color:${EMAIL_CSS.text3}">vsMA20 <b style="color:${devColor}">${escHtml(devMA)}</b></span>
          <span style="color:${EMAIL_CSS.text3}">均线 <b style="color:${alignColor}">${escHtml(alignment)}</b></span>
        </div>
      </div>`;
  }).join('');

  return `
    <div style="margin:14px 0">
      <div style="font-size:13px;font-weight:700;color:${EMAIL_CSS.text};margin-bottom:8px;display:flex;align-items:center;gap:4px">
        <span style="width:3px;height:14px;border-radius:2px;background:${EMAIL_CSS.primary};display:inline-block"></span>
        全部持仓速览
      </div>
      ${cards}
    </div>`;
}

/** 总结块 */
function renderSummaryBlock(block) {
  const text = block.lines.join('<br>');
  return `
    <div style="margin:14px 0;padding:14px 16px;background:${EMAIL_CSS.infoBg};border-radius:10px;border:1px solid ${EMAIL_CSS.info}20">
      <div style="font-size:13px;font-weight:700;color:${EMAIL_CSS.info};margin-bottom:6px">📌 操作总结</div>
      <div style="font-size:13px;color:${EMAIL_CSS.text};line-height:1.6">${text}</div>
    </div>`;
}

/** 纯文本块（免责声明等） */
function renderTextBlock(block) {
  const text = block.lines.join('<br>');
  const isDisclaimer = text.includes('免责') || text.includes('投资有风险');
  return `
    <div style="margin:10px 0;padding:${isDisclaimer?'10px 14px':'8px 0'};font-size:${isDisclaimer?'11px':'13px'};color:${isDisclaimer?EMAIL_CSS.text3:EMAIL_CSS.text};line-height:1.8;${isDisclaimer?'background:'+EMAIL_CSS.bg+';border-radius:8px;text-align:center':''}">
      ${text}
    </div>`;
}

/**
 * 发送邮件通知 — _ivory 浅色专业风格
 * @param {string} textContent - 纯文本报告
 */
/**
 * 从 AI 解读文本中提取争议列表
 * @returns {Array<{code, name, algoSignal, aiVerdict, reason}>}
 */
function parseDisputes(aiText) {
  if (!aiText) return [];
  const m = aiText.match(/===DISPUTE===\n([\s\S]*?)\n===END===/);
  if (!m || m[1].trim() === 'NONE') return [];
  return m[1].trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('|');
    return {
      code: parts[0]?.trim() || '',
      name: parts[1]?.trim() || '',
      algoSignal: parts[2]?.trim() || '',
      aiVerdict: parts[3]?.trim() || '',
      reason: parts[4]?.trim() || '',
    };
  });
}

/** 从 AI 文本中剥离争议标记，返回干净的解读正文 */
function stripDisputeMarkers(aiText) {
  if (!aiText) return '';
  return aiText.replace(/===DISPUTE===[\s\S]*?===END===/g, '').trim();
}

async function sendEmailNotification(textContent, aiInsightText) {
  if (!nodemailer) {
    console.log('📧 邮件功能未启用（nodemailer 未安装），跳过推送');
    return;
  }
  if (!CONFIG.email || !CONFIG.email.enabled) {
    console.log('📧 邮件推送未启用，跳过');
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: CONFIG.email.host,
      port: CONFIG.email.port,
      secure: true,
      auth: { user: CONFIG.email.user, pass: CONFIG.email.pass },
    });

    // 解析 AI 争议（从 AI 原文中提取，报告正文已含剥离后的解读）
    const disputes = aiInsightText ? parseDisputes(aiInsightText) : [];

    const htmlBody = textToEmailHtml(textContent);
    const today = new Date().toLocaleDateString('zh-CN');
    const weekday = ['周日','周一','周二','周三','周四','周五','周六'][new Date().getDay()];
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // ─── 争议案例卡片 ───
    let disputeHtml = '';
    if (disputes.length > 0) {
      const cards = disputes.map(d => `
        <div style="background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:6px;border-left:4px solid #f59e0b;box-shadow:0 1px 3px rgba(0,0,0,0.05)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:14px;font-weight:700;color:#1f2937">${escHtml(d.name)}</span>
            <span style="font-size:10px;color:#9ca3af">${d.code}</span>
          </div>
          <div style="display:flex;gap:12px;align-items:center;font-size:12px;margin-bottom:4px">
            <span style="padding:2px 8px;border-radius:4px;background:#e5e7eb;color:#6b7280">🤖 算法: ${escHtml(d.algoSignal)}</span>
            <span style="font-size:16px;color:#9ca3af">→</span>
            <span style="padding:2px 8px;border-radius:4px;background:#fef3c7;color:#d97706;font-weight:600">🧠 AI: ${escHtml(d.aiVerdict)}</span>
          </div>
          <div style="font-size:12px;color:#6b7280">${escHtml(d.reason)}</div>
        </div>`).join('');
      disputeHtml = `
      <div style="background:linear-gradient(135deg,#fffbeb,#fef3c7);border-radius:14px;padding:16px 18px;margin-bottom:12px;border:1px solid #fde68a;box-shadow:0 2px 8px rgba(245,158,11,0.1)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="font-size:18px">⚠️</span>
          <span style="font-size:15px;font-weight:700;color:#d97706">今日需关注 · 量化 vs AI 意见分歧</span>
          <span style="font-size:11px;color:#d97706;font-weight:500;padding:2px 8px;background:#fef3c7;border-radius:10px">${disputes.length} 只</span>
        </div>
        <div style="font-size:12px;color:#92400e;margin-bottom:10px;line-height:1.6">以下基金，量化算法和 AI 独立判断意见不一致。建议你重点看，自己拍板。</div>
        ${cards}
      </div>`;
    }

    const mailOptions = {
      from: `"养基日记" <${CONFIG.email.user}>`,
      to: CONFIG.email.to,
      subject: `🔴 养基日记 · 今日盘中操作指令 [${today}]`,
      html: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px;background:${EMAIL_CSS.bg};font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:600px;margin:0 auto">

  <!-- Hero Header -->
  <div style="background:linear-gradient(135deg,#1677ff,#4096ff);border-radius:14px;padding:24px 20px;color:#fff;margin-bottom:12px;box-shadow:0 4px 16px rgba(22,119,255,0.2)">
    <div style="font-size:12px;opacity:0.85;margin-bottom:6px">养基日记 · 投资看板</div>
    <div style="font-size:26px;font-weight:700;letter-spacing:0.5px">🔴 今日盘中操作指令</div>
    <div style="font-size:13px;opacity:0.8;margin-top:10px">${today} ${weekday} ${timeStr} · 请在 15:00 前完成操作</div>
  </div>

  ${disputeHtml}

  <!-- 主体卡片 -->
  <div style="background:${EMAIL_CSS.cardBg};border-radius:14px;padding:16px 18px;box-shadow:0 2px 8px rgba(0,0,0,0.05)">
    ${htmlBody}
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:16px 8px 4px">
    <p style="color:${EMAIL_CSS.text3};font-size:11px;margin:0 0 4px">
      🤖 此邮件由养基助手自动生成 · 数据仅供参考，不构成投资建议
    </p>
    <a href="${process.env.DASHBOARD_URL || '#'}" style="color:${EMAIL_CSS.primary};font-size:12px;text-decoration:none">📊 打开 Web 看板 — AI 投资助理在线对话</a>
  </div>

</div>
</body>
</html>`,
    };

    const info = await transporter.sendMail(mailOptions);
    log.info('邮件已发送', { messageId: info.messageId });
    console.log(`📧 邮件已发送！MessageId: ${info.messageId}`);
  } catch (e) {
    log.error('邮件发送失败', { error: e.message });
    console.log(`⚠️ 邮件发送失败: ${e.message}`);
    console.log('   （脚本继续运行，不影响数据分析）');
  }
}

// ============================================================
// 主入口
// ============================================================

// ═══════════════════════════════════════════════════════════
// 对话模式 — runAskMode
// ═══════════════════════════════════════════════════════════
async function runAskMode(question, holdingsData, CONFIG) {
  const { chat } = require('./lib/llm.js');
  const { getPortfolioNews } = require('./lib/news.js');

  console.log(color(COLORS.bold, '\n💬 养基日记 · 投资助理'));
  console.log(color(COLORS.dim, `  ⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`));
  console.log(color(COLORS.cyan, '\n🤔 你的问题:'), question);

  // ─── 加载打分数据 ───
  console.log(color(COLORS.dim, '\n📊 正在加载持仓数据...'));
  const holdings = holdingsData?.holdings || [];
  const profitMap = holdingsData?.profitPct || {};

  // 快速打分（仅趋势+动量，不拉全量实时数据）
  const { scoreAllFunds } = require('./fund-scoring.js');
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
      yjbApi.fetchAllData(process.env.YJB_ACCOUNT_ID || '').catch(() => null),
      new Promise(r => setTimeout(() => r(null), 6000)),
    ]);
    const yjbH = yjbData?.holdings ? yjbApi.normalizeHoldings(yjbData.holdings) : [];
    yjbH.forEach(h => { yjbMap[h.code] = h; });
  } catch (e) { /* 非阻塞 */ }

  // 并行计算每只基金的MA20
  const { calcMA, countDaysBelowMA } = require('./lib/analytics.js');
  const { httpGet: libHttpGet } = require('./lib/utils.js');
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
      const { generateInsight } = require('./lib/llm.js');
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

main().catch(e => {
  console.error(color(COLORS.red, `\n❌ 运行出错: ${e.message}`));
  process.exit(1);
});
