/**
 * 日志模块 — 基于 winston + daily rotate
 * 用法:
 *   const log = require('./lib/logger.js')('module-name');
 *   log.info('数据获取成功', { code: '006479' });
 *   log.warn('数据源降级', { from: '养基宝', to: '天天基金' });
 *   log.error('请求失败', { url, error: e.message });
 */

const { createLogger, format, transports } = require('winston');
const path = require('path');
require('winston-daily-rotate-file');

const LOG_DIR = path.join(__dirname, '..', 'logs');

/** @type {Object<string, import('winston').Logger>} */
const cache = {};

/**
 * @param {string} module - 模块名（如 'fund-scoring', 'fund-assistant'）
 * @returns {import('winston').Logger}
 */
function getLogger(module) {
  if (cache[module]) return cache[module];

  const logger = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: format.combine(
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      format.errors({ stack: true }),
      process.env.NODE_ENV === 'production'
        ? format.json()
        : format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `${timestamp} [${level.toUpperCase()}] [${module}] ${message}${metaStr}`;
          })
    ),
    transports: [
      // 控制台输出
      new transports.Console({
        format: format.combine(
          format.colorize(),
          format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `${timestamp} ${level} [${module}] ${message}${metaStr}`;
          })
        ),
      }),
      // 每日轮转日志文件
      new transports.DailyRotateFile({
        dirname: LOG_DIR,
        filename: `${module}-%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        maxSize: '10m',
        maxFiles: '30d',
        format: format.combine(
          format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          format.json()
        ),
      }),
    ],
  });

  cache[module] = logger;
  return logger;
}

module.exports = getLogger;
