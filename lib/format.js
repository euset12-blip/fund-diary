/**
 * 格式化模块 — 金额、百分比、盈亏、柱状图
 * 从 fund-assistant.js 提取
 */

/**
 * 格式化金额（支持万亿/亿/万自动缩进）
 * @param {number} n
 * @returns {string}
 */
function formatMoney(n) {
  if (n == null || isNaN(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toFixed(2);
}

/**
 * 格式化百分比（带正负号）
 * @param {number} n
 * @returns {string}
 */
function formatPercent(n) {
  if (n == null || isNaN(n)) return '--';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/**
 * 格式化盈亏：¥金额 + (百分比%)
 * @param {number} amount
 * @param {number} [pct]
 * @returns {string}
 */
function formatProfit(amount, pct) {
  if (amount == null || isNaN(amount)) return '--';
  const absAmt = Math.abs(amount);
  const amtStr = amount >= 0 ? `+¥${absAmt.toFixed(0)}` : `-¥${absAmt.toFixed(0)}`;
  if (pct != null && !isNaN(pct)) {
    const sign = pct >= 0 ? '+' : '';
    return `${amtStr} (${sign}${pct.toFixed(1)}%)`;
  }
  return amtStr;
}

/**
 * 生成 ASCII 柱状图
 * @param {number} value     - 当前值
 * @param {number} max       - 最大值（用于缩放）
 * @param {number} [width=20] - 柱宽
 * @returns {string}
 */
function barChart(value, max, width = 20) {
  const filled = Math.round((Math.abs(value) / max) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

module.exports = { formatMoney, formatPercent, formatProfit, barChart };
