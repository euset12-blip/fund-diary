// 深度分析脚本 - 对指定基金做深度趋势分析
// 基金列表从 养基宝 + fund-config.json 读取，也可以通过命令行参数指定基金代码
const { readHoldings } = require('./holdings-io.js');
const { httpGet, parseJSONP } = require('./lib/utils.js');

async function analyzeFund(code, name) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${name} (${code})`);
  console.log('='.repeat(60));

  const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=cb&fundCode=${code}&pageIndex=1&pageSize=30`;
  const text = await httpGet(url);
  const data = parseJSONP(text, 'cb');
  if (!data?.Data?.LSJZList) {
    console.log('数据获取失败');
    return;
  }

  const list = data.Data.LSJZList.reverse();
  const navs = list.map(x => parseFloat(x.DWJZ));
  const dates = list.map(x => x.FSRQ);

  const latest = navs[navs.length - 1];
  const first = navs[0];
  const high30 = Math.max(...navs);
  const low30 = Math.min(...navs);
  const ma5 = navs.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma10 = navs.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma20 = navs.length >= 20 ? navs.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;

  console.log(`最新净值: ${latest}`);
  console.log(`30日最高: ${high30}  30日最低: ${low30}`);
  console.log(`从最高回撤: ${((1 - latest / high30) * 100).toFixed(1)}%`);
  console.log(`从最低反弹: ${((latest / low30 - 1) * 100).toFixed(1)}%`);
  console.log(`MA5: ${ma5.toFixed(4)} (${((latest/ma5 - 1) * 100).toFixed(1)}%)`);
  console.log(`MA10: ${ma10.toFixed(4)} (${((latest/ma10 - 1) * 100).toFixed(1)}%)`);
  if (ma20) console.log(`MA20: ${ma20.toFixed(4)} (${((latest/ma20 - 1) * 100).toFixed(1)}%)`);
  console.log(`30日总涨跌: ${((latest - first) / first * 100).toFixed(1)}%`);

  // 趋势判断
  let signal = '';
  if (latest < ma5 && ma5 < ma10) signal = '🔴 空头排列，仍在下跌趋势中';
  else if (latest > ma5 && ma5 < ma10) signal = '🟡 短期可能止跌，但中期趋势仍未反转';
  else if (latest > ma5 && ma5 > ma10) signal = '🟢 短期企稳，出现反弹信号';
  else signal = '🟡 趋势不明朗';
  console.log(`趋势判断: ${signal}`);

  // 关键问题：是否接近底部？
  const drawdown = (1 - latest / high30) * 100;
  const rebound = (latest / low30 - 1) * 100;
  if (drawdown > 20 && rebound < 3) {
    console.log('⚠️ 从高点已跌超20%，且未出现有效反弹');
    console.log('   可能的底部特征：需观察是否放量企稳');
  } else if (drawdown > 30) {
    console.log('⚠️ 跌幅已深(>30%)，技术上存在超跌反弹需求');
    console.log('   但需基本面配合，否则可能继续阴跌');
  }

  // 近10日明细
  console.log('\n近10日净值:');
  list.slice(-10).forEach(x => {
    const chg = parseFloat(x.JZZZL);
    const sign = chg >= 0 ? '+' : '';
    const bar = chg >= 0 ? '🔴' : '🟢';
    console.log(`  ${x.FSRQ}  ${x.DWJZ}  ${bar} ${sign}${chg}%`);
  });

  return { code, name, latest, ma5, ma10, ma20, drawdown, signal };
}

async function main() {
  const args = process.argv.slice(2);

  // 加载持仓
  const holdings = await readHoldings();
  console.log(`📋 已加载 ${holdings.length} 只基金\n`);

  // 决定分析哪些基金
  let targets = [];

  const argCodes = args.filter(a => /^\d{6}$/.test(a));
  if (argCodes.length > 0) {
    // 用户指定了基金代码
    targets = argCodes.map(code => {
      const h = holdings.find(hh => hh.code === code);
      return [code, h ? `${h.shortName || h.name} (${h.sector})` : `基金${code}`];
    });
  } else if (args.includes('--all')) {
    // 全量分析
    targets = holdings.map(h => [h.code, `${h.shortName || h.name} (${h.sector})`]);
  } else if (args.includes('--loss') || args.includes('--losers')) {
    // 只分析亏损的
    targets = holdings
      .filter(h => h.profitLoss < 0)
      .sort((a, b) => a.profitLoss - b.profitLoss)
      .map(h => [h.code, `${h.shortName || h.name} (${h.sector}) 亏损${h.profitLoss}`]);
  } else {
    // 默认：分析亏损 + 重点关注的
    targets = holdings
      .filter(h => h.profitLoss < -5 || h.status === 'plan_to_sell' || h.status === 'watching')
      .map(h => [h.code, `${h.shortName || h.name} (${h.sector}) 盈亏${h.profitLoss >= 0 ? '+' : ''}${h.profitLoss}`]);
  }

  if (targets.length === 0) {
    console.log('没有需要分析的基金。用 --all 分析全部，或指定基金代码。');
    return;
  }

  console.log(`🎯 分析目标: ${targets.length} 只\n`);

  for (const [code, name] of targets) {
    await analyzeFund(code, name);
    await new Promise(r => setTimeout(r, 300));
  }

  // 也拉锂矿板块指数
  console.log(`\n${'='.repeat(60)}`);
  console.log('锂矿板块指数 BK0455');
  console.log('='.repeat(60));
  try {
    const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const begDate = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const kline = await httpGet(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK0455&fields1=f1,f2&fields2=f51,f52,f53&klt=101&fqt=1&beg=${begDate}&end=${endDate}`, { referer: 'https://quote.eastmoney.com/' });
    // BK0455 might not work, try alternative
    console.log('板块K线:', kline.substring(0,300));
  } catch(e) {
    console.log('板块K线获取失败:', e.message);
  }
}

main().catch(e => console.error(e));
