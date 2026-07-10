/**
 * 基础工具模块 — HTTP 请求、JSONP 解析、公共辅助函数
 * 从 fund-assistant.js / fund-scoring.js / server.js / deep-analyze.js 提取
 */

const https = require('https');
const http = require('http');

/**
 * 通用 HTTP GET 请求（支持重试、重定向、自定义 headers）
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.retries=0]   - 重试次数
 * @param {number} [options.retryDelay=500]  - 重试间隔(ms)
 * @param {string} [options.referer]     - Referer 头
 * @param {object} [options.headers]     - 额外请求头
 * @param {number} [options.timeout=10000]  - 超时(ms)
 * @param {boolean} [options.silent=false]  - 静默模式（error 时 resolve null 而非 reject）
 * @returns {Promise<string>}
 */
function httpGet(url, options = {}) {
  const maxRetries = options.retries || 0;
  const retryDelay = options.retryDelay || 500;
  const silent = options.silent || false;

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
        rejectUnauthorized: options.rejectUnauthorized !== undefined ? options.rejectUnauthorized : true,
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
        if (silent) return resolve(null);
        if (attempt < maxRetries) {
          setTimeout(() => doRequest(attempt + 1), retryDelay * (attempt + 1));
        } else {
          reject(e);
        }
      });
      req.on('timeout', () => {
        req.destroy();
        if (silent) return resolve(null);
        if (attempt < maxRetries) {
          setTimeout(() => doRequest(attempt + 1), retryDelay * (attempt + 1));
        } else {
          reject(new Error('HTTP request timeout: ' + url));
        }
      });
      req.end();
    };
    doRequest(0);
  });
}

/**
 * 解析 JSONP 响应
 * 支持格式: jsonpgz({...}), callback({...}), varName={...}, varName=[...]
 * @param {string} text   - 原始响应文本
 * @param {string} [varName]  - 变量名（可选）
 * @returns {object|null}
 */
function parseJSONP(text, varName) {
  if (!text) return null;
  // Try standard JSON first
  try { return JSON.parse(text); } catch (e) {}

  const patterns = [
    /jsonpgz\((\{[\s\S]*?\})\)/,
    /callback\((\{[\s\S]*?\})\)/,
  ];
  if (varName) {
    patterns.push(
      new RegExp(`${varName}\\s*=\\s*(\\{[\\s\\S]*?\\});`),
      new RegExp(`${varName}\\s*=\\s*(\\[[\\s\\S]*?\\]);`)
    );
  }
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      try { return JSON.parse(m[1]); } catch (e) {}
    }
  }
  return null;
}

/**
 * 解析 JavaScript 对象字面量（兼容非标准 JSON 格式）
 * 用正则补全未加引号的 key，再 JSON.parse
 * @param {string} text
 * @returns {object|null}
 */
function parseJSObject(text) {
  try { return JSON.parse(text); } catch (e) {}
  const jsonStr = text.replace(/([{,]\s*)([a-zA-Z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  try { return JSON.parse(jsonStr); } catch (e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A股价格/指数统一除以100（东方财富返回原始价格不含小数点）
 * @param {number|null} raw
 * @param {string} [market]
 * @returns {number|null}
 */
function scalePrice(raw, market) {
  if (raw == null || isNaN(raw)) return raw;
  return raw / 100;
}

module.exports = { httpGet, parseJSONP, parseJSObject, sleep, scalePrice };
