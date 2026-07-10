// 板块扫描器 - 找到趋势已建立但未到顶的板块
const { COLORS, c } = require('./lib/colors.js');
const { httpGet } = require('./lib/utils.js');

function scalePrice(raw) { return raw ? raw/100 : 0; }

// 板块列表
const SECTORS = {
  // 行业板块
  'BK0521': '半导体', 'BK0522': '光伏', 'BK0523': '锂电池', 'BK0524': '新能源',
  'BK0525': '军工', 'BK0526': '人工智能', 'BK0527': '机器人', 'BK0528': '数字经济',
  'BK0529': '创新药', 'BK0530': '储能', 'BK0531': '氢能源', 'BK0532': '信创',
  'BK0533': '数据要素', 'BK0534': '低空经济', 'BK0460': '5G概念', 'BK0461': '国产软件',
  'BK0462': '云计算', 'BK0463': '大数据', 'BK0464': '物联网', 'BK0465': '区块链',
  'BK0466': '虚拟现实', 'BK0467': '无人驾驶', 'BK0477': '元宇宙', 'BK0478': '东数西算',
  'BK0479': 'ChatGPT概念', 'BK0480': 'CPO概念', 'BK0481': '算力概念', 'BK0482': '光通信',
  'BK0483': '星闪概念', 'BK0484': '新质生产力', 'BK0459': '芯片概念',
  // 传统行业
  'BK0485': '旅游酒店', 'BK0486': '证券', 'BK0487': '银行', 'BK0488': '保险',
  'BK0489': '房地产', 'BK0491': '汽车', 'BK0492': '家电', 'BK0493': '食品饮料',
  'BK0494': '医药制造', 'BK0495': '医疗器械', 'BK0498': '通信设备', 'BK0501': '电力',
  'BK0505': '有色金属', 'BK0507': '机械设备', 'BK0508': '航天航空',
  'BK0519': '酿酒行业', 'BK0497': '软件服务', 'BK0515': '农牧饲渔',
};

async function analyzeSector(bkCode, name) {
  // 获取板块K线（30天）
  const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const begDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const kUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.${bkCode}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=${begDate}&end=${endDate}`;
  const kText = await httpGet(kUrl, { silent: true, timeout: 8000 });
  if (!kText) return null;

  try {
    const j = JSON.parse(kText);
    if (j.rc !== 0 || !j.data?.klines) return null;
    const klines = j.data.klines.map(l => {
      const p = l.split(',');
      return { date:p[0], open:+p[1], close:+p[2], high:+p[3], low:+p[4], vol:+p[5], amt:+p[6] };
    });
    if (klines.length < 20) return null;

    // 计算均线
    const closes = klines.map(k => k.close);
    const latest = closes[closes.length-1];
    const first = closes[0];
    const ma5 = closes.slice(-5).reduce((a,b)=>a+b,0)/5;
    const ma10 = closes.slice(-10).reduce((a,b)=>a+b,0)/10;
    const ma20 = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
    const ma60 = closes.length>=60 ? closes.slice(-60).reduce((a,b)=>a+b,0)/60 : ma20;

    // 趋势评分
    let trendScore = 0;
    const signals = [];

    // 1. 均线排列 (30分)
    if (ma5 > ma10 && ma10 > ma20) {
      trendScore += 30;
      signals.push('多头排列');
    } else if (ma5 > ma10) {
      trendScore += 15;
      signals.push('短期金叉');
    } else if (ma5 < ma10 && ma10 < ma20) {
      trendScore -= 30;
      signals.push('空头排列');
    }

    // 2. 价格 vs MA20 (20分)
    const vs20 = (latest/ma20 - 1) * 100;
    if (vs20 > 0 && vs20 < 15) { trendScore += 20; signals.push(`在MA20上方${vs20.toFixed(1)}%`); }
    else if (vs20 > 15) { trendScore += 5; signals.push('偏离MA20过大⚠️'); }
    else { trendScore -= 10; signals.push('跌破MA20'); }

    // 3. 近期涨幅 (15分) - 涨了但不能太多
    const change5d = ((latest - closes[closes.length-6]) / closes[closes.length-6]) * 100;
    const change10d = ((latest - closes[Math.max(0,closes.length-11)]) / closes[Math.max(0,closes.length-11)]) * 100;

    if (change5d > 0 && change5d < 5) { trendScore += 10; signals.push(`5日涨${change5d.toFixed(1)}%（温和）`); }
    else if (change5d >= 5 && change5d < 10) { trendScore += 5; signals.push(`5日涨${change5d.toFixed(1)}%（偏强）`); }
    else if (change5d >= 10) { trendScore -= 5; signals.push(`5日涨${change5d.toFixed(1)}%（过热⚠️）`); }
    else if (change5d < -5) { trendScore -= 10; signals.push(`5日跌${change5d.toFixed(1)}%（弱势）`); }
    else { trendScore += 0; signals.push(`5日${change5d>=0?'+':''}${change5d.toFixed(1)}%`); }

    // 4. 量价关系 (15分)
    const recentVol = klines.slice(-5).map(k=>k.vol);
    const prevVol = klines.slice(-10,-5).map(k=>k.vol);
    const avgRecent = recentVol.reduce((a,b)=>a+b,0)/5;
    const avgPrev = prevVol.reduce((a,b)=>a+b,0)/5;
    const volRatio = avgRecent / avgPrev;

    if (volRatio > 1.2 && change5d > 0) { trendScore += 15; signals.push('放量上涨📈'); }
    else if (volRatio > 1.2 && change5d < 0) { trendScore -= 10; signals.push('放量下跌📉'); }
    else if (volRatio < 0.8) { trendScore += 0; signals.push('缩量'); }
    else { trendScore += 5; signals.push('量能正常'); }

    // 5. 近期波动率 (10分) - 太高说明不稳定
    const returns = [];
    for (let i=1; i<closes.length; i++) returns.push((closes[i]-closes[i-1])/closes[i-1]);
    const vol = Math.sqrt(returns.reduce((s,r)=>s+r*r,0)/returns.length) * Math.sqrt(252) * 100;
    if (vol < 20) { trendScore += 10; }
    else if (vol < 35) { trendScore += 5; }
    else { trendScore -= 5; signals.push(`波动率${vol.toFixed(0)}%（高波动）`); }

    // 6. 从30日最高回撤 (10分) - 回撤越小越好
    const high30 = Math.max(...closes.slice(-30));
    const drawdown = (1 - latest/high30) * 100;
    if (drawdown < 3) { trendScore += 10; }
    else if (drawdown < 8) { trendScore += 5; signals.push(`回撤${drawdown.toFixed(1)}%`); }
    else { trendScore -= 5; signals.push(`回撤${drawdown.toFixed(1)}%（较大）`); }

    // 判断趋势阶段
    let stage = '';
    if (trendScore >= 50 && drawdown < 5 && change5d < 8) stage = '趋势中期（最佳）';
    else if (trendScore >= 40 && drawdown < 10) stage = '趋势早期';
    else if (trendScore >= 30 && drawdown >= 10) stage = '回调中（可关注）';
    else if (trendScore < 20 && change5d < -5) stage = '下跌趋势';
    else if (trendScore >= 50 && change5d >= 8) stage = '趋势末期（注意止盈）';
    else stage = '震荡整理';

    return {
      code: bkCode, name,
      latest, ma5, ma10, ma20, change5d, change10d, volRatio,
      drawdown, volatility: vol, trendScore,
      stage, signals,
      // 最近K线
      recent: klines.slice(-5).map(k => ({ date: k.date, close: k.close }))
    };
  } catch(e) {
    return null;
  }
}

async function main() {
  console.log(c(COLORS.bold, '\n🔍 板块扫描中...'));
  console.log(c(COLORS.dim, '  寻找趋势已建立但未到顶的板块\n'));

  const entries = Object.entries(SECTORS);
  const results = [];

  for (let i = 0; i < entries.length; i++) {
    const [code, name] = entries[i];
    process.stdout.write(`\r  进度: ${i+1}/${entries.length} - ${name}                    `);
    const r = await analyzeSector(code, name);
    if (r) results.push(r);
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  console.log('\n');

  // 筛选优质板块
  const good = results
    .filter(r => r.trendScore >= 35) // 趋势分够高
    .filter(r => r.change5d < 10 && r.drawdown < 12) // 未过热
    .filter(r => r.stage !== '下跌趋势')
    .sort((a, b) => b.trendScore - a.trendScore);

  const caution = results
    .filter(r => r.trendScore >= 25 && r.trendScore < 35)
    .filter(r => r.stage === '回调中（可关注）')
    .sort((a, b) => a.drawdown - b.drawdown);

  // === 输出 ===

  console.log(c(COLORS.bold, '🔥 优质板块（趋势确立 + 未到顶）\n'));
  console.log(`${'板块'.padEnd(12)} ${'趋势分'.padEnd(6)} ${'5日涨跌'.padEnd(10)} ${'回撤'.padEnd(8)} ${'量能'.padEnd(10)} ${'阶段判断'}`);
  console.log('─'.repeat(70));

  for (const s of good.slice(0, 12)) {
    const chgCol = s.change5d >= 0 ? COLORS.red : COLORS.green;
    const scoreCol = s.trendScore >= 50 ? COLORS.red : s.trendScore >= 40 ? COLORS.yellow : COLORS.cyan;
    const stageCol = s.stage.includes('最佳') ? COLORS.red :
                     s.stage.includes('早期') ? COLORS.yellow : COLORS.cyan;

    console.log(
      `${s.name.padEnd(10)} ` +
      `${scoreCol}${s.trendScore.toString().padEnd(6)}${COLORS.reset}` +
      `${chgCol}${(s.change5d>=0?'+':'')+s.change5d.toFixed(1)+'%'.padEnd(9)}${COLORS.reset}` +
      `${s.drawdown.toFixed(1)+'%'.padEnd(8)}` +
      `${s.volRatio.toFixed(1)+'x'.padEnd(10)}` +
      `${stageCol}${s.stage}${COLORS.reset}`
    );

    // 关键信号
    const keySignals = s.signals.filter(x =>
      x.includes('多头排列') || x.includes('金叉') || x.includes('放量') ||
      x.includes('过热') || x.includes('弱势') || x.includes('跌破')
    );
    if (keySignals.length > 0) {
      console.log(`  └─ ${keySignals.slice(0,2).join(' | ')}`);
    }
  }

  if (caution.length > 0) {
    console.log(c(COLORS.bold, '\n\n👀 回调中可关注的板块\n'));
    console.log(`${'板块'.padEnd(12)} ${'趋势分'.padEnd(6)} ${'5日涨跌'.padEnd(10)} ${'回撤'.padEnd(8)} ${'阶段'}`);
    console.log('─'.repeat(55));
    for (const s of caution.slice(0, 8)) {
      const chgCol = s.change5d >= 0 ? COLORS.red : COLORS.green;
      console.log(
        `${s.name.padEnd(10)} ${s.trendScore.toString().padEnd(6)} ` +
        `${chgCol}${(s.change5d>=0?'+':'')+s.change5d.toFixed(1)+'%'.padEnd(9)}${COLORS.reset}` +
        `${s.drawdown.toFixed(1)+'%'.padEnd(8)} ${s.stage}`
      );
    }
  }

  // 与用户持仓的关联分析
  console.log(c(COLORS.bold, '\n\n🔗 与你持仓的关联\n'));
  const userSectors = new Set([
    '半导体', '通信设备', '白酒Ⅱ', '电网', '锂电池', '医疗器械', '算力', 'CPO'
  ]);

  const relevant = results.filter(r => {
    return userSectors.has(r.name) ||
           r.name.includes('半导体') || r.name.includes('芯片') || r.name.includes('5G') ||
           r.name.includes('光通信') || r.name.includes('算力') || r.name.includes('CPO') ||
           r.name.includes('锂') || r.name.includes('医疗') || r.name.includes('通信') ||
           r.name.includes('白酒') || r.name.includes('电力') || r.name.includes('数字经济');
  });

  for (const r of relevant) {
    const icon = r.trendScore >= 40 ? '🟢' : r.trendScore >= 25 ? '🟡' : '🔴';
    const rec = r.trendScore >= 40 ? '继续持有' : r.trendScore >= 25 ? '观察' : '考虑减仓';
    console.log(`  ${icon} ${r.name}: ${r.stage} (${r.trendScore}分) → ${rec}`);
  }

  console.log(c(COLORS.dim, '\n⚠️ 以上基于技术面量化，不构成投资建议。板块分析需配合基本面和个股研究。\n'));
}

main().catch(e => console.error(e));
