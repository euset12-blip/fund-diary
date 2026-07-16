/**
 * 养基宝 API 客户端 (Node.js)
 *
 * 提供：
 * - 账户真实持仓 + 实时估值
 * - 大盘指数行情
 * - 账户收益概览
 *
 * Token 保存在 ~/.yjb_token.json（与 Python 版 yjb-api 共享）
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── 配置 ───
const API_BASE = 'http://browser-plug-api.yangjibao.com';
const SECRET = process.env.YJB_API_SECRET || 'YxmKSrQR4uoJ5lOoWIhcbd7SlUEh9OOc';
const TOKEN_FILE = path.join(os.homedir(), '.yjb_token.json');

// ─── Token 管理 ───
function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    return data.token || null;
  } catch (e) {
    return null;
  }
}

// ─── 签名 ───
function generateSign(apiPath, token, timestamp) {
  const signPath = apiPath.split('?')[0];
  const raw = '' + signPath + (token || '') + timestamp + SECRET;
  return crypto.createHash('md5').update(raw).digest('hex');
}

// ─── HTTP 请求 ───
function apiRequest(method, apiPath) {
  return new Promise((resolve, reject) => {
    const token = loadToken();
    if (!token) {
      return reject(new Error('未登录养基宝，请先运行: python yjb_tool.py --login'));
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const sign = generateSign(apiPath, token, timestamp);

    const u = new URL(API_BASE + apiPath);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Request-Time': String(timestamp),
        'Request-Sign': sign,
        'Authorization': token,
        'User-Agent': 'yjb-api-js/1.0',
      },
      timeout: 15000,
    };

    const client = u.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.code !== 200) {
            if (json.code === 401) {
              return reject(new Error('Token 已过期，请重新登录'));
            }
            return reject(new Error(json.message || `API 错误 code=${json.code}`));
          }
          resolve(json.data);
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`网络错误: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// ═══════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════

/**
 * 获取大盘指数行情
 * @returns {Object} { '1.000001': { v, dir }, ... }
 */
async function getIndexData() {
  return apiRequest('GET', '/index_data');
}

/**
 * 获取账户汇总收益
 * @returns {Object} { today_income, today_income_rate, ... }
 */
async function getAccountSummary() {
  return apiRequest('GET', '/account_collect');
}

/**
 * 获取账户列表
 * @returns {Array} 账户列表
 */
async function getAccounts() {
  const data = await apiRequest('GET', '/user_account');
  return data.list || [];
}

/**
 * 获取指定账户的基金持仓（含实时估值）
 * @param {string} accountId - 账户 ID
 * @returns {Array} 持仓列表，每项含:
 *   code, short_name, hold_share, last_net (最新净值),
 *   nv_info.gsz (实时估值), nv_info.gszzl (估值涨跌%),
 *   hold_earn (持仓收益)
 */
async function getFundHoldings(accountId) {
  return apiRequest('GET', `/fund_hold?account_id=${accountId}`);
}

/**
 * 获取收益曲线数据
 * @returns {Object} { collect: { line_list, day } }
 */
async function getIncomeChart() {
  return apiRequest('GET', '/income_line_data?collect=true&date_type=day');
}

/**
 * 搜索基金
 * @param {string} keyword - 基金代码或名称
 */
async function searchFund(keyword) {
  return apiRequest('GET', `/search_fund?keyword=${encodeURIComponent(keyword)}`);
}

/**
 * 一站式：获取持仓 + 指数 + 收益汇总
 * 用于 fund-assistant.js 的全量数据入口
 *
 * @param {string} accountId - 支付宝账户 ID（通过环境变量 YJB_ACCOUNT_ID 设置）
 * @returns {Object} { indexData, summary, holdings }
 */
async function fetchAllData(accountId = '') {
  const [indexData, summary, holdings] = await Promise.all([
    getIndexData().catch(() => null),
    getAccountSummary().catch(() => null),
    getFundHoldings(accountId).catch(() => null),
  ]);

  return { indexData, summary, holdings };
}

/**
 * 将养基宝持仓数据转换为 fund-assistant.js 兼容的估值格式
 * @param {Array} yjbHoldings - 养基宝持仓数据
 * @returns {Array} [{ code, name, nav, valuation, valuationChange, profitAmount }]
 */
function normalizeHoldings(yjbHoldings) {
  if (!yjbHoldings || !Array.isArray(yjbHoldings)) return [];

  return yjbHoldings.map(h => {
    const nvInfo = h.nv_info || {};
    // 实时估值：优先用 vgsz/vgszzl (新版字段)，fallback gsz/gszzl (旧版)
    const gszRaw = nvInfo.vgsz || nvInfo.gsz || '';
    const gszzlRaw = nvInfo.vgszzl || nvInfo.gszzl || '';
    const gsz = parseFloat(gszRaw) || 0;
    const gszzl = parseFloat(gszzlRaw) || 0;
    const nav = parseFloat(h.last_net) || 0;            // 最新净值
    const shares = parseFloat(h.hold_share) || 0;
    const earn = parseFloat(h.hold_earn) || 0;          // 持仓收益

    // 推算投入本金 = 持有份额 × 当前净值 - 持仓收益
    const holdAmount = shares * nav;
    const totalInvested = holdAmount - earn;

    return {
      code: h.code,
      name: h.short_name || h.name || '',
      nav,
      valuation: gsz || nav,           // 无实时估值时用净值
      valuationChange: gszzl,
      shares,
      holdAmount: Math.round(holdAmount * 100) / 100,
      totalInvested: Math.round(totalInvested * 100) / 100,
      profitAmount: earn,
    };
  });
}

/**
 * 将养基宝指数数据转为 fund-assistant 兼容格式
 */
function normalizeIndexData(yjbIndexData) {
  if (!yjbIndexData) return {};
  const map = {
    '1.000001': { name: '上证指数' },
    '1.000300': { name: '沪深300' },
    '0.399001': { name: '深证成指' },
    '0.399006': { name: '创业板指' },
  };

  const result = {};
  for (const [code, info] of Object.entries(map)) {
    const item = yjbIndexData[code];
    if (item) {
      result[code] = {
        name: info.name,
        price: parseFloat(item.v) || 0,
        change: parseFloat(item.dir) || 0,       // 涨跌幅（已经是百分比数值）
      };
    }
  }
  return result;
}

module.exports = {
  loadToken,
  getIndexData,
  getAccountSummary,
  getAccounts,
  getFundHoldings,
  getIncomeChart,
  searchFund,
  fetchAllData,
  normalizeHoldings,
  normalizeIndexData,
  TOKEN_FILE,
};
