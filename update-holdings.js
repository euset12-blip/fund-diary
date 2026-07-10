#!/usr/bin/env node
/**
 * 养基日记 · 持仓更新器
 *
 * 日常使用：
 *   node update-holdings.js                          查看持仓总览
 *   node update-holdings.js --buy 006479 1000         买入 1000 元
 *   node update-holdings.js --buy 006479 1000 定投    买入 + 备注
 *   node update-holdings.js --sell 012349 500         卖出 500 元
 *   node update-holdings.js --sell 290008 50%         卖出 50% 仓位
 *   node update-holdings.js --set 006479 -a 5000 -i 4800  手动修正金额
 *
 * 所有操作自动：
 *   1. 更新养基宝持仓数据 + 本地 fund-config.json 元数据
 *   2. 追加交易记录到 交易记录.json
 */

const fs = require('fs');
const path = require('path');
const { readHoldings, writeHoldings } = require('./holdings-io.js');

const TXN_LOG_FILE = path.join(__dirname, '交易记录.json');

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

async function loadHoldings() {
  const holdings = await readHoldings();
  if (holdings.length === 0) {
    console.error('❌ 持仓文件为空或不存在');
    process.exit(1);
  }
  return holdings;
}

function saveHoldings(holdings) {
  writeHoldings(holdings);
}

function loadTransactions() {
  if (!fs.existsSync(TXN_LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TXN_LOG_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveTransaction(txn) {
  const txns = loadTransactions();
  txns.push(txn);
  fs.writeFileSync(TXN_LOG_FILE, JSON.stringify(txns, null, 2), 'utf-8');
}

function findHolding(data, code) {
  const h = data.find(h => h.code === code);
  if (!h) {
    console.error(`❌ 未找到基金代码: ${code}`);
    process.exit(1);
  }
  return h;
}

function fmt(n) {
  if (n == null || isNaN(n)) return '--';
  return n.toFixed(2);
}

function fmtMoney(n) {
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function color(c, text) {
  const colors = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m',
  };
  return `${colors[c] || ''}${text}${colors.reset}`;
}

// ═══════════════════════════════════════════════════════════
// 操作处理
// ═══════════════════════════════════════════════════════════

function doBuy(data, code, amount, note) {
  const h = findHolding(data, code);

  h.holdAmount    += amount;
  h.totalInvested += amount;
  // 新买入重置状态
  if (h.status === 'plan_to_sell') h.status = 'holding';

  saveHoldings(data);
  saveTransaction({
    date: new Date().toISOString().slice(0, 10),
    type: 'buy',
    code,
    amount,
    note: note || '',
  });

  console.log(color('green', `\n✅ 买入成功！`));
  console.log(`   ${h.shortName || h.name} (${code})`);
  console.log(`   买入金额: ¥${fmtMoney(amount)}`);
  console.log(`   当前持有: ¥${fmtMoney(h.holdAmount)}  |  投入本金: ¥${fmtMoney(h.totalInvested)}  |  收益: ${h.profit >= 0 ? '+' : ''}${fmt(h.profit)}`);
}

function doSell(data, code, amount, note) {
  const h = findHolding(data, code);

  // 支持百分比：50% → 卖出 50% 仓位
  let sellAmount = amount;
  if (typeof amount === 'string' && amount.endsWith('%')) {
    const pct = parseFloat(amount) / 100;
    sellAmount = +(h.holdAmount * pct).toFixed(2);
    console.log(color('dim', `   50%仓位 = ¥${fmtMoney(sellAmount)}`));
  }

  if (sellAmount > h.holdAmount) {
    console.error(`❌ 卖出金额 ¥${fmtMoney(sellAmount)} 超过持有金额 ¥${fmtMoney(h.holdAmount)}`);
    process.exit(1);
  }

  // 按比例回收成本
  const ratio = h.holdAmount > 0 ? sellAmount / h.holdAmount : 0;
  const costRecovered = +(h.totalInvested * ratio).toFixed(2);
  const realizedProfit  = +(sellAmount - costRecovered).toFixed(2);

  h.holdAmount    = +(h.holdAmount - sellAmount).toFixed(2);
  h.totalInvested = +(h.totalInvested - costRecovered).toFixed(2);

  // 如果全部卖出，标记
  if (h.holdAmount <= 0.01) {
    h.holdAmount = 0;
    h.totalInvested = 0;
    h.status = 'watching';
    h.plannedAction = '';
  }

  saveHoldings(data);
  saveTransaction({
    date: new Date().toISOString().slice(0, 10),
    type: 'sell',
    code,
    amount: sellAmount,
    costRecovered,
    realizedProfit,
    note: note || '',
  });

  const rCol = realizedProfit >= 0 ? 'red' : 'green';
  const rSign = realizedProfit >= 0 ? '+' : '';

  console.log(color('yellow', `\n✅ 卖出成功！`));
  console.log(`   ${h.shortName || h.name} (${code})`);
  console.log(`   卖出金额: ¥${fmtMoney(sellAmount)}  |  回收成本: ¥${fmtMoney(costRecovered)}`);
  console.log(`   已实现盈亏: ${color(rCol, rSign + fmt(realizedProfit))}`);
  console.log(`   剩余持有: ¥${fmtMoney(h.holdAmount)}  |  剩余本金: ¥${fmtMoney(h.totalInvested)}`);
}

function doSet(data, code, holdAmount, totalInvested) {
  const h = findHolding(data, code);

  if (holdAmount !== null && holdAmount !== undefined) {
    h.holdAmount = holdAmount;
  }
  if (totalInvested !== null && totalInvested !== undefined) {
    h.totalInvested = totalInvested;
  }

  saveHoldings(data);

  console.log(color('cyan', `\n✅ 已修正！`));
  console.log(`   ${h.shortName || h.name} (${code})`);
  console.log(`   持有金额: ¥${fmtMoney(h.holdAmount)}  |  投入本金: ¥${fmtMoney(h.totalInvested)}  |  收益: ${h.profit >= 0 ? '+' : ''}${fmt(h.profit)}`);
}

// ═══════════════════════════════════════════════════════════
// 持仓总览
// ═══════════════════════════════════════════════════════════

function showSummary(holdings) {
  let totalHold = 0, totalInvested = 0, totalProfit = 0;

  console.log(color('bold', '\n' + '═'.repeat(72)));
  console.log(color('bold', '  📊 养基日记 · 持仓总览'));
  console.log(color('dim',   `  养基宝  |  ${new Date().toISOString().slice(0, 10)}`));
  console.log(color('bold', '═'.repeat(72)));

  console.log(`\n  ${'简称'.padEnd(14)} ${'板块'.padEnd(12)} ${'持有金额'.padEnd(12)} ${'投入本金'.padEnd(12)} ${'收益'.padEnd(10)} ${'收益率'.padEnd(8)} ${'占比'}`);
  console.log(`  ${'─'.repeat(72)}`);

  for (const h of holdings) {
    const amt = h.holdAmount || 0;
    const inv = h.totalInvested || 0;
    const profit = amt - inv;
    const rate  = inv > 0 ? ((profit / inv) * 100) : 0;

    totalHold     += amt;
    totalInvested += inv;
    totalProfit   += profit;

    const pCol = profit >= 0 ? '\x1b[31m' : '\x1b[32m';
    const pSign = profit >= 0 ? '+' : '';
    const reset = '\x1b[0m';

    console.log(
      `  ${(h.shortName || h.name).padEnd(12)} ` +
      `${(h.sector || '').padEnd(10)} ` +
      `${fmtMoney(amt).padEnd(12)} ` +
      `${fmtMoney(inv).padEnd(12)} ` +
      `${pCol}${pSign}${fmt(profit).padEnd(10)}${reset} ` +
      `${pCol}${pSign}${rate.toFixed(1)}%${reset}`
    );
  }

  console.log(`  ${'─'.repeat(72)}`);
  const tpCol = totalProfit >= 0 ? '\x1b[31m' : '\x1b[32m';
  const tpSign = totalProfit >= 0 ? '+' : '';
  const tpRate = totalInvested > 0 ? ((totalProfit / totalInvested) * 100) : 0;
  const reset = '\x1b[0m';

  // 计算每只占比
  console.log(`  ${'合计'.padEnd(26)} ${fmtMoney(totalHold).padEnd(12)} ${fmtMoney(totalInvested).padEnd(12)} ${tpCol}${tpSign}${fmt(totalProfit).padEnd(10)}${reset} ${tpCol}${tpSign}${tpRate.toFixed(1)}%${reset}`);
  console.log('');

  // 占比分布
  if (totalHold > 0) {
    console.log(`  仓位分布:`);
    for (const h of holdings) {
      const amt = h.holdAmount || 0;
      const pct = totalHold > 0 ? (amt / totalHold * 100) : 0;
      if (amt <= 0) continue;
      const bar = '█'.repeat(Math.round(pct / 2)) + '░'.repeat(Math.max(0, 50 - Math.round(pct / 2)));
      console.log(`    ${(h.shortName || h.name).padEnd(14)} ${bar} ${pct.toFixed(1)}%`);
    }
  }

  // 状态提醒
  const toSell = holdings.filter(h => h.status === 'plan_to_sell');
  const toWatch = holdings.filter(h => h.status === 'watching');
  const toBuy  = holdings.filter(h => h.status === 'plan_to_buy');
  const bigLoss = holdings.filter(h => h.profit < -50);

  if (toSell.length + toWatch.length + toBuy.length + bigLoss.length > 0) {
    console.log('');
    if (toSell.length > 0) {
      console.log(`  🔴 待卖出: ${toSell.map(h => h.shortName || h.name).join(', ')}`);
    }
    if (toWatch.length > 0) {
      console.log(`  👀 观察中: ${toWatch.map(h => h.shortName || h.name).join(', ')}`);
    }
    if (toBuy.length > 0) {
      console.log(`  🔵 待买入: ${toBuy.map(h => h.shortName || h.name).join(', ')}`);
    }
    if (bigLoss.length > 0) {
      console.log(`  🚨 重亏警告: ${bigLoss.map(h => `${h.shortName || h.name}(${fmt(h.profit)})`).join(', ')}`);
    }
  }

  // 最近交易
  const txns = loadTransactions();
  if (txns.length > 0) {
    const recent = txns.slice(-5).reverse();
    console.log(color('bold', `\n  📝 最近交易:`));
    for (const t of recent) {
      const tIcon = t.type === 'buy' ? '🟢买' : '🔴卖';
      const h = holdings.find(hh => hh.code === t.code);
      const name = h ? (h.shortName || h.name) : t.code;
      const noteStr = t.note ? ` (${t.note})` : '';
      console.log(`    ${t.date}  ${tIcon} ${name}  ¥${fmtMoney(t.amount)}${noteStr}`);
    }
  }

  console.log(color('dim', '\n  💡 node update-holdings.js --buy <代码> <金额>  记录买入'));
  console.log(color('dim', '  💡 node update-holdings.js --sell <代码> <金额|50%>  记录卖出'));
  console.log('');
}

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--summary')) {
    const data = await loadHoldings();
    showSummary(data);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
养基日记 · 持仓更新器

用法:
  node update-holdings.js                              查看持仓总览
  node update-holdings.js --buy <代码> <金额> [备注]    记录买入
  node update-holdings.js --sell <代码> <金额|%> [备注]  记录卖出
  node update-holdings.js --set <代码> -a <持有金额> -i <投入本金>  手动修正

示例:
  node update-holdings.js --buy 006479 1000            定投纳斯达克1000元
  node update-holdings.js --buy 006479 500 定投         带备注
  node update-holdings.js --sell 290008 50%             卖出一半
  node update-holdings.js --sell 012349 1000            卖出1000元
  node update-holdings.js --set 006479 -a 5000 -i 4800  修正为持有5000投入4800
`);
    return;
  }

  const data = await loadHoldings();

  // ─── --buy ───
  if (args.includes('--buy')) {
    const idx = args.indexOf('--buy');
    const code = args[idx + 1];
    const amount = parseFloat(args[idx + 2]);
    const note = args[idx + 3] || '';

    if (!code || isNaN(amount) || amount <= 0) {
      console.error('❌ 用法: node update-holdings.js --buy <基金代码> <金额> [备注]');
      process.exit(1);
    }
    doBuy(data, code, amount, note);
    return;
  }

  // ─── --sell ───
  if (args.includes('--sell')) {
    const idx = args.indexOf('--sell');
    const code = args[idx + 1];
    let amount = args[idx + 2];
    const note = args[idx + 3] || '';

    if (!code || !amount) {
      console.error('❌ 用法: node update-holdings.js --sell <基金代码> <金额|50%> [备注]');
      process.exit(1);
    }

    // 判断是百分比还是金额
    if (typeof amount === 'string' && amount.endsWith('%')) {
      // keep as string for doSell to parse
    } else {
      amount = parseFloat(amount);
      if (isNaN(amount) || amount <= 0) {
        console.error('❌ 卖出金额/比例无效');
        process.exit(1);
      }
    }

    doSell(data, code, amount, note);
    return;
  }

  // ─── --set ───
  if (args.includes('--set')) {
    const idx = args.indexOf('--set');
    const code = args[idx + 1];

    let holdAmount = null, totalInvested = null;

    const aIdx = args.indexOf('-a');
    if (aIdx >= 0) holdAmount = parseFloat(args[aIdx + 1]);

    const iIdx = args.indexOf('-i');
    if (iIdx >= 0) totalInvested = parseFloat(args[iIdx + 1]);

    if (!code || (holdAmount === null && totalInvested === null)) {
      console.error('❌ 用法: node update-holdings.js --set <基金代码> -a <持有金额> -i <投入本金>');
      process.exit(1);
    }

    doSet(data, code, holdAmount, totalInvested);
    return;
  }

  // 默认：显示总览
  showSummary(data);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
