const { formatMoney, formatPercent } = require('./format.js');
const { COLORS } = require('./colors.js');

// Strategy and technical signal helpers. Keep this module pure: no network, no file I/O.

// ─── 大盘环境过滤阈值 ───────────────────────────────────────────
// 大盘当日跌幅超过此值时，屏蔽所有买入/补仓信号，只保留止损和止盈。
// marketEnv.changePercent 单位：%（如 -2.1 表示跌 2.1%）
const MARKET_BEAR_THRESHOLD = -2.0;

function calcMA(kline, period) {
  if (kline.length < period) return [];
  const mas = [];
  for (let i = period - 1; i < kline.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += kline[j].close;
    }
    mas.push({ date: kline[i].date, value: sum / period });
  }
  return mas;
}

function analyzeKlineTrend(kline) {
  if (kline.length < 20) return { trend: 'insufficient_data', signals: [] };

  const volumes = kline.map(k => k.volume);
  const latest = kline[kline.length - 1];
  const prev = kline[kline.length - 2];
  const ma5 = calcMA(kline, 5);
  const ma10 = calcMA(kline, 10);
  const ma20 = calcMA(kline, 20);

  const latestMA5 = ma5.length > 0 ? ma5[ma5.length - 1].value : null;
  const latestMA10 = ma10.length > 0 ? ma10[ma10.length - 1].value : null;
  const latestMA20 = ma20.length > 0 ? ma20[ma20.length - 1].value : null;

  const signals = [];
  let score = 0;

  if (latestMA5 && latestMA10 && latestMA20) {
    if (latest.close > latestMA5 && latestMA5 > latestMA10 && latestMA10 > latestMA20) {
      signals.push({ type: 'positive', msg: '多头排列，价格在所有均线之上' });
      score += 25;
    } else if (latest.close < latestMA5 && latestMA5 < latestMA10 && latestMA10 < latestMA20) {
      signals.push({ type: 'negative', msg: '空头排列，价格在所有均线之下' });
      score -= 25;
    } else if (latest.close > latestMA20) {
      signals.push({ type: 'neutral', msg: '价格在20日均线上方，中期趋势偏多' });
      score += 10;
    } else if (latest.close < latestMA20) {
      signals.push({ type: 'neutral', msg: '价格在20日均线下方，中期趋势偏空' });
      score -= 10;
    }
  }

  const recent5 = kline.slice(-5);
  const change5d = ((latest.close - recent5[0].close) / recent5[0].close) * 100;
  if (change5d > 5) {
    signals.push({ type: 'warning', msg: `5日涨幅 ${change5d.toFixed(1)}%，短线涨幅较大` });
    score -= 5;
  } else if (change5d < -5) {
    signals.push({ type: 'positive', msg: `5日跌幅 ${change5d.toFixed(1)}%，短线超跌` });
    score += 5;
  }

  const avgVol10 = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
  const latestVol = volumes[volumes.length - 1];
  const volRatio = latestVol / avgVol10;

  if (volRatio > 1.5 && latest.close > prev.close) {
    signals.push({ type: 'positive', msg: `放量上涨，量比 ${volRatio.toFixed(1)}` });
    score += 10;
  } else if (volRatio > 1.5 && latest.close < prev.close) {
    signals.push({ type: 'negative', msg: `放量下跌，量比 ${volRatio.toFixed(1)}` });
    score -= 15;
  } else if (volRatio < 0.5) {
    signals.push({ type: 'neutral', msg: `缩量，量比 ${volRatio.toFixed(1)}` });
  }

  let consecutiveUp = 0, consecutiveDown = 0;
  for (let i = kline.length - 1; i > 0; i--) {
    if (kline[i].close > kline[i - 1].close) consecutiveUp++;
    else break;
  }
  for (let i = kline.length - 1; i > 0; i--) {
    if (kline[i].close < kline[i - 1].close) consecutiveDown++;
    else break;
  }

  if (consecutiveUp >= 5) {
    signals.push({ type: 'warning', msg: `连涨 ${consecutiveUp} 天，注意获利回吐` });
    score -= 8;
  } else if (consecutiveDown >= 5) {
    signals.push({ type: 'positive', msg: `连跌 ${consecutiveDown} 天，超卖明显` });
    score += 8;
  }

  const returns = [];
  for (let i = 1; i < kline.length; i++) {
    returns.push((kline[i].close - kline[i - 1].close) / kline[i - 1].close);
  }
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;

  return {
    trend: score > 20 ? 'bullish' : score < -20 ? 'bearish' : 'sideways',
    score,
    ma5: latestMA5,
    ma10: latestMA10,
    ma20: latestMA20,
    change5d,
    volRatio,
    consecutiveUp,
    consecutiveDown,
    volatility,
    signals,
  };
}

function analyzeCapitalFlow(stockData) {
  if (!stockData) return { score: 0, signals: [] };
  const signals = [];
  let score = 0;

  if (stockData.mainFlow > 0) {
    signals.push({ type: 'positive', msg: `主力净流入 ${formatMoney(stockData.mainFlow)}` });
    score += 20;
  } else if (stockData.mainFlow < 0) {
    signals.push({ type: 'negative', msg: `主力净流出 ${formatMoney(Math.abs(stockData.mainFlow))}` });
    score -= 20;
  }

  if (stockData.superLargeNet > 0) {
    score += 15;
    signals.push({ type: 'positive', msg: `超大单净流入 ${formatMoney(stockData.superLargeNet)}` });
  } else if (stockData.superLargeNet < 0) {
    score -= 15;
    signals.push({ type: 'negative', msg: `超大单净流出 ${formatMoney(Math.abs(stockData.superLargeNet))}` });
  }

  if (stockData.largeNet > 0) score += 5;
  else if (stockData.largeNet < 0) score -= 5;

  if (stockData.turnover > 10) {
    signals.push({ type: 'warning', msg: `换手率 ${stockData.turnover.toFixed(1)}%，交易异常活跃` });
    score -= 5;
  } else if (stockData.turnover > 5) {
    signals.push({ type: 'neutral', msg: `换手率 ${stockData.turnover.toFixed(1)}%，交易活跃` });
    score += 3;
  }

  return { score, signals };
}

function generateRecommendation(techAnalysis, flowAnalysis, fundPerf) {
  const signals = [];
  let score = 50;

  score += techAnalysis.score * 0.4;
  signals.push(...techAnalysis.signals.map(s => ({ ...s, source: '技术面' })));

  score += flowAnalysis.score * 0.4;
  signals.push(...flowAnalysis.signals.map(s => ({ ...s, source: '资金面' })));

  if (fundPerf) {
    if (fundPerf.realtimeChange < -3) {
      score -= 10;
      signals.push({ type: 'negative', msg: `今日估值大跌 ${formatPercent(fundPerf.realtimeChange)}`, source: '估值' });
    } else if (fundPerf.realtimeChange > 2) {
      score += 5;
      signals.push({ type: 'positive', msg: `今日估值大涨 ${formatPercent(fundPerf.realtimeChange)}`, source: '估值' });
    }
    if (fundPerf.change1w && fundPerf.change1w < -5) {
      score += 5;
      signals.push({ type: 'positive', msg: '近一周跌幅较大，可能超跌反弹', source: '估值' });
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let action, colorCode, desc;
  if (score >= 65) {
    action = '加仓/买入';
    colorCode = COLORS.green;
    desc = '多项指标积极，建议考虑加仓';
  } else if (score >= 40) {
    action = '持有观望';
    colorCode = COLORS.yellow;
    desc = '信号中性，建议持仓观望';
  } else {
    action = '减仓/卖出';
    colorCode = COLORS.red;
    desc = '多项指标偏空，建议考虑减仓避险';
  }

  return { action, colorCode, desc, score, signals };
}

/**
 * 检测 NAV 序列的结构趋势（更高的高点 + 更高的低点）
 * 使用滑动窗口检测局部极值点，判断上升/下降/震荡结构
 */
function detectStructure(navs, minWindow = 2) {
  if (navs.length < 20) return { trend: 'insufficient', hh: false, hl: false, highs: [], lows: [] };

  const highs = [], lows = [];
  // 在 navs 内部滑动，找局部极值
  for (let i = minWindow; i < navs.length - minWindow; i++) {
    const leftSlice = navs.slice(Math.max(0, i - minWindow), i);
    const rightSlice = navs.slice(i + 1, i + 1 + minWindow);
    const isHigh = leftSlice.every(v => v <= navs[i]) && rightSlice.every(v => v <= navs[i]);
    const isLow = leftSlice.every(v => v >= navs[i]) && rightSlice.every(v => v >= navs[i]);
    if (isHigh && (highs.length === 0 || navs[i] !== highs[highs.length - 1])) highs.push(navs[i]);
    if (isLow && (lows.length === 0 || navs[i] !== lows[lows.length - 1])) lows.push(navs[i]);
  }

  // 看看最近两个高点和低点的方向
  const last2h = highs.slice(-2);
  const last2l = lows.slice(-2);
  const hh = last2h.length >= 2 && last2h[1] > last2h[0];
  const hl = last2l.length >= 2 && last2l[1] > last2l[0];

  let trend = 'mixed';
  if (hh && hl) trend = 'up';
  else if (last2h.length >= 2 && last2l.length >= 2 && last2h[1] < last2h[0] && last2l[1] < last2l[0]) trend = 'down';

  return { trend, hh, hl, highs: highs.slice(-3), lows: lows.slice(-3) };
}

function calcFundCompositeMA(historyNav, todayValuation) {
  if (!todayValuation || !historyNav || historyNav.length < 5) return null;

  const navs = historyNav.map(h => h.nav).reverse();
  const composite = [...navs, todayValuation];
  const calc = (arr, period) => {
    if (arr.length < period) return null;
    const slice = arr.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  };

  const ma5 = calc(composite, 5);
  const ma10 = calc(composite, 10);
  const ma20 = calc(composite, 20);
  const histMA5 = navs.length >= 5 ? navs.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
  const histMA10 = navs.length >= 10 ? navs.slice(-10).reduce((a, b) => a + b, 0) / 10 : null;
  const histMA20 = navs.length >= 20 ? navs.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const devMA5 = ma5 ? ((todayValuation - ma5) / ma5 * 100) : null;
  const devMA10 = ma10 ? ((todayValuation - ma10) / ma10 * 100) : null;
  const devMA20 = ma20 ? ((todayValuation - ma20) / ma20 * 100) : null;

  let alignment = 'unknown';
  // 用历史净值均线（不含今日估值）判断趋势结构，避免今日涨跌污染
  if (histMA5 && histMA10 && histMA20) {
    if (todayValuation > histMA5 && histMA5 > histMA10 && histMA10 > histMA20) alignment = 'bullish_aligned';
    else if (todayValuation < histMA5 && histMA5 < histMA10 && histMA10 < histMA20) alignment = 'bearish_aligned';
    else if (histMA5 > histMA10) alignment = 'short_bullish';
    else if (histMA5 < histMA10) alignment = 'short_bearish';
    else alignment = 'sideways';
  }

  const nearMA20 = ma20 ? Math.abs(todayValuation - ma20) / ma20 < 0.02 : false;
  const nearMA10 = ma10 ? Math.abs(todayValuation - ma10) / ma10 < 0.015 : false;
  const recent5Nav = navs.slice(-5);
  const change5dHist = recent5Nav.length >= 5
    ? ((recent5Nav[recent5Nav.length - 1] - recent5Nav[0]) / recent5Nav[0] * 100)
    : null;

  const structure = detectStructure(navs);

  return {
    valuation: todayValuation,
    ma5, ma10, ma20,
    histMA5, histMA10, histMA20,
    devMA5, devMA10, devMA20,
    alignment,
    nearMA20, nearMA10,
    change5dHist,
    structure,
    latestNav: navs[navs.length - 1],
  };
}

/**
 * @param {Object} [marketEnv] - 大盘环境数据，来自 data-layer.getIndexChange()
 *   { name, changePercent }  changePercent 单位：% 如 -2.1
 *   传 null/undefined 时跳过大盘过滤（向后兼容）
 */
function generateIntradayCommands(fundInfo, maData, fundVal, profitLoss, historyNav, strategyConfig, marketEnv) {
  const commands = [];
  if (!maData || !fundVal) return commands;

  // ─── 大盘环境过滤 ───────────────────────────────────────────
  // 大盘普跌时屏蔽一切买入/补仓信号，只允许止损和止盈通过。
  const marketBearMode = marketEnv != null && typeof marketEnv.changePercent === 'number'
    && marketEnv.changePercent <= MARKET_BEAR_THRESHOLD;

  const { valuation, ma5, ma10, ma20, alignment, nearMA20, nearMA10, structure } = maData;
  const strategyType = (strategyConfig || {}).type || 'stop_loss';
  const consecBelowMA20 = ma20 ? countDaysBelowMA20(historyNav, ma20, 5) : 0;
  const stopLossEnabled = strategyType === 'stop_loss' || strategyType === 'light_stop';
  const isUrgent = strategyType === 'stop_loss';

  if (stopLossEnabled && ma20 && valuation < ma20 && consecBelowMA20 >= 3) {
    const breakPct = ((ma20 - valuation) / ma20 * 100).toFixed(2);
    if (profitLoss < 0) {
      const urgency = isUrgent ? '请在 15:00 前果断赎回全部仓位。' : '建议减仓 30-50%，保留部分仓位观察。';
      commands.push({
        priority: 1, type: 'stop_loss', label: isUrgent ? '立即止损' : '轻仓止损', color: 'red',
        instruction: `【${isUrgent ? '立即止损' : '趋势破位'}】估值 ${valuation.toFixed(4)} 已连续 ${consecBelowMA20} 日低于 MA20(${ma20.toFixed(4)})，亏损 ${Math.abs(profitLoss).toFixed(1)}%，${urgency}`,
        action: '赎回/卖出', deadline: '15:00',
      });
    } else {
      const urgency = isUrgent ? '请在 15:00 前减仓 40-50% 保护利润。' : '建议减仓 20-30% 锁定部分利润。';
      commands.push({
        priority: 1, type: 'stop_loss', label: '破位止损', color: 'red',
        instruction: `【破位止损】估值 ${valuation.toFixed(4)} 已连续 ${consecBelowMA20} 日低于 MA20(${ma20.toFixed(4)})，跌破幅度 ${breakPct}%。仍有 +${profitLoss.toFixed(1)}% 盈利，${urgency}`,
        action: '减仓/卖出', deadline: '15:00',
      });
    }
  }

  if (!stopLossEnabled && ma20 && valuation < ma20 && consecBelowMA20 >= 3) {
    const breakPct = ((ma20 - valuation) / ma20 * 100).toFixed(2);
    const stratDesc = (strategyConfig || {}).desc || 'hold_dip';
    commands.push({
      priority: 2, type: 'hold_through_dip', label: '坚持持有', color: 'cyan',
      instruction: `【${stratDesc}策略】估值已连续 ${consecBelowMA20} 日低于 MA20，偏离 ${breakPct}%。回测显示该类基金止损不如持有，建议继续定投。`,
      action: '持有+定投', deadline: null,
    });
  }

  if (stopLossEnabled && ma20 && valuation < ma20 && profitLoss >= 10 && consecBelowMA20 < 3) {
    const breakPct = ((ma20 - valuation) / ma20 * 100).toFixed(2);
    commands.push({
      priority: 2, type: 'protective_profit', label: '保护性止盈', color: 'yellow',
      instruction: `【保护性止盈】盈利 +${profitLoss.toFixed(1)}%，但今日首次跌破 MA20(${ma20.toFixed(4)})，偏离 ${breakPct}%。建议在 15:00 前卖出 40-50% 仓位。`,
      action: '分批止盈(保护)', deadline: '15:00',
    });
  }

  if (stopLossEnabled && ma20 && valuation < ma20 && consecBelowMA20 < 3) {
    const breakPct = ((ma20 - valuation) / ma20 * 100).toFixed(2);
    commands.push({
      priority: 3, type: 'first_break', label: profitLoss < 0 ? '首破止损' : '首次破位', color: 'yellow',
      instruction: `【首次破位】估值 ${valuation.toFixed(4)} 今日跌破 MA20(${ma20.toFixed(4)})，偏离 ${breakPct}%。观察尾盘能否收复。`,
      action: profitLoss < 0 ? '观察尾盘/准备止损' : '观察尾盘', deadline: '14:50 确认',
    });
  }

  if (ma20 && nearMA20 && alignment === 'short_bullish' && valuation > ma20 && structure?.trend !== 'down') {
    const confidence = structure?.trend === 'up' ? '，上升结构确认' : '，结构尚在修复中';
    commands.push({
      priority: 2, type: 'buy_pullback', label: '回踩买入', color: 'green',
      instruction: `【立即行动】估值 ${valuation.toFixed(4)} 回踩 MA20(${ma20.toFixed(4)}) 附近企稳，短期均线多头${confidence}。`,
      action: '买入/加仓', deadline: '15:00',
    });
  }

  if (ma10 && nearMA10 && alignment === 'bullish_aligned' && valuation > ma20) {
    if (!commands.find(c => c.type === 'buy_pullback')) {
      commands.push({
        priority: 3, type: 'buy_ma10', label: '均线支撑', color: 'green',
        instruction: `【加仓机会】估值 ${valuation.toFixed(4)} 回踩 MA10(${ma10.toFixed(4)})，多头排列中。`,
        action: '加仓', deadline: '15:00',
      });
    }
  }

  if (historyNav && historyNav.length >= 20) {
    const navs = historyNav.map(h => h.nav).reverse();
    const high30d = Math.max(...navs.slice(-30));
    const drawdown = ((high30d - valuation) / high30d) * 100;
    const recent3 = navs.slice(-4);
    const newLow = recent3.length >= 3 && recent3[recent3.length - 1] <= Math.min(...recent3.slice(0, -1));
    const histNavs = historyNav.map(h => h.nav).reverse();
    const yesterdayMA5 = histNavs.length >= 6 ? histNavs.slice(-6, -1).reduce((a, b) => a + b, 0) / 5 : null;
    const ma5TurningUp = yesterdayMA5 && ma5 && ma5 > yesterdayMA5;
    const aboveMA5 = ma5 && valuation > ma5;

    if (drawdown >= 30 && ma5TurningUp && aboveMA5 && !newLow) {
      commands.push({
        priority: 4, type: 'dip_buy_heavy', label: '重仓抄底', color: 'green',
        instruction: `【重仓抄底】累计回撤 ${drawdown.toFixed(1)}%，MA5 拐头向上，近3日止跌企稳。`,
        action: '重仓加仓', deadline: '15:00',
      });
    } else if (drawdown >= 20 && aboveMA5 && !newLow) {
      commands.push({
        priority: 4, type: 'dip_buy_medium', label: '中仓补仓', color: 'green',
        instruction: `【中仓补仓】累计回撤 ${drawdown.toFixed(1)}%，估值站上 MA5，近3日不再创新低。`,
        action: '中仓加仓', deadline: '15:00',
      });
    } else if (drawdown >= 10 && aboveMA5) {
      commands.push({
        priority: 5, type: 'dip_buy_light', label: '轻仓试探', color: 'green',
        instruction: `【轻仓试探】累计回撤 ${drawdown.toFixed(1)}%，已站上 MA5 短线企稳。`,
        action: '轻仓试探', deadline: '15:00',
      });
    }
  }

  const hasProtectiveProfit = commands.some(c => c.type === 'protective_profit');
  const isHoldDip = strategyType === 'hold_dip';

  if (!hasProtectiveProfit && profitLoss >= 20) {
    if (!isHoldDip || profitLoss >= 50) {
      commands.push({
        priority: 5, type: 'take_profit', label: '大额止盈', color: 'yellow',
        instruction: `【大额止盈】持仓盈利 +${profitLoss.toFixed(1)}%，建议在 15:00 前卖出 30-40% 仓位。`,
        action: '分批止盈', deadline: '15:00',
      });
    }
  } else if (!hasProtectiveProfit && profitLoss >= 10) {
    if (!isHoldDip || profitLoss >= 40) {
      commands.push({
        priority: 5, type: 'take_profit', label: '分批止盈', color: 'yellow',
        instruction: `【分批止盈】持仓盈利 +${profitLoss.toFixed(1)}%，建议在 15:00 前卖出 20-30% 仓位。`,
        action: '分批止盈', deadline: '15:00',
      });
    }
  } else if (!hasProtectiveProfit && profitLoss >= 5 && !isHoldDip) {
    commands.push({
      priority: 6, type: 'partial_profit', label: '部分止盈', color: 'yellow',
      instruction: `【部分止盈】持仓盈利 +${profitLoss.toFixed(1)}%，可考虑卖出 10-20% 仓位。`,
      action: '部分止盈', deadline: '15:00',
    });
  }

  if (isHoldDip && !hasProtectiveProfit && alignment === 'bullish_aligned' && structure?.trend === 'up') {
    if (!commands.find(c => c.type === 'take_profit')) {
      commands.push({
        priority: 4, type: 'hold_dip_strong', label: '强势持有', color: 'green',
        instruction: `【让利润奔跑】趋势强势，均线多头排列且HH/HL结构确认上升，${strategyConfig?.desc || ''}策略下建议继续持有。`,
        action: '持有/加仓', deadline: null,
      });
    }
  } else if (isHoldDip && !hasProtectiveProfit && alignment === 'bullish_aligned') {
    // 均线多头但结构未确认 → 降级信号
    if (!commands.find(c => c.type === 'take_profit')) {
      commands.push({
        priority: 8, type: 'hold_dip_weak', label: '持有观望', color: 'yellow',
        instruction: `【持有观望】均线多头但HH/HL结构未确认上升趋势，${strategyConfig?.desc || ''}策略下继续持有但不宜加仓。`,
        action: '持有/不加仓', deadline: null,
      });
    }
  }

  if (alignment === 'bullish_aligned' && !commands.find(c => c.type === 'buy_pullback' || c.type === 'buy_ma10')) {
    const structNote = structure?.trend === 'up' ? '，HH/HL结构确认' : structure?.trend === 'mixed' ? '，但HH/HL结构尚未确认（可能为反弹）' : '';
    const priority = structure?.trend === 'up' ? 7 : 10;
    const color = structure?.trend === 'up' ? 'green' : 'yellow';
    commands.push({
      priority, type: 'hold_bullish', label: structure?.trend === 'up' ? '趋势持有' : '反弹持有', color,
      instruction: `【${structure?.trend === 'up' ? '趋势持有' : '反弹持有'}】均线多头排列${structNote}。${structure?.trend === 'up' ? '可继续持有，逢回调加仓。' : '暂持观望，等结构确认后再加仓。'}`,
      action: structure?.trend === 'up' ? '持有/加仓' : '持有/不加仓', deadline: null,
    });
  }

  if (alignment === 'bearish_aligned') {
    if (!commands.find(c => c.type === 'stop_loss')) {
      commands.push({
        priority: 8, type: 'avoid', label: '空头回避', color: 'red',
        instruction: '【空头排列】估值在 MA5/MA10/MA20 之下，趋势偏空。不建议加仓。',
        action: '减仓/观望', deadline: null,
      });
    }
  }

  if (commands.length === 0) {
    if (alignment === 'short_bullish' || alignment === 'bullish_aligned') {
      commands.push({
        priority: 9, type: 'neutral_hold', label: '继续持有', color: 'yellow',
        instruction: `【继续持有】估值 ${valuation.toFixed(4)} 在均线附近，无明确买卖信号。`,
        action: '持有', deadline: null,
      });
    } else if (alignment === 'short_bearish' || alignment === 'bearish_aligned') {
      commands.push({
        priority: 9, type: 'neutral_caution', label: '谨慎持有', color: 'yellow',
        instruction: '【谨慎持有】短期偏弱但未确认破位，暂持观望。',
        action: '观望', deadline: null,
      });
    } else {
      commands.push({
        priority: 9, type: 'neutral_wait', label: '等待信号', color: 'yellow',
        instruction: '【等待信号】均线交织，方向不明，建议观望不操作。',
        action: '观望', deadline: null,
      });
    }
  }

  commands.sort((a, b) => a.priority - b.priority);

  // ─── 大盘熊市过滤：屏蔽所有买入/补仓信号 ───────────────────
  // 触发条件：marketEnv.changePercent <= MARKET_BEAR_THRESHOLD（默认 -2%）
  // 保留：P0 止损 + P1 止盈/首次破位；屏蔽：P2 买入/补仓及以下
  if (marketBearMode) {
    const BUY_TYPES = new Set([
      'buy_pullback', 'buy_ma10',
      'dip_buy_heavy', 'dip_buy_medium', 'dip_buy_light',
      'hold_dip_strong', 'hold_bullish',
      'neutral_hold', 'neutral_caution', 'neutral_wait',
      'avoid',
    ]);
    const filtered = commands.filter(c => !BUY_TYPES.has(c.type));
    // 如果过滤后什么都不剩，补一条提示
    if (filtered.length === 0) {
      filtered.push({
        priority: 9, type: 'market_bear_wait', label: '大盘普跌', color: 'yellow',
        instruction: `【大盘普跌】${marketEnv.name || '市场'}今日跌幅 ${marketEnv.changePercent.toFixed(2)}%，超过 ${MARKET_BEAR_THRESHOLD}% 阈值，买入信号已屏蔽，建议观望。`,
        action: '观望', deadline: null,
      });
    } else {
      // 在保留的指令上附注大盘环境
      filtered.forEach(c => {
        c.instruction += ` [大盘今日 ${marketEnv.changePercent.toFixed(2)}%，买入信号已屏蔽]`;
      });
    }
    return resolveConflicts(filtered);
  }

  // ─── 信号冲突解决：只保留最高优先级层级的指令 ───
  return resolveConflicts(commands);
}

/**
 * 指令优先级层级（P0→P3）
 * P0: 风控止损 — 保命第一，有 P0 则屏蔽一切交易信号
 * P1: 仓位管理 — 止盈/减仓/首次破位，有 P1 则屏蔽买入
 * P2: 交易执行 — 买入/补仓/持有信号
 * P3: 观察等待 — 无明确方向
 */
const COMMAND_TIERS = {
  // P0 风控止损 — 保命第一
  stop_loss: 0, protective_profit: 0,
  // P1 仓位管理 — 止盈/减仓
  take_profit: 1, partial_profit: 1, first_break: 1,
  // P2 交易执行 — 买入/补仓/强势持有/趋势持有
  buy_pullback: 2, buy_ma10: 2,
  dip_buy_heavy: 2, dip_buy_medium: 2, dip_buy_light: 2,
  hold_dip_strong: 2, hold_bullish: 2,
  // P3 观察 — 无明确买卖方向
  hold_dip_weak: 3, hold_through_dip: 3,
  avoid: 3,
  neutral_hold: 3, neutral_caution: 3, neutral_wait: 3,
  market_bear_wait: 3,
};

function getTier(cmd) {
  return COMMAND_TIERS[cmd.type] ?? 3;
}

function resolveConflicts(commands) {
  if (commands.length <= 1) return commands;

  const minTier = Math.min(...commands.map(getTier));
  const kept = commands.filter(c => getTier(c) === minTier);

  if (kept.length < commands.length) {
    const dropped = commands.filter(c => getTier(c) > minTier);
    kept._conflictNote = dropped.map(c => c.label).join('、');
  }

  return kept;
}

function countDaysBelowMA20(historyNav, ma20, days = 5) {
  if (!historyNav || !ma20) return 0;
  let count = 0;
  for (let i = 0; i < Math.min(days, historyNav.length); i++) {
    if (historyNav[i].nav < ma20) count++;
    else break;
  }
  return count;
}

module.exports = {
  calcMA,
  analyzeKlineTrend,
  analyzeCapitalFlow,
  generateRecommendation,
  detectStructure,
  calcFundCompositeMA,
  generateIntradayCommands,
  resolveConflicts,
  countDaysBelowMA20,
  getTier,
};
