/**
 * LLM 集成模块 — 给你的量化打分加上 AI 解读层
 * 用法:
 *   const { generateInsight } = require('./lib/llm.js');
 *   const aiReport = await generateInsight(scoringData, commands, marketSnapshot);
 */

const https = require('https');

// DeepSeek API（OpenAI 兼容接口）
const API_BASE = 'api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-pro';

/**
 * 调用 LLM 生成投资解读
 * @param {object} params
 * @param {Array} params.results - 评分结果列表
 * @param {Array} params.commands - 操作指令列表
 * @param {object} params.market - 市场快照 { indices, sentiment }
 * @returns {Promise<string>} AI 解读文本，失败返回 null
 */
async function generateInsight({ fundProfiles, commands, market, summary } = {}) {
  if (!API_KEY) {
    console.log('⚠️ 未配置 DEEPSEEK_API_KEY，跳过 AI 解读');
    return null;
  }

  const prompt = buildPrompt({ fundProfiles, commands, market, summary });

  try {
    const response = await chatCompletion(prompt, { maxTokens: 800 });
    return response;
  } catch (e) {
    console.error('⚠️ AI 解读生成失败:', e.message);
    return null;
  }
}

/**
 * 构建 Prompt — 只喂原始数据，让 AI 独立形成判断
 * 不预设信号标签，不告诉 AI "我们认为该止损/补仓"
 * @param {Array} fundProfiles — [{code, name, sector, valuation, valuationChange, nav, profitLoss, profitPct, maData, strategy}]
 * @param {Array} commands      — 仅供 AI 参考"我们内部算法的输出"，不作为结论要求复述
 * @param {object} market       — { indices, sentiment }
 * @param {object} summary      — { totalFunds }
 */
function buildPrompt({ fundProfiles, commands, market, summary }) {
  // ═══ 大盘原始数据 ═══
  const idxLines = [];
  const indices = market?.indices || {};
  for (const key of ['shComp', 'szComp', 'cybComp']) {
    const ix = indices[key];
    if (ix) {
      const s = ix.change >= 0 ? '+' : '';
      idxLines.push(`${ix.name}: ${ix.price?.toFixed(2)} (${s}${ix.change?.toFixed(2)}%)`);
    }
  }
  const sentimentLabel = market?.sentiment === 'panic' ? '暴跌'
    : market?.sentiment === 'risk_off' ? '偏弱'
    : market?.sentiment === 'risk_on' ? '偏强'
    : '中性';

  // ═══ 持仓原始数据（含量化算法对每只基金的判断） ═══
  const sorted = [...(fundProfiles || [])].sort((a, b) => (a.profitLoss || 0) - (b.profitLoss || 0));
  const fundData = sorted.map(f => {
    // 优先用波动率动态信号（与看板一致），兜底用命令推断
    let algoPos = f.algoSignalLabel || f.algoSignal || '持有';
    if (!f.algoSignal) {
      const cmdTypes = (f.commands || []).map(c => c.type);
      if (cmdTypes.some(t => t.includes('stop_loss'))) algoPos = '止损';
      else if (cmdTypes.some(t => t.includes('buy') || t.includes('pullback'))) algoPos = '买入';
      else if (cmdTypes.some(t => t.includes('profit'))) algoPos = '止盈';
      else if (cmdTypes.some(t => t.includes('hold') || t.includes('bullish'))) algoPos = '持有';
      else if (cmdTypes.some(t => t.includes('avoid') || t.includes('break'))) algoPos = '观望';
      else if (cmdTypes.length === 0 && f.profitPct > 0 && f.maData?.devMA20 > 0) algoPos = '持有';
      else if (cmdTypes.length === 0) algoPos = '观望';
    }

    const row = {};
    row['基金'] = `${f.name} (${f.code})`;
    if (f.sector) row['板块'] = f.sector;
    if (f.holdAmount != null) row['持有金额'] = `¥${f.holdAmount.toFixed(0)}`;
    row['净值'] = f.nav?.toFixed(4) || '--';
    if (f.valuation && f.valuation !== f.nav) row['估值'] = f.valuation.toFixed(4);
    if (f.valuationChange != null) {
      const s = f.valuationChange >= 0 ? '+' : '';
      row['日变'] = `${s}${f.valuationChange.toFixed(2)}%`;
    }
    if (f.change1w != null) {
      const s = f.change1w >= 0 ? '+' : '';
      row['近1周'] = `${s}${f.change1w.toFixed(2)}%`;
    }
    if (f.change1m != null) {
      const s = f.change1m >= 0 ? '+' : '';
      row['近1月'] = `${s}${f.change1m.toFixed(2)}%`;
    }
    // 近期净值走势（最近5天，让AI看到价格轨迹）
    if (f.recentNav5 && f.recentNav5.length > 0) {
      row['近5日净值'] = f.recentNav5.map(d => `${d.date.slice(5)}: ${d.nav.toFixed(4)} (${d.change >= 0 ? '+' : ''}${d.change?.toFixed(2) || '0.00'}%)`).join(' → ');
    }
    const pl = f.profitLoss || 0;
    const pp = f.profitPct || 0;
    const sign = pl >= 0 ? '+' : '-';
    row['持仓盈亏'] = `${sign}¥${Math.abs(pl).toFixed(0)} (${sign}${Math.abs(pp).toFixed(1)}%)`;
    if (f.strategy) row['交易策略'] = f.strategy;
    if (f.maData?.ma20) {
      row['MA5'] = f.maData.ma5?.toFixed(4) || '--';
      row['MA10'] = f.maData.ma10?.toFixed(4) || '--';
      row['MA20'] = f.maData.ma20.toFixed(4);
      const dev = f.maData.devMA20;
      if (dev != null) row['vsMA20'] = `${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%`;
      row['均线排列'] = f.maData.alignment || '--';
    }
    if (f.volatility != null) row['年化波动率'] = `${(f.volatility * 100).toFixed(1)}%`;
    if (f.sectorVol) {
      row['关联板块'] = (f.sectorVol.name || '') + ' ' +
        (f.sectorVol.pctChg >= 0 ? '+' : '') + f.sectorVol.pctChg.toFixed(2) + '%' +
        ' 量比' + f.sectorVol.volumeRatio.toFixed(2);
    }
    row['算法判断'] = algoPos;  // 每只基金都标上算法立场
    return row;
  });

  return `你是一个独立判断的量化基金经理，管理一个 ${summary?.totalFunds || fundProfiles?.length || 0} 只基金的组合。风格：趋势跟踪、不猜底不猜顶、果断止损、加仓赢家。

【今日大盘 — 原始数据】
${idxLines.join('\n') || '(暂无)'}
市场状态: ${sentimentLabel}

【全部持仓 — 原始数据 + 算法判断（盈亏排序）】
每只基金的「算法判断」字段是该基金的量化策略当前立场（持有/观望/买入/止损/止盈）。
${JSON.stringify(fundData, null, 1)}

请独立分析以上数据，写一段基金经理晨会解读（200-300字）：

1. 挑出 2-3 个你认为最重要的操作机会，说明理由
2. 跨品种/跨市场的联动模式（哪些板块在共振涨或跌）
3. 一句话风险提示

量价分析参考：
- 量比>1.2 + 板块上涨 = 放量上涨，资金主动买入，趋势健康
- 量比>1.2 + 板块下跌 = 放量下跌，资金出逃，注意风险
- 量比<0.8 + 板块上涨 = 缩量上涨，动能不足，反弹可能不持续
- 量比<0.8 + 板块下跌 = 缩量下跌，正常回调，抛压不大
- 量比在0.8-1.2之间为正常量能
（只有带「关联板块」字段的基金才有量比数据，无此字段的可忽略量价分析）

⚠️ 重要：你是独立判断者。每只基金都有算法的立场标注，但你不必同意它。
「持有」「观望」也是一种判断——如果你认为某只基金不该持有而该止损，那就是分歧。

不虚构数字、不给出具体买卖金额。

【输出格式】
先用自然语言写解读正文（200-300字）。

然后在末尾附一段争议列表。争议包括：
- 算法说持有/观望，你认为该买入/止损/止盈
- 算法说买入，你认为该观望/止损
- 算法说止损/止盈，你认为该持有/加仓
（双方都说止损、都说买入 → 不算争议，不要列）

===DISPUTE===
基金代码|基金名称|算法判断|你的判断|分歧原因（一句话）
===END===

如果你和算法对所有基金的判断完全一致，写 "===DISPUTE=== NONE ===END==="。`;
}

/**
 * OpenAI 兼容的 Chat Completion 调用
 * @param {string} userPrompt
 * @param {object} [opts]
 * @param {string} [opts.system] - 系统提示词（可选，默认基金经理角色）
 * @param {number} [opts.maxTokens=800] - 最大输出 token
 * @param {number} [opts.temperature=0.7]
 */
function chatCompletion(userPrompt, opts = {}) {
  const { system = '你是一个专业的基金经理，给出简洁有力的投资解读。', maxTokens = 800, temperature = 0.7 } = opts;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      max_tokens: maxTokens,
    });

    const req = https.request({
      hostname: API_BASE,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const text = json.choices?.[0]?.message?.content?.trim();
          if (!text) return reject(new Error('Empty response'));
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * 对话模式 — 投资助理回答用户问题
 * @param {object} params
 * @param {string} params.question - 用户问题
 * @param {Array} params.holdings - 持仓摘要 [{code, name, sector, score, profit, strategy}]
 * @param {string} [params.newsDigest] - 实时金融快讯（可选）
 * @param {object} [params.market] - 市场快照（可选）
 * @returns {Promise<string>}
 */
async function chat({ question, holdings, newsDigest, market } = {}) {
  if (!API_KEY) {
    return '⚠️ 未配置 DEEPSEEK_API_KEY，对话模式不可用。请在 .env 中设置。';
  }

  const holdingsBrief = holdings.map(h => ({
    基金: `${h.name} (${h.code})`,
    板块: h.sector,
    估值: h.valuation,
    净值: h.nav,
    日变动: h.dayChange,
    MA20: h.ma20,
    vsMA20偏离: h.devMA20 != null ? `${h.devMA20 >= 0 ? '+' : ''}${h.devMA20}%` : null,
    持仓盈亏: h.profit,
    收益率: h.profitPct || '?',
    持有金额: h.holdAmount,
  }));

  const systemPrompt = `你是养基日记的专属投资助理。你基于用户的真实持仓数据做出独立判断。

核心原则：
1. 你看到的是原始数据（净值、MA20偏离、盈亏、波动率），没有任何预设的操作标签。你需要自己判断每只基金该怎么做
2. 区分"数据事实"和"你的主观判断"，对判断保持谦虚
3. 不推荐具体买卖金额，不做涨跌承诺
4. 用户的投资哲学：趋势跟踪、果断止损、加仓赢家。但你不是复读机——如果数据不支持这个哲学在当下适用，说出来
5. 如果你的判断和用户可能持有的观点不同，指出来并解释
6. 回复末尾可以附一段"行动清单"`;

  const userPrompt = `【我的持仓 — 原始数据】
${JSON.stringify(holdingsBrief, null, 1)}

${market ? `【市场环境】\n${JSON.stringify(market, null, 1)}\n` : ''}
${newsDigest ? `【实时资讯】\n${newsDigest}\n` : ''}
【我的问题】
${question}

请基于以上原始数据独立分析，给出你的看法。`;

  const text = await chatCompletion(userPrompt, { system: systemPrompt, maxTokens: 1000 });
  return text;
}

module.exports = { generateInsight, chat };
