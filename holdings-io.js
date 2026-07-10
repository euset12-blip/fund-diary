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
  return raw.map(h => {
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
}

/**
 * Fallback：从 fund-config.json 生成基金列表（无财务数据）
 * 用于养基宝不可用时的降级
 */
function readHoldingsFallback(config) {
  config = config || loadFundConfig();
  return Object.keys(config.fundStrategy || {}).map(code => {
    const map = (config.fundIndexMap || {})[code] || {};
    return {
      code,
      name: map.name || code,
      shortName: map.name || code,
      sector: map.sector || '',
      holdAmount: 0,
      totalInvested: 0,
      profit: 0,
      status: 'holding',
      plannedAction: '',
      notes: '',
      nav: 0,
      valuation: 0,
      valuationChange: 0,
      shares: 0,
    };
  });
}

/**
 * 写入持仓到本地 JSON 文件（养基宝不可写入时用于本地记录）
 */
function writeHoldings(holdings) {
  const filePath = path.join(__dirname, 'holdings.json');
  fs.writeFileSync(filePath, JSON.stringify(holdings, null, 2), 'utf-8');
}

module.exports = { readHoldings, writeHoldings };
