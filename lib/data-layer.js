/**
 * 数据层 — 统一数据获取入口
 * 所有网络请求、养基宝 API、东方财富数据源都从这里走
 *
 * 第 1 刀（已完成）：账户 ID 收口
 * 第 2 刀（本文件）：所有数据获取函数从 fund-assistant-app.js 搬入
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseJSONP, sleep, scalePrice } = require('./utils.js');
const yjbApi = require('../yjb-api.js');

// ═══════════════════════════════════════════════════════════
// 配置（只读 fund-config.json 中数据层需要的字段）
// ═══════════════════════════════════════════════════════════
const ROOT_DIR = path.join(__dirname, '..');
const sharedConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'fund-config.json'), 'utf-8'));
  } catch (e) {
    console.error('❌ [data-layer] 无法加载 fund-config.json:', e.message);
    process.exit(1);
  }
})();

const DC = {
  requestDelay: 200,
  fundIndexMap: sharedConfig.fundIndexMap || {},
};

// ═══════════════════════════════════════════════════════════
// 账户 ID
// ═══════════════════════════════════════════════════════════
function getYjbAccountId() {
  return process.env.YJB_ACCOUNT_ID || '';
}

function fetchYjbData(accountId = getYjbAccountId()) {
  return yjbApi.fetchAllData(accountId);
}

// ═══════════════════════════════════════════════════════════
// HTTP 工具（fund-assistant 专版：支持重试、redirect 跟随）
// ═══════════════════════════════════════════════════════════
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
// 持仓加载 — holdings-io.js 封装
// ═══════════════════════════════════════════════════════════
const { readHoldings: loadHoldingsFromFile } = require('../holdings-io.js');

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

    console.log(`📋 已加载持仓: ${holdings.length} 只基金 (来源: ${holdings._source || '养基宝'})`);
    return { holdings, watchlist, profitLoss, profitPct, lastUpdated: new Date().toISOString().slice(0, 10) };
  } catch (e) {
    console.warn(`⚠️ 读取持仓失败: ${e.message}，使用 fund-config.json 默认持仓`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 基金数据获取
// ═══════════════════════════════════════════════════════════

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
      changePercent: (d.f170 || 0) / 100,
      change: (d.f169 || 0) / 100,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 备选数据源：新浪财经基金估值 API
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
 */
async function estimateFundFromIndex(code, historyNav) {
  const mapping = DC.fundIndexMap[code];
  if (!mapping || !historyNav || historyNav.length === 0) return null;

  const idxData = await getIndexChange(mapping.secid);
  if (!idxData || idxData.changePercent == null) return null;

  const latestNav = historyNav[0].nav;
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
      await sleep(DC.requestDelay);
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

    const { parseJSObject } = require('./utils.js');
    const data = parseJSObject(m[1]);
    if (!data || !data.content) return [];
    const html = data.content;
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

// ═══════════════════════════════════════════════════════════
// 股票/板块数据获取
// ═══════════════════════════════════════════════════════════

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

module.exports = {
  getYjbAccountId,
  fetchYjbData,
  yjbApi,
  httpGet,
  loadHoldings,
  getFundValuation,
  getIndexChange,
  getFundValuationSina,
  estimateFundFromIndex,
  getFundHistoryNav,
  getFundHoldings,
  getStockQuote,
  getStockIndustry,
  getStockKline,
  getSectorQuote,
};
