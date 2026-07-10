/**
 * 策略优化器 — 系统回测找到每只基金的最优策略
 *
 * 用法:
 *   node optimize-strategy.js            # 全量回测，找出最优 MA
 *   node optimize-strategy.js --quick     # 快速模式（只测 MA10/20/30）
 */

const https = require('https');
const http = require('http');
const { readHoldings } = require('./holdings-io.js');

// ─── HTTP ───
function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' }}, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function getHistoryNav(code, years = 1) {
  const allData = [];
  for (let p = 1; p <= Math.ceil(years * 250 / 20) + 1; p++) {
    try {
      const text = await fetch(`https://api.fund.eastmoney.com/f10/lsjz?callback=cb&fundCode=${code}&pageIndex=${p}&pageSize=20`);
      const m = text.match(/cb\((.*)\)/);
      if (!m) break;
      const json = JSON.parse(m[1]);
      if (!json?.Data?.LSJZList || json.Data.LSJZList.length === 0) break;
      allData.push(...json.Data.LSJZList);
    } catch (e) { break; }
  }
  return allData.reverse().map(d => ({ date: d.FSRQ, nav: parseFloat(d.DWJZ), change: parseFloat(d.JZZZL) || 0 }));
}

function calcMA(navs, period) {
  if (navs.length < period) return [];
  const result = [];
  for (let i = period - 1; i < navs.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += navs[j].nav;
    result.push({ idx: i, value: sum / period });
  }
  return result;
}

/**
 * 回测 MA 止损策略（从「已持有」开始）
 * 返回 { trades, signals, holding, currentReturn, avoidedLoss, totalReturn }
 */
function backtest(navs, maPeriod, stopDays = 3) {
  const ma = calcMA(navs, maPeriod);
  if (ma.length === 0) return null;

  const trades = [];
  const signals = [];
  let holding = true;
  let buyPrice = navs[maPeriod].nav;
  let buyDate = navs[maPeriod].date;
  let belowCount = 0;

  for (let i = maPeriod + 1; i < navs.length; i++) {
    const price = navs[i].nav;
    const date = navs[i].date;
    const maVal = ma.find(m => m.idx === i)?.value;
    if (!maVal) continue;

    if (holding) {
      if (price < maVal) belowCount++;
      else belowCount = 0;

      if (belowCount >= stopDays) {
        const r = ((price - buyPrice) / buyPrice) * 100;
        const days = Math.round((new Date(date) - new Date(buyDate)) / 86400000);
        trades.push({ buyDate, sellDate: date, buyPrice, sellPrice: price, returnPct: r, holdDays: days, win: r > 0 });
        signals.push({ date, type: 'stop_loss', price, maVal, drawdown: Math.abs(r) });
        holding = false;
        belowCount = 0;
      }
    } else {
      const prevPrice = navs[i - 1].nav;
      const prevMA = ma.find(m => m.idx === i - 1)?.value;
      if (prevPrice < prevMA && price > maVal) {
        holding = true;
        buyPrice = price;
        buyDate = date;
        signals.push({ date, type: 'entry', price, maVal });
      }
    }
  }

  const lastPrice = navs[navs.length - 1].nav;
  const currentReturn = holding ? ((lastPrice - buyPrice) / buyPrice) * 100 : 0;
  const totalReturn = trades.reduce((s, t) => s + t.returnPct, 0) + currentReturn;
  const avoidedLoss = signals.filter(s => s.type === 'stop_loss').reduce((s, sig) => s + sig.drawdown, 0);

  // 同时算买入持有
  const bhReturn = ((navs[navs.length - 1].nav - navs[0].nav) / navs[0].nav) * 100;

  return {
    trades, signals, holding, currentReturn, totalReturn, avoidedLoss, bhReturn,
    winRate: trades.length > 0 ? (trades.filter(t => t.win).length / trades.length * 100) : 0,
    tradeCount: trades.length,
    stopCount: signals.filter(s => s.type === 'stop_loss').length,
  };
}

/**
 * 对一只基金测试多个 MA 周期，找到最优
 */
async function optimizeFund(code, name, sector, years = 1) {
  const navs = await getHistoryNav(code, years);
  if (navs.length < 60) return null;

  const maPeriods = [5, 10, 15, 20, 30, 60];
  const results = [];

  for (const ma of maPeriods) {
    const r = backtest(navs, ma);
    if (r) results.push({ ma, ...r });
  }

  // 按超额收益（vs 买入持有）排名
  results.sort((a, b) => (b.totalReturn - b.bhReturn) - (a.totalReturn - a.bhReturn));

  const best = results[0];
  const worst = results[results.length - 1];
  const bh = best.bhReturn;

  // 策略评级
  const alpha = best.totalReturn - bh;
  let rating, recommendation;
  if (alpha > 10) {
    rating = '⭐⭐⭐⭐⭐';
    recommendation = '强烈推荐使用该策略';
  } else if (alpha > 3) {
    rating = '⭐⭐⭐⭐';
    recommendation = '策略有效，建议采用';
  } else if (alpha > -5) {
    rating = '⭐⭐⭐';
    recommendation = '策略中性，可参考';
  } else if (alpha > -15) {
    rating = '⭐⭐';
    recommendation = '策略效果一般';
  } else {
    rating = '⭐';
    recommendation = '不建议，买入持有更优';
  }

  return {
    code, name, sector,
    bestMA: best.ma,
    bestReturn: best.totalReturn,
    buyHoldReturn: bh,
    alpha,
    winRate: best.winRate,
    tradeCount: best.tradeCount,
    stopCount: best.stopCount,
    avoidedLoss: best.avoidedLoss,
    rating,
    recommendation,
    // 详细数据（调试用）
    allResults: results.slice(0, 3).map(r => ({ ma: r.ma, ret: r.totalReturn.toFixed(2), wr: r.winRate.toFixed(1), trades: r.tradeCount })),
  };
}

// ═════════════════════════════════════════════
// 按基金类型的策略建议
// ═════════════════════════════════════════════
function typeRecommendation(results) {
  const groups = {};
  for (const r of results) {
    if (!r) continue;
    let type = '其他';
    if (r.sector?.includes('美股') || r.name?.includes('纳斯达克') || r.name?.includes('标普')) type = '美股QDII';
    else if (r.sector?.includes('港股')) type = '港股QDII';
    else if (r.sector?.includes('黄金')) type = '黄金';
    else if (r.code === '290008') type = '锂矿/周期';
    else type = 'A股行业/指数';

    if (!groups[type]) groups[type] = [];
    groups[type].push(r);
  }

  console.log('\n📊 分类策略建议\n' + '═'.repeat(60));
  for (const [type, funds] of Object.entries(groups)) {
    const avgMA = Math.round(funds.reduce((s, f) => s + f.bestMA, 0) / funds.length);
    const avgAlpha = funds.reduce((s, f) => s + f.alpha, 0) / funds.length;
    const names = funds.map(f => f.name || f.code).slice(0, 3).join(', ');
    const verdict = avgAlpha > 3 ? '✅ MA策略有效' : avgAlpha > -5 ? '⚠️ 效果中性' : '❌ 买入持有更优';

    console.log(`\n  ${type} (${funds.length}只): ${names}...`);
    console.log(`  推荐 MA: ${avgMA}  |  平均超额: ${avgAlpha >= 0 ? '+' : ''}${avgAlpha.toFixed(1)}%`);
    console.log(`  结论: ${verdict}`);
  }
}

// ═════════════════════════════════════════════
// 主函数
// ═════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const years = 1;

  const holdings = await readHoldings();
  console.log(`🔬 策略优化器 — 回测 ${holdings.length} 只基金 (${years}年)\n`);

  const results = [];
  for (let i = 0; i < holdings.length; i++) {
    const h = holdings[i];
    const name = h.shortName || h.name;
    process.stdout.write(`  [${i + 1}/${holdings.length}] ${name.padEnd(16)} `);

    const r = await optimizeFund(h.code, name, h.sector, years);
    if (r) {
      results.push(r);
      console.log(`MA${r.bestMA} ${r.bestReturn >= 0 ? '+' : ''}${r.bestReturn.toFixed(1)}%  vs BH ${r.buyHoldReturn >= 0 ? '+' : ''}${r.buyHoldReturn.toFixed(1)}%  ${r.rating}`);
    } else {
      console.log('数据不足');
    }
  }

  // ─── 排名 ───
  results.sort((a, b) => b.alpha - a.alpha);

  console.log('\n' + '═'.repeat(75));
  console.log('🏆 策略优化结果排名 (按超额收益)');
  console.log('═'.repeat(75));

  console.log(`\n  ${'基金'.padEnd(16)} ${'板块'.padEnd(10)} ${'最优MA'.padEnd(8)} ${'策略收益'.padEnd(10)} ${'持有收益'.padEnd(10)} ${'超额'.padEnd(8)} ${'胜率'.padEnd(8)} ${'评级'}`);
  console.log(`  ${'─'.repeat(72)}`);

  for (const r of results) {
    const aSign = r.alpha >= 0 ? '+' : '';
    console.log(`  ${r.name.padEnd(16)} ${(r.sector || '').padEnd(10)} MA${String(r.bestMA).padEnd(6)} ${(r.bestReturn >= 0 ? '+' : '') + r.bestReturn.toFixed(1) + '%'.padEnd(8)} ${(r.buyHoldReturn >= 0 ? '+' : '') + r.buyHoldReturn.toFixed(1) + '%'.padEnd(8)} ${aSign + r.alpha.toFixed(1) + '%'.padEnd(6)} ${r.winRate.toFixed(0) + '%'.padEnd(8)} ${r.rating}`);
  }

  // ─── 总结 ───
  const validResults = results.filter(r => r);
  const avgAlpha = validResults.reduce((s, r) => s + r.alpha, 0) / validResults.length;
  const goodFunds = validResults.filter(r => r.alpha > 0);
  const avgBestMA = Math.round(validResults.reduce((s, r) => s + r.bestMA, 0) / validResults.length);

  console.log(`\n📌 总体结论:`);
  console.log(`  平均最优 MA: ${avgBestMA} 日`);
  console.log(`  策略平均超额: ${avgAlpha >= 0 ? '+' : ''}${avgAlpha.toFixed(1)}%`);
  console.log(`  策略优于持有的基金: ${goodFunds.length}/${validResults.length}`);

  // 分类建议
  typeRecommendation(validResults);

  console.log(`\n💡 建议: 将 fund-assistant.js 的默认 MA 调整为 ${avgBestMA}，并按基金类型差异化设置。\n`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
