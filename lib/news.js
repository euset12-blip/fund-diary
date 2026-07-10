/**
 * 金融快讯模块 — 获取实时财经新闻、个股公告、行业动态
 * 用法:
 *   const { getHeadlines, getStockNews } = require('./lib/news.js');
 *   const headlines = await getHeadlines(20);
 *   const stockNews = await getStockNews('黄金');
 */

const { httpGet } = require('./utils.js');

/**
 * 获取财经快讯头条（东方财富 24 小时滚动）
 * @param {number} [count=20] - 条数（max 50）
 * @returns {Promise<Array<{title: string, time: string, source: string}>>}
 */
async function getHeadlines(count = 20) {
  try {
    // 东方财富快讯 API（免费、无需 Key）
    const url = `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`;
    const text = await httpGet(url, { timeout: 8000, silent: true });
    if (!text) return [];

    // 解析 JSON（可能是 JSONP 或标准 JSON）
    let json = null;
    try { json = JSON.parse(text); } catch (e) {
      const m = text.match(/ajaxResult_\d+_\d+_\((.*)\)/);
      if (m) try { json = JSON.parse(m[1]); } catch (e2) {}
    }
    if (!json?.LivesList) return [];

    return json.LivesList
      .slice(0, count)
      .map(item => ({
        title: item.title || item.digest || '',
        time: item.showtime || item.createtime || '',
        source: '东方财富',
      }));
  } catch (e) {
    return [];
  }
}

/**
 * 搜索与关键词相关的财经新闻
 * @param {string} keyword - 关键词（如"黄金"、"纳斯达克"、"半导体"）
 * @param {number} [count=10]
 * @returns {Promise<Array<{title: string, time: string, url: string}>>}
 */
async function searchNews(keyword, count = 10) {
  try {
    const encoded = encodeURIComponent(keyword);
    const url = `https://searchapi.eastmoney.com/bussiness/Web/GetCMSSearchResult?type=8196&pageindex=1&pagesize=${count}&keyword=${encoded}&name=zixun`;
    const text = await httpGet(url, { timeout: 8000, silent: true, referer: 'https://so.eastmoney.com/' });
    if (!text) return [];

    const json = JSON.parse(text);
    if (!json?.Data) return [];

    return json.Data.map(item => ({
      title: item.Title || item.title || '',
      time: item.ShowTime || item.Date || '',
      url: item.Url || item.url || '',
    }));
  } catch (e) {
    return [];
  }
}

/**
 * 批量获取与持仓相关的所有新闻
 * @param {Array<{name: string, sector: string}>} holdings - 持仓列表
 * @param {number} [perHolding=3] - 每只持仓取几条
 * @returns {Promise<string>} 合并后的新闻文本（精简，给 LLM 用）
 */
async function getPortfolioNews(holdings = [], perHolding = 3) {
  // 提取关键搜索词：基金名称 + 板块名
  const keywords = new Set();
  for (const h of holdings) {
    if (h.sector) keywords.add(h.sector);
    if (h.name) keywords.add(h.name);
  }

  // 加上一些通用金融关键词
  const extraKeys = ['A股', '美股', '港股', '黄金', '央行', '美联储'];
  for (const k of extraKeys) keywords.add(k);

  // 限制搜索数量
  const keyArr = [...keywords].slice(0, 8);

  const allResults = [];
  for (const kw of keyArr) {
    try {
      const results = await searchNews(kw, perHolding);
      for (const r of results) {
        // 去重
        if (!allResults.find(x => x.title === r.title)) {
          allResults.push(r);
        }
      }
    } catch (e) {
      // skip failed keywords
    }
  }

  // 去重 + 排序（最新在前）+ 限制总数
  const unique = [];
  const seen = new Set();
  for (const r of allResults) {
    if (!seen.has(r.title)) {
      seen.add(r.title);
      unique.push(r);
    }
  }

  return unique
    .slice(0, 20)
    .map(r => `· ${r.title} (${r.time?.slice(0, 10) || '?'})`)
    .join('\n');
}

module.exports = { getHeadlines, searchNews, getPortfolioNews };
