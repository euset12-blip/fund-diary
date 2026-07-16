/**
 * 持仓数据 I/O — 养基宝 API 为主，fund-config.json 补充元数据
 *
 * 所有持仓数据来自支付宝养基宝账户，实时准确。
 * sector/name 等元数据从 fund-config.json 的 fundIndexMap 补充。
 * 养基宝不可用时 fallback 到 fund-config.json 基金列表（财务数据为空）。
 */
const fs = require('fs');
const path = require('path');
const yjbApi = require('./yjb-api.js');

let _fundConfig = null;

function loadFundConfig() {
  if (!_fundConfig) {
    _fundConfig = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fund-config.json'), 'utf-8'
    ));
  }
  return _fundConfig;
}

/**
 * 读取持仓 — 养基宝 API（异步）
 * @returns {Promise<Array>} holdings 数组，字段兼容旧 CSV 格式 + 养基宝扩展
 */
async function readHoldings() {
  const config = loadFundConfig();

  // 尝试从养基宝获取
  let yjbData;
  try {
    yjbData = await yjbApi.fetchAllData('');
  } catch (e) {
    console.warn('⚠️ 养基宝不可用，使用 fund-config.json 基金列表（财务数据为空）:', e.message);
    return readHoldingsFallback(config);
  }

  if (!yjbData || !yjbData.holdings || yjbData.holdings.length === 0) {
    console.warn('⚠️ 养基宝账户无持仓数据');
    return readHoldingsFallback(config);
  }

  const raw = yjbApi.normalizeHoldings(yjbData.holdings);
  const result = raw.map(h => {
    const map = (config.fundIndexMap || {})[h.code] || {};
    return {
      code: h.code,
      name: map.name || h.name,
      shortName: h.name,                    // 养基宝返回的就是简称
      sector: map.sector || '',
      holdAmount: h.holdAmount,
      totalInvested: h.totalInvested,
      profit: h.profitAmount,
      status: 'holding',
      plannedAction: '',
      notes: '',
      // 养基宝扩展字段
      nav: h.nav,
      valuation: h.valuation,
      valuationChange: h.valuationChange,
      shares: h.shares,
    };
  });
  result._source = '养基宝';
  return result;
}

/**
 * Fallback：从 fund-config.json 生成基金列表（无财务数据）
 * 用于养基宝不可用时的降级
 */
function readHoldingsFallback(config) {
  // 不返回 fund-config.json 的基金列表 — 那是开发者个人的持仓，
  // 对别人毫无意义。返回空数组，让上层提示用户登录养基宝。
  console.warn('💡 请先登录养基宝获取你的真实持仓：python yjb-api/yjb_tool.py --login');
  const result = [];
  result._source = '未登录养基宝';
  return result;
}

/**
 * 写入持仓到本地 JSON 文件（养基宝不可写入时用于本地记录）
 */
function writeHoldings(holdings) {
  const filePath = path.join(__dirname, 'holdings.json');
  fs.writeFileSync(filePath, JSON.stringify(holdings, null, 2), 'utf-8');
}

/**
 * 归一化单条持仓数据 — 补充 name/sector 元数据 + 统一字段
 * @param {Object} raw - 原始持仓数据 { code, name?, shortName?, holdAmount, totalInvested, profit?, profitAmount? }
 * @param {Object} config - fund-config 对象 { fundIndexMap: { [code]: { name, sector } } }
 * @returns {Object} 归一化后 { code, name, sector, holdAmount, totalInvested, profit, profitLoss }
 */
function normalizeHolding(raw, config) {
  const map = ((config && config.fundIndexMap) || {})[raw.code] || {};
  const holdAmount = parseFloat(raw.holdAmount) || 0;
  const totalInvested = parseFloat(raw.totalInvested) || 0;

  // profit 来源优先级: profit > profitAmount > (holdAmount - totalInvested)
  let profit;
  if (raw.profit !== undefined && raw.profit !== null) {
    profit = parseFloat(raw.profit);
  } else if (raw.profitAmount !== undefined && raw.profitAmount !== null) {
    profit = parseFloat(raw.profitAmount);
  } else {
    profit = Math.round((holdAmount - totalInvested) * 100) / 100;
  }

  return {
    code: raw.code,
    name: map.name || raw.name || raw.shortName || raw.code,
    sector: map.sector || '',
    holdAmount,
    totalInvested,
    profit,
    profitLoss: profit,   // legacy alias
  };
}

module.exports = { readHoldings, writeHoldings, normalizeHolding };
