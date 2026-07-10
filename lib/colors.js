/**
 * 终端颜色模块 — 统一定义 ANSI 颜色常量与辅助函数
 * 从 fund-assistant.js / fund-scoring.js / scan-sectors.js 提取
 */

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function c(color, text) {
  return `${color}${text}${COLORS.reset}`;
}

/**
 * 判断当前是否为 A 股交易时段（北京时间）
 * @returns {boolean}
 */
function isTradingHours() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // 周末

  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeInMin = hour * 60 + minute;

  // A股交易时间 9:30-11:30, 13:00-15:00
  if (timeInMin >= 9 * 60 + 30 && timeInMin <= 11 * 60 + 30) return true;
  if (timeInMin >= 13 * 60 && timeInMin <= 15 * 60) return true;
  return false;
}

module.exports = { COLORS, c, isTradingHours };
