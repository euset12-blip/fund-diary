/**
 * 养基日记 Web 看板
 * 启动: node server.js
 * 访问: http://localhost:3848
 */

require('dotenv').config();

const express = require('express');
const yjbApi = require('./yjb-api.js');
const { readHoldings } = require('./holdings-io.js');
const { httpGet } = require('./lib/utils.js');
const { calcMA, countDaysBelowMA, calcVolatility, dynamicThresholds, calcMASlope, trendAdjustedMultipliers } = require('./lib/analytics.js');
const { chat } = require('./lib/llm.js');
const { getPortfolioNews } = require('./lib/news.js');
const cron = require('node-cron');
const { exec } = require('child_process');

const app = express();
const PORT = 3848;
const DASHBOARD_URL = process.env.DASHBOARD_URL || `http://localhost:${PORT}`;

app.use(express.json());

// ═══════════════════════════════════════════════════════════
// 定时任务：每个工作日 14:27 自动跑操作建议 + 发邮件
// ═══════════════════════════════════════════════════════════
cron.schedule('27 14 * * 1-5', () => {
  const now = new Date().toLocaleString('zh-CN');
  console.log(`\n⏰ [${now}] 定时分析触发...`);
  exec('node fund-assistant.js --action', { cwd: __dirname, timeout: 300000 }, (err, stdout, stderr) => {
    if (err) {
      console.error(`❌ 定时分析失败: ${err.message}`);
      return;
    }
    console.log(stdout);
    if (stderr) console.error(stderr);
    console.log(`✅ [${new Date().toLocaleString('zh-CN')}] 定时分析完成`);
  });
}, { timezone: 'Asia/Shanghai' });

console.log('⏰ 定时任务已注册: 每个工作日 14:27 自动分析 + 发邮件');

// ─── 静态文件 ───
app.use(express.static(__dirname + '/public'));

// ═══════════════════════════════════════════════════════════
// 养基宝 扫码登录 API（无需 Token）
// ═══════════════════════════════════════════════════════════

// 获取登录二维码
app.get('/api/login/qrcode', async (req, res) => {
  try {
    const data = await yjbApi.fetchQRCode();
    // 用 qrserver 包装成图片 URL（前台直接 <img> 显示）
    const qrImage = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(data.url)}`;
    res.json({ ok: true, qrId: data.id, qrUrl: data.url, qrImage });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 查询扫码状态
app.get('/api/login/check/:qrId', async (req, res) => {
  try {
    const data = await yjbApi.checkQRState(req.params.qrId);
    const state = data.state;
    // state=1 等待扫码 / state=2 成功（token 已由 checkQRState 自动保存）
    if (state === 2 || state === '2') {
      res.json({ ok: true, status: 'done' });
    } else {
      res.json({ ok: true, status: 'waiting' });
    }
  } catch (e) {
    res.json({ ok: false, status: 'error', error: e.message });
  }
});

// 检查是否已登录
app.get('/api/login/status', (req, res) => {
  const token = yjbApi.loadToken();
  res.json({ ok: true, loggedIn: !!token });
});

// ─── 基金历史数据（用于 MA 计算）───
async function getHistoryNav(code, days = 30) {
  try {
    const pages = Math.ceil(days / 20);
    const allData = [];
    for (let p = 1; p <= pages; p++) {
      const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=cb&fundCode=${code}&pageIndex=${p}&pageSize=20`;
      const text = await httpGet(url);
      const m = text.match(/cb\((.*)\)/);
      if (!m) break;
      const json = JSON.parse(m[1]);
      if (!json?.Data?.LSJZList || json.Data.LSJZList.length === 0) break;
      allData.push(...json.Data.LSJZList);
    }
    return allData.reverse().map(d => ({
      date: d.FSRQ,
      nav: parseFloat(d.DWJZ),
      change: parseFloat(d.JZZZL) || 0,
    }));
  } catch (e) { return []; }
}

// ─── API: 看板全量数据 ───
app.get('/api/dashboard', async (req, res) => {
  try {
    // 养基宝数据（8秒超时保护）
    const yjbData = await Promise.race([
      yjbApi.fetchAllData(process.env.YJB_ACCOUNT_ID || '').catch(() => null),
      new Promise(r => setTimeout(() => r(null), 8000)),
    ]);
    const holdings = yjbData?.holdings ? yjbApi.normalizeHoldings(yjbData.holdings) : [];
    const indexData = yjbData?.indexData ? yjbApi.normalizeIndexData(yjbData.indexData) : {};
    const summary = yjbData?.summary || {};

    // 从 holdings-io 读取基金元数据（sector/name 等，来自 fund-config.json）
    const metaHoldings = await readHoldings();
    const metaMap = {};
    metaHoldings.forEach(h => { metaMap[h.code] = h; });

    // 为每只基金计算 MA20 和信号
    const funds = [];
    for (const h of holdings) {
      const hist = await getHistoryNav(h.code, 90); // 90天用于波动率
      const prices = hist.map(d => d.nav);
      const ma20 = calcMA(prices.slice(-20), 20);    // MA20: 最近20天
      const ma5 = calcMA(prices.slice(-5), 5);        // MA5:  最近5天
      const consec = countDaysBelowMA(hist.slice(-30), ma20);

      const meta = metaMap[h.code] || {};
      const sector = meta.sector || '';
      const profitPct = h.totalInvested > 0 ? (h.profitAmount / h.totalInvested * 100) : 0;

      // ─── 波动率动态阈值 ───
      const vol = calcVolatility(hist, 90);

      // 品种基础乘数：QDII波动大放宽，黄金波动中收紧止损
      let baseMultipliers = { stopLoss: -2.0, dipBuy: -1.5, takeProfit: 2.5 };
      if (sector.includes('美股') || sector.includes('QDII')) {
        baseMultipliers = { stopLoss: -2.5, dipBuy: -2.0, takeProfit: 2.0 };
      } else if (sector.includes('黄金')) {
        baseMultipliers = { stopLoss: -1.5, dipBuy: -2.0, takeProfit: 2.5 };
      }

      // MA20 趋势方向 → 动态调整乘数
      const slopeData = calcMASlope(prices, 20, 5);
      const trend = slopeData?.trend || 'flat';
      const adjMultipliers = trendAdjustedMultipliers(trend, baseMultipliers);

      const dyn = dynamicThresholds(vol?.stddev || 0.008, adjMultipliers);
      // fallback: 如果波动率不可用，用日波动 0.8% 作保守估计

      // 计算偏离
      const val = h.valuation || h.nav;
      const devMA20 = ma20 ? ((val - ma20) / ma20 * 100) : null;
      const devMA5 = ma5 ? ((val - ma5) / ma5 * 100) : null;

      // ─── 信号（波动率动态阈值） ───
      let signal = 'neutral', signalLabel = '观望', signalColor = '#8899aa';

      const isGold = sector.includes('黄金');

      // 优先级1：止损 — 偏离超过动态止损线 + 连续破位
      if (isGold && devMA20 && devMA20 < dyn.stopLoss && consec >= 3) {
        signal = 'stop_loss'; signalLabel = '止损'; signalColor = '#e74c3c';
      } else if (isGold && devMA20 && devMA20 < 0 && consec >= 1) {
        signal = 'watch'; signalLabel = '关注'; signalColor = '#f39c12';
      // 优先级2：补仓 — 非黄金，跌破动态补仓线
      } else if (!isGold && devMA20 && devMA20 < dyn.dipBuy) {
        signal = 'dip_buy'; signalLabel = '补仓机会'; signalColor = '#3498db';
      // 优先级3：止盈 — 高盈利 + 趋势转弱，或偏离超过止盈线
      } else if (profitPct >= 15 && devMA20 && devMA20 < 0) {
        signal = 'take_profit'; signalLabel = '止盈'; signalColor = '#f39c12';
      } else if (devMA20 && devMA20 > dyn.takeProfit && profitPct > 5) {
        signal = 'take_profit'; signalLabel = '止盈(过热)'; signalColor = '#f39c12';
      } else if (profitPct >= 30) {
        signal = 'take_profit'; signalLabel = '止盈'; signalColor = '#f39c12';
      // 优先级4：多头持有 — MA20之上 + MA5向上
      } else if (devMA20 && devMA20 > 0 && devMA5 && devMA5 > 0) {
        signal = 'hold'; signalLabel = '持有'; signalColor = '#27ae60';
      // 优先级5：深跌 — 跌破 MA20 超过 2倍止损线
      } else if (devMA20 && devMA20 < dyn.stopLoss * 2) {
        signal = isGold ? 'stop_loss' : 'dip_buy';
        signalLabel = isGold ? '止损' : '补仓机会';
        signalColor = isGold ? '#e74c3c' : '#3498db';
      }

      funds.push({
        code: h.code,
        name: meta.shortName || h.name || h.code,
        sector: meta.sector || '',
        nav: h.nav,
        valuation: val,
        change: h.valuationChange,
        profit: h.profitAmount,
        profitPct: h.totalInvested > 0 ? (h.profitAmount / h.totalInvested * 100) : 0,
        holdAmount: h.holdAmount,
        ma20: ma20 ? +ma20.toFixed(4) : null,
        devMA20: devMA20 ? +devMA20.toFixed(2) : null,
        // 波动率动态阈值（透明度：让用户看到阈值从哪来的）
        volatility: dyn.dailyVolatility ? +dyn.dailyVolatility.toFixed(3) : null,
        thresholdStop: dyn.stopLoss ? +dyn.stopLoss.toFixed(2) : null,
        thresholdDip: dyn.dipBuy ? +dyn.dipBuy.toFixed(2) : null,
        // 趋势环境
        trend,
        maSlopeDaily: slopeData?.pctPerDay != null ? +slopeData.pctPerDay.toFixed(4) : null,
        consec,
        signal,
        signalLabel,
        signalColor,
        strategy: isGold ? 'stop_loss' : 'hold_dip',
      });
    }

    // 汇总
    const totalHoldAmount = funds.reduce((s, f) => s + f.holdAmount, 0);
    const totalProfit = funds.reduce((s, f) => s + f.profit, 0);
    const signals = { stop: funds.filter(f => f.signal === 'stop_loss').length, dip: funds.filter(f => f.signal === 'dip_buy').length, hold: funds.filter(f => f.signal === 'hold').length };

    res.json({
      ok: true,
      time: new Date().toLocaleString('zh-CN'),
      index: indexData,
      summary: {
        todayIncome: parseFloat(summary.today_income) || 0,
        todayRate: parseFloat(summary.today_income_rate) || 0,
        totalAssets: parseFloat(summary.assets_collect) || 0,
      },
      funds,
      signals,
      totalHoldAmount,
      totalProfit,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── AI 投资助理聊天 ───
app.post('/api/chat', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) {
      return res.json({ ok: false, error: '问题不能为空' });
    }

    const holdings = await readHoldings();
    const sharedConfig = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fund-config.json'), 'utf-8'));

    // 拉取养基宝实时估值（8秒超时保护）
    let yjbHoldings = [];
    try {
      const yjbData = await Promise.race([
        yjbApi.fetchAllData(process.env.YJB_ACCOUNT_ID || '').catch(() => null),
        new Promise(r => setTimeout(() => r(null), 8000)),
      ]);
      yjbHoldings = yjbData?.holdings ? yjbApi.normalizeHoldings(yjbData.holdings) : [];
    } catch (e) { /* 养基宝不可用不影响对话 */ }

    // 构建 YJB 估值索引
    const yjbMap = {};
    yjbHoldings.forEach(h => { yjbMap[h.code] = h; });

    // 快速计算每只基金的 MA20 趋势（不拉全量打分，避免慢）
    const fundsWithTrend = await Promise.all(holdings.map(async h => {
      const yjb = yjbMap[h.code] || {};
      const hist = await getHistoryNav(h.code, 30);
      const prices = hist.map(d => d.nav);
      const ma20 = calcMA(prices.slice(-20), 20);
      const val = yjb.valuation || yjb.nav || h.nav;
      const devMA20 = ma20 ? +((val - ma20) / ma20 * 100).toFixed(2) : null;

      return {
        code: h.code,
        name: h.shortName || h.name,
        sector: h.sector,
        nav: yjb.nav || h.nav || 0,
        valuation: val,
        dayChange: yjb.valuationChange != null
          ? `${yjb.valuationChange >= 0 ? '+' : ''}${yjb.valuationChange.toFixed(2)}%` : '?',
        holdAmount: yjb.holdAmount || h.holdAmount || 0,
        profit: yjb.profitAmount != null
          ? `¥${yjb.profitAmount.toFixed(0)}` : (h.profit != null ? `¥${h.profit.toFixed(0)}` : '?'),
        ma20: ma20 ? +ma20.toFixed(4) : null,
        devMA20,
        profitPct: h.totalInvested > 0 ? +((h.profit || 0) / h.totalInvested * 100).toFixed(1) : null,
        strategy: sharedConfig.fundStrategy?.[h.code]?.desc || '?',
      };
    }));

    // 持仓摘要（喂给 DeepSeek 的完整画像）
    const holdingsBrief = fundsWithTrend.map(f => ({
      code: f.code,
      name: f.name,
      sector: f.sector,
      valuation: f.valuation,
      dayChange: f.dayChange,
      holdAmount: f.holdAmount,
      profit: f.profit,
      profitPct: f.profitPct != null ? `${f.profitPct >= 0 ? '+' : ''}${f.profitPct}%` : '?',
      ma20: f.ma20,
      devMA20: f.devMA20 != null ? `${f.devMA20 >= 0 ? '+' : ''}${f.devMA20}%` : null,
      strategy: f.strategy,
    }));

    // 拉取实时资讯
    let newsDigest = '';
    try {
      newsDigest = await getPortfolioNews(holdingsBrief, 3);
    } catch (e) { /* 新闻获取失败不阻塞 */ }

    const answer = await chat({
      question: question.trim(),
      holdings: holdingsBrief,
      newsDigest,
      market: { time: new Date().toLocaleString('zh-CN') },
    });

    res.json({ ok: true, answer });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── 首页 ───
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, () => {
  console.log(`\n📊 养基日记 Web 看板`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   手机: http://<电脑IP>:${PORT}\n`);
});
