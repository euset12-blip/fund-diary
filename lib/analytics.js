/**
 * 量化分析模块 — 均线、趋势、技术指标计算
 * 从 fund-assistant.js / fund-scoring.js / server.js / backtest.js 提取
 */

/**
 * 计算均线 — 返回最新 MA 值
 * @param {number[]} arr   - 价格数组（新→旧 或 旧→新，根据 reverse 参数）
 * @param {number} period  - 周期
 * @param {object} [options]
 * @param {boolean} [options.reverse=false]  - arr 是否为旧→新（即需要 slice(-period)）
 * @returns {number|null}
 */
function calcMA(arr, period, options = {}) {
  if (arr.length < period) return null;
  const slice = options.reverse ? arr.slice(-period) : arr.slice(0, period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * 计算完整均线序列（逐日滑动窗口）
 * 返回每个窗口的 MA 值，与输入的尾部对齐
 * @param {number[]} prices  - 价格数组（旧→新）
 * @param {number} period
 * @returns {number[]}  长度 = prices.length - period + 1
 */
function calcMASeries(prices, period) {
  if (prices.length < period) return [];
  const result = [];
  for (let i = period - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j];
    result.push(sum / period);
  }
  return result;
}

/**
 * 从 K 线对象数组提取收盘价
 * @param {Array<{close: number}>} kline
 * @returns {number[]}
 */
function klineToCloses(kline) {
  return kline.map(k => k.close);
}

/**
 * 统计连续低于均线的天数
 * @param {Array<{nav: number}>} navs    - 净值数组（新→旧）
 * @param {number} ma                    - 均线值
 * @returns {number}
 */
function countDaysBelowMA(navs, ma) {
  let count = 0;
  for (let i = 0; i < navs.length; i++) {
    if (navs[i].nav < ma) count++;
    else break; // 一旦回到均线上方就停止计数（连续判定）
  }
  return count;
}

/**
 * 计算日收益率标准差（波动率）— 用于动态阈值
 * @param {Array<{nav: number}>} navs  - 净值数组（旧→新）
 * @param {number} [lookback=90]        - 回看天数
 * @returns {{ stddev: number, mean: number, count: number }|null}
 */
function calcVolatility(navs, lookback = 90) {
  if (!navs || navs.length < Math.max(lookback, 2)) return null;

  const slice = navs.slice(-Math.min(lookback + 1, navs.length));
  // 计算日收益率
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].nav;
    const curr = slice[i].nav;
    if (prev > 0 && curr > 0) {
      returns.push((curr - prev) / prev);
    }
  }
  if (returns.length < 20) return null; // 至少20个有效收益率

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1); // 样本标准差
  const stddev = Math.sqrt(variance);

  return { stddev, mean, count: returns.length };
}

/**
 * 基于波动率计算动态阈值
 * @param {number} volatility    - 日收益率标准差
 * @param {object} [multipliers] - 各信号乘数
 * @returns {{ stopLoss: number, dipBuy: number, takeProfit: number }}
 */
function dynamicThresholds(volatility, multipliers = {}) {
  const m = {
    stopLoss: multipliers.stopLoss || -2.0,   // 止损: -2σ
    dipBuy: multipliers.dipBuy || -1.5,       // 补仓: -1.5σ
    takeProfit: multipliers.takeProfit || 2.5, // 止盈: +2.5σ（向上偏离过多 → 过热）
  };
  return {
    stopLoss: m.stopLoss * volatility * 100,   // 转回百分比
    dipBuy: m.dipBuy * volatility * 100,
    takeProfit: m.takeProfit * volatility * 100,
    dailyVolatility: volatility * 100,         // 日波动率(%)
  };
}

/**
 * 计算 MA 斜率 — 判断趋势方向
 * @param {number[]} prices  - 价格数组（旧→新，至少 period+lookback 条）
 * @param {number} [period=20]   - MA周期
 * @param {number} [lookback=5]  - 回看天数
 * @returns {{ slope: number, trend: 'up'|'down'|'flat', pctPerDay: number }|null}
 */
function calcMASlope(prices, period = 20, lookback = 5) {
  if (prices.length < period + lookback) return null;

  const maSeries = calcMASeries(prices, period);
  if (maSeries.length < lookback + 1) return null;

  const now = maSeries[maSeries.length - 1];
  const prev = maSeries[maSeries.length - 1 - lookback];
  if (!prev || prev <= 0) return null;

  const slope = ((now - prev) / prev) * 100; // 百分比变化
  const pctPerDay = slope / lookback;

  let trend = 'flat';
  if (pctPerDay > 0.02) trend = 'up';        // 日均 > +0.02%
  else if (pctPerDay < -0.02) trend = 'down'; // 日均 < -0.02%

  return { slope: +slope.toFixed(3), trend, pctPerDay: +pctPerDay.toFixed(4) };
}

/**
 * 根据趋势方向调整阈值乘数
 * 上升趋势：止损收紧(更敏感保护利润)、补仓放宽(不怕追涨)、止盈收紧(别卖飞)
 * 下降趋势：止损放宽(给反弹空间)、补仓收紧(不接飞刀)、止盈放宽(早锁定)
 * @param {'up'|'down'|'flat'} trend
 * @param {object} base   - 基础乘数 { stopLoss, dipBuy, takeProfit }
 * @returns {object}       - 调整后的乘数
 */
function trendAdjustedMultipliers(trend, base = {}) {
  const multipliers = { ...base };

  if (trend === 'up') {
    multipliers.stopLoss   = (base.stopLoss || -2) * 0.8;    // 收20%（更容易触发止损保护利润）
    multipliers.dipBuy     = (base.dipBuy || -1.5) * 1.3;    // 放30%（牛跌是机会）
    multipliers.takeProfit = (base.takeProfit || 2.5) * 0.7; // 收30%（别卖飞）
  } else if (trend === 'down') {
    multipliers.stopLoss   = (base.stopLoss || -2) * 1.3;    // 放30%（给反弹空间）
    multipliers.dipBuy     = (base.dipBuy || -1.5) * 0.6;    // 收40%（熊市不接飞刀）
    multipliers.takeProfit = (base.takeProfit || 2.5) * 1.4; // 放40%（早锁定利润）
  }
  // flat — 保持不变

  return multipliers;
}

module.exports = { calcMA, calcMASeries, klineToCloses, countDaysBelowMA, calcVolatility, dynamicThresholds, calcMASlope, trendAdjustedMultipliers };
