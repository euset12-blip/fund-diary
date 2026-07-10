/**
 * 板块量比数据 — 东方财富概念板块 API
 *
 * 提供每只基金的关联板块量价信号：
 *   - volumeRatio (f10): 量比（vs 5日均量），>1 放量 <1 缩量
 *   - turnover (f6): 成交额
 *   - pctChg (f3): 板块涨跌幅%
 *
 * 用法:
 *   const { fetchSectorVolume } = require('./sector-volume');
 *   const vol = await fetchSectorVolume(['BK1036', 'BK1303']);
 *   // { 'BK1036': { volumeRatio: 1.25, turnover: 123456, pctChg: 2.17 }, ... }
 */

const http = require('http');

// ─── 缓存 ───
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 1 分钟缓存

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*',
      },
      timeout: 10_000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse: ' + body.substring(0, 200))); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 拉全量概念板块 → 按需筛选 BK 码
 * @param {string[]} bkCodes - 需要的 BK 码列表
 * @returns {Object} { BK1036: { volumeRatio, turnover, pctChg, name }, ... }
 */
async function fetchSectorVolume(bkCodes) {
  if (!bkCodes || bkCodes.length === 0) return {};

  // 命中缓存
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) {
    return pickFromCache(bkCodes);
  }

  // f3=涨跌幅, f6=成交额, f10=量比, f12=代码, f14=名称
  const url = 'http://push2his.eastmoney.com/api/qt/clist/get' +
    '?fid=f3&po=1&pz=500&pn=1&np=1&fltt=2&invt=2' +
    '&fs=m:90+t:2' +
    '&fields=f3,f6,f10,f12,f14';

  const data = await getJSON(url);

  if (!data.data || !data.data.diff) {
    console.error('[sector-volume] 东方财富板块 API 返回异常:', JSON.stringify(data).substring(0, 200));
    return {};
  }

  // 构建 code → info 映射
  const map = {};
  data.data.diff.forEach(d => {
    map[d.f12] = {
      volumeRatio: parseFloat(d.f10) || 0,
      turnover: parseFloat(d.f6) || 0,
      pctChg: parseFloat(d.f3) || 0,
      name: d.f14 || '',
    };
  });

  _cache = map;
  _cacheTime = now;

  return pickFromCache(bkCodes);
}

function pickFromCache(bkCodes) {
  const result = {};
  bkCodes.forEach(code => {
    if (_cache[code]) {
      result[code] = _cache[code];
    }
  });
  return result;
}

/**
 * 量比 → 文字解读
 * @param {number} ratio - 量比
 * @returns {string}
 */
function describeVolume(ratio) {
  if (ratio >= 2.0) return '巨量';
  if (ratio >= 1.5) return '明显放量';
  if (ratio >= 1.2) return '放量';
  if (ratio >= 0.8) return '正常';
  if (ratio >= 0.5) return '缩量';
  return '地量';
}

/**
 * 量价配合信号
 * @param {number} pctChg - 板块涨跌幅%
 * @param {number} volumeRatio - 量比
 * @returns {{ signal: string, level: 'bullish'|'neutral'|'bearish', desc: string }}
 */
function volumePriceSignal(pctChg, volumeRatio) {
  const up = pctChg > 0.3;
  const down = pctChg < -0.3;
  const heavyVol = volumeRatio >= 1.2;
  const lightVol = volumeRatio <= 0.8;

  if (up && heavyVol)  return { signal: '📈', level: 'bullish', desc: '放量上涨 — 资金主动买入，趋势健康' };
  if (up && lightVol)  return { signal: '⚠️', level: 'neutral', desc: '缩量上涨 — 动能不足，反弹可能不持续' };
  if (down && heavyVol) return { signal: '🔴', level: 'bearish', desc: '放量下跌 — 资金出逃，注意风险' };
  if (down && lightVol) return { signal: '⚪', level: 'neutral', desc: '缩量下跌 — 正常回调，抛压不大' };
  return { signal: '➖', level: 'neutral', desc: '量价正常' };
}

module.exports = {
  fetchSectorVolume,
  describeVolume,
  volumePriceSignal,
};
