/**
 * fund-scoring.js 单元测试
 * 覆盖: calcMA / scoreTrend / scoreMomentum / scoreFlow / scoreDrawdown / scoreSectorHeat / fmtMoney / getAction
 */
import { describe, it, expect } from 'vitest';
import scoring from './fund-scoring.js';
const { calcMA, scoreTrend, scoreMomentum, scoreFlow, scoreDrawdown, scoreSectorHeat, fmtMoney, getAction } = scoring;

// ─── 模拟数据工厂 ───

/** historyNav — 新→旧数组：index 0 = 最新一天，index count-1 = 最老 */
function genHistoryNav({ count = 80, latest = 1.5, daily = 0, noise = 0 } = {}) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    let val = latest - i * daily;
    if (noise) val += (Math.sin(i * 1.3) * noise);
    arr.push({ nav: +val.toFixed(6), date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}` });
  }
  return arr;
}

/** sectorKlines — 旧→新 */
function genSectorKlines({ count = 30, start = 100, daily = 0 } = {}) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({ close: +(start + i * daily).toFixed(4), date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}` });
  }
  return arr;
}

/** benchmark — 旧→新 */
function genBenchmark({ count = 80, start = 4000, daily = 0 } = {}) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({ close: +(start + i * daily).toFixed(4), date: '2024-01-01' });
  }
  return arr;
}

// ═════════════════════════════════════════
// calcMA — 输入纯数字数组，返回 [{idx, value}]
// ═════════════════════════════════════════
describe('calcMA(arr, period)', () => {
  it('应该对 [1..10] 周期 5 返回 6 个结果且首个 idx=4 value=3', () => {
    const r = calcMA([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(r.length).toBe(6);
    expect(r[0]).toEqual({ idx: 4, value: 3 });
    expect(r[5]).toEqual({ idx: 9, value: 8 });
  });

  it('应该数据不足时返回空数组', () => {
    expect(calcMA([1, 2, 3], 5)).toEqual([]);
  });

  it('应该长度恰好等于 period 时返回 1 个结果', () => {
    const r = calcMA([2, 4, 6, 8, 10], 5);
    expect(r).toEqual([{ idx: 4, value: 6 }]);
  });

  it('应该空数组返回空数组', () => {
    expect(calcMA([], 5)).toEqual([]);
    expect(calcMA([], 1)).toEqual([]);
  });

  it('应该 period=1 时返回与原数组等长的结果', () => {
    const r = calcMA([1, 2, 3], 1);
    expect(r.length).toBe(3);
    expect(r[0]).toEqual({ idx: 0, value: 1 });
    expect(r[2]).toEqual({ idx: 2, value: 3 });
  });

  it('应该处理浮点精度', () => {
    const r = calcMA([0.1, 0.2, 0.3], 3);
    expect(r.length).toBe(1);
    expect(r[0].value).toBeCloseTo(0.2, 6);
  });

  it('应该处理大窗口 period=20', () => {
    const arr = Array.from({ length: 30 }, (_, i) => i + 1);
    const r = calcMA(arr, 20);
    expect(r.length).toBe(11);
    expect(r[0]).toEqual({ idx: 19, value: 10.5 });
  });

  it('应该 idx 单调递增', () => {
    const r = calcMA([1, 2, 3, 4, 5, 6, 7], 3);
    for (let i = 1; i < r.length; i++) expect(r[i].idx).toBeGreaterThan(r[i - 1].idx);
  });
});

// ═════════════════════════════════════════
// scoreTrend(historyNav, valuation)
// ═════════════════════════════════════════
describe('scoreTrend(historyNav, valuation)', () => {
  it('应该上升趋势的基金 score ≥ 90 且包含多头信号', () => {
    const nav = genHistoryNav({ count: 80, latest: 1.6, daily: 0.005 });
    const r = scoreTrend(nav, null);
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.signals.join('|')).toMatch(/多头/);
  });

  it('应该下降趋势的基金 score < 30', () => {
    const nav = genHistoryNav({ count: 80, latest: 1.0, daily: -0.005 });
    const r = scoreTrend(nav, null);
    expect(r.score).toBeLessThan(30);
    expect(r.signals.join('|')).toMatch(/空头|破位/);
  });

  it('应该震荡走势的基金 score 落在中等区间', () => {
    const nav = genHistoryNav({ count: 80, latest: 1.0, daily: 0 });
    const r = scoreTrend(nav, null);
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThanOrEqual(80);
  });

  it('应该数据 <20 条时返回 50 分并标注数据不足', () => {
    const nav = genHistoryNav({ count: 10, latest: 1.0, daily: 0.01 });
    const r = scoreTrend(nav, null);
    expect(r.score).toBe(50);
    expect(r.detail.note).toBe('数据不足');
    expect(r.signals).toEqual([]);
  });

  it('应该恰好 20 条数据时正常评分不降级', () => {
    const nav = genHistoryNav({ count: 20, latest: 1.5, daily: 0.005 });
    const r = scoreTrend(nav, null);
    expect(r.score).toBeGreaterThan(50);
    expect(r.detail.note).toBeUndefined();
  });

  it('应该 valuation 参数生效（轻度偏离 → 触发超买信号）', () => {
    const nav = genHistoryNav({ count: 60, latest: 1.0, daily: 0 });
    const r = scoreTrend(nav, { valuation: 1.08 }); // 拉高8%，触发中等超买
    expect(r.signals.join('|')).toMatch(/超买/);
  });

  it('应该严重偏离（>10%）触发趋势分腰斩', () => {
    const nav = genHistoryNav({ count: 60, latest: 1.0, daily: 0 });
    const r = scoreTrend(nav, { valuation: 2.0 }); // 拉高100%，触发严重档
    expect(r.signals.join('|')).toMatch(/严重偏离MA20/);
    expect(r.detail.overboughtPenalty).toBe('severe');
  });

  it('应该 score 永远在 [0,100] 区间内（5 个场景）', () => {
    const scenarios = [
      genHistoryNav({ count: 80, latest: 5.0, daily: 0.05 }),
      genHistoryNav({ count: 80, latest: 0.5, daily: -0.05 }),
      genHistoryNav({ count: 80, latest: 1.0, daily: 0 }),
      genHistoryNav({ count: 80, latest: 1.0, daily: 0, noise: 0.05 }),
      genHistoryNav({ count: 25, latest: 1.0, daily: 0.001 }),
    ];
    for (const nav of scenarios) {
      const r = scoreTrend(nav, null);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(Array.isArray(r.signals)).toBe(true);
      expect(r.detail).toBeDefined();
    }
  });

  it('应该破位时给出深度破位信号', () => {
    const nav = genHistoryNav({ count: 60, latest: 1.0, daily: 0 });
    const r = scoreTrend(nav, { valuation: 0.8 });
    expect(r.signals.join('|')).toMatch(/破位/);
  });

  it('应该 valuation=null 时使用历史最新净值', () => {
    const nav = genHistoryNav({ count: 60, latest: 1.5, daily: 0.005 });
    const r = scoreTrend(nav, null);
    expect(r.score).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════
// scoreMomentum(historyNav, benchmarkData)
// ═════════════════════════════════════════
describe('scoreMomentum(historyNav, benchmarkData)', () => {
  it('应该 <5 条数据时返回 50', () => {
    const nav = genHistoryNav({ count: 4, latest: 1.0, daily: 0.01 });
    const r = scoreMomentum(nav, null);
    expect(r.score).toBe(50);
  });

  it('应该 1月大涨场景 score 高且含上涨信号', () => {
    const nav = genHistoryNav({ count: 140, latest: 1.2, daily: 0.005 });
    const r = scoreMomentum(nav, null);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.signals.join('|')).toMatch(/大涨|上涨/);
  });

  it('应该 1月大跌场景 score 低', () => {
    const nav = genHistoryNav({ count: 140, latest: 1.0, daily: -0.005 });
    const r = scoreMomentum(nav, null);
    expect(r.score).toBeLessThan(50);
    expect(r.signals.join('|')).toMatch(/下跌|大跌|跌幅/);
  });

  it('应该 3月超跌（<-25%）时给出"超跌反弹"信号', () => {
    const nav = genHistoryNav({ count: 140, latest: 1.0, daily: -0.01 });
    const r = scoreMomentum(nav, null);
    expect(r.signals.join('|')).toMatch(/超跌|反弹/);
  });

  it('应该跑赢基准时 score 上加且给信号', () => {
    const nav = genHistoryNav({ count: 140, latest: 1.3, daily: 0.005 });
    const bm = genBenchmark({ count: 100, start: 4000, daily: 0 });
    const r = scoreMomentum(nav, bm);
    expect(r.signals.join('|')).toMatch(/跑赢/);
    expect(r.detail.relativeStrength).toBeGreaterThan(0);
  });

  it('应该跑输基准时给出跑输信号', () => {
    const nav = genHistoryNav({ count: 140, latest: 1.0, daily: -0.005 });
    const bm = genBenchmark({ count: 100, start: 4000, daily: 5 });
    const r = scoreMomentum(nav, bm);
    expect(r.signals.join('|')).toMatch(/跑输|下跌/);
  });

  it('应该短反弹（1周涨1月跌）场景不崩溃', () => {
    const arr = [];
    for (let i = 0; i < 140; i++) {
      let val;
      if (i < 5) val = 1.10 - i * 0.005;
      else if (i < 22) val = 1.0 + (i - 5) * 0.005;
      else val = 1.5 - i * 0.001;
      arr.push({ nav: val, date: '2024-01-01' });
    }
    const r = scoreMomentum(arr, null);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('应该 score 永远在 [0,100] 区间（极值与四象限）', () => {
    const cases = [
      genHistoryNav({ count: 140, latest: 5.0, daily: 0.05 }),
      genHistoryNav({ count: 140, latest: 0.1, daily: -0.05 }),
      genHistoryNav({ count: 140, latest: 1.0, daily: 0 }),
      genHistoryNav({ count: 6, latest: 1.0, daily: 0.01 }),
    ];
    for (const nav of cases) {
      const r = scoreMomentum(nav, genBenchmark({ count: 100, daily: 1 }));
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.detail).toHaveProperty('returns');
    }
  });

  it('应该无基准数据时也能返回有效分', () => {
    const nav = genHistoryNav({ count: 140, latest: 1.1, daily: 0.001 });
    const r = scoreMomentum(nav, null);
    expect(r.detail.relativeStrength).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

// ═════════════════════════════════════════
// scoreDrawdown — historyNav 新→旧（函数内部 reverse 为旧→新后计算）
// ═════════════════════════════════════════
describe('scoreDrawdown(historyNav)', () => {
  it('应该 <20 条时返回 50', () => {
    const r = scoreDrawdown(genHistoryNav({ count: 10, latest: 1.0, daily: 0 }));
    expect(r.score).toBe(50);
  });

  it('应该接近前高时 score > 80 且信号含"接近前高"', () => {
    const nav = genHistoryNav({ count: 60, latest: 1.5, daily: 0.005 });
    const r = scoreDrawdown(nav);
    expect(r.score).toBeGreaterThan(80);
    expect(r.signals.join('|')).toMatch(/接近前高/);
  });

  it('应该大幅回撤时 score < 35', () => {
    const nav = genHistoryNav({ count: 60, latest: 0.5, daily: -0.01 });
    const r = scoreDrawdown(nav);
    expect(r.score).toBeLessThan(35);
  });

  it('应该深度回撤 >25% 时给出深度套牢信号', () => {
    const nav = genHistoryNav({ count: 60, latest: 0.6, daily: -0.008 });
    const r = scoreDrawdown(nav);
    expect(r.signals.join('|')).toMatch(/深度套牢/);
  });

  it('应该 V 型恢复后给出"从最大回撤恢复"信号', () => {
    const arr = [];
    for (let i = 0; i < 60; i++) {
      let val;
      if (i < 30) val = 1.0 - i * (0.4 / 29);
      else val = 0.6 + (i - 30) * (0.35 / 29);
      arr.push({ nav: val, date: '2024-01-01' });
    }
    arr.reverse();
    const r = scoreDrawdown(arr);
    expect(r.signals.join('|')).toMatch(/恢复/);
  });

  it('应该历史最大回撤 >40% 给出高风险品种信号', () => {
    const arr = [];
    for (let i = 0; i < 60; i++) {
      let val;
      if (i < 40) val = 1.0 - i * (0.5 / 39);
      else val = 0.5 + (i - 40) * 0.003;
      arr.push({ nav: val, date: '2024-01-01' });
    }
    arr.reverse();
    const r = scoreDrawdown(arr);
    expect(r.signals.join('|')).toMatch(/历史最大回撤|高风险品种/);
  });

  it('应该 nav 全为 0 时不崩溃返回 50', () => {
    const arr = Array.from({ length: 60 }, () => ({ nav: 0, date: '2024-01-01' }));
    const r = scoreDrawdown(arr);
    expect(r.score).toBe(50);
    expect(Number.isNaN(r.score)).toBe(false);
  });

  it('应该 nav 含 NaN 时不崩溃且不返回 NaN 分', () => {
    const arr = Array.from({ length: 60 }, () => ({ nav: NaN, date: '2024-01-01' }));
    const r = scoreDrawdown(arr);
    expect(r.score).toBe(50);
    expect(Number.isNaN(r.score)).toBe(false);
  });

  it('应该 peak 为负值时安全降级', () => {
    const arr = Array.from({ length: 60 }, (_, i) => ({ nav: -1 - i * 0.01, date: '2024-01-01' }));
    const r = scoreDrawdown(arr);
    expect(r.score).toBe(50);
    expect(Number.isNaN(r.score)).toBe(false);
  });

  it('应该 score 永远在 [0,100] 区间', () => {
    const cases = [
      genHistoryNav({ count: 60, latest: 1.5, daily: 0.005 }),
      genHistoryNav({ count: 60, latest: 0.5, daily: -0.005 }),
      genHistoryNav({ count: 60, latest: 1.0, daily: 0 }),
      genHistoryNav({ count: 30, latest: 1.0, daily: 0.001 }),
    ];
    for (const nav of cases) {
      const r = scoreDrawdown(nav);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });
});

// ═════════════════════════════════════════
// scoreFlow(indexQuote, fundType)
// ═════════════════════════════════════════
describe('scoreFlow(indexQuote, fundType)', () => {
  it('应该 indexQuote 为 null 时不可用且 score=null', () => {
    const r = scoreFlow(null, 'index');
    expect(r.score).toBeNull();
    expect(r.available).toBe(false);
    expect(r.signals[0]).toMatch(/不可用/);
  });

  ['qdii', 'hk', 'commodity'].forEach(t => {
    it(`应该 fundType=${t} 时不可用`, () => {
      const r = scoreFlow({ mainFlow: 5e8 }, t);
      expect(r.score).toBeNull();
      expect(r.available).toBe(false);
    });
  });

  it('应该主力大额净流入>1亿时 score≥90 且信号含"大额净流入"', () => {
    const r = scoreFlow({ mainFlow: 5e8, superLargeNet: 2e8, largeNet: 0, turnover: 5 }, 'index');
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.signals.join('|')).toMatch(/大额净流入/);
    expect(r.available).toBe(true);
  });

  it('应该主力流出>1亿时 score≤20', () => {
    const r = scoreFlow({ mainFlow: -5e8, superLargeNet: -2e8, largeNet: -1e8, turnover: 5 }, 'index');
    expect(r.score).toBeLessThanOrEqual(20);
    expect(r.signals.join('|')).toMatch(/净流出/);
  });

  it('应该普通净流入（<1亿）加分且不触发"大额"信号', () => {
    const small = scoreFlow({ mainFlow: 5e7, superLargeNet: 1e7, turnover: 4 }, 'index');
    const large = scoreFlow({ mainFlow: 5e8, superLargeNet: 2e8, turnover: 4 }, 'index');
    expect(small.score).toBeGreaterThan(50);
    expect(small.signals.join('|')).not.toMatch(/大额净流入/);
    expect(large.score).toBeGreaterThanOrEqual(small.score);
  });

  it('应该超大单大幅流入触发对应信号', () => {
    const r = scoreFlow({ mainFlow: 5e7, superLargeNet: 2e8, turnover: 4 }, 'index');
    expect(r.signals.join('|')).toMatch(/超大单大幅流入/);
  });

  it('应该超大单大幅流出触发对应信号', () => {
    const r = scoreFlow({ mainFlow: -5e7, superLargeNet: -2e8, turnover: 4 }, 'index');
    expect(r.signals.join('|')).toMatch(/超大单大幅流出/);
  });

  it('应该换手率在 2-8% 区间时加分', () => {
    const high = scoreFlow({ mainFlow: 0, superLargeNet: 0, turnover: 5 }, 'index');
    const noTo = scoreFlow({ mainFlow: 0, superLargeNet: 0, turnover: 0 }, 'index');
    expect(high.score).toBeGreaterThan(noTo.score);
  });

  it('应该换手率 >15% 时扣分并给出过高信号', () => {
    const r = scoreFlow({ mainFlow: 0, superLargeNet: 0, turnover: 20 }, 'index');
    expect(r.signals.join('|')).toMatch(/换手率.*过高/);
  });

  it('应该换手率 <1% 时扣分', () => {
    const lowTo = scoreFlow({ mainFlow: 0, superLargeNet: 0, turnover: 0.5 }, 'index');
    const okTo = scoreFlow({ mainFlow: 0, superLargeNet: 0, turnover: 5 }, 'index');
    expect(lowTo.score).toBeLessThan(okTo.score);
  });

  it('应该 score 永远在 [0,100]', () => {
    const cases = [
      { mainFlow: 1e10, superLargeNet: 1e10, turnover: 50 },
      { mainFlow: -1e10, superLargeNet: -1e10, turnover: 50 },
      { mainFlow: 0, superLargeNet: 0, turnover: 0 },
      { mainFlow: 1, superLargeNet: 1, turnover: 5 },
    ];
    for (const q of cases) {
      const r = scoreFlow(q, 'index');
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });
});

// ═════════════════════════════════════════
// scoreSectorHeat(sectorKlines, benchmarkData)
// ═════════════════════════════════════════
describe('scoreSectorHeat(sectorKlines, benchmarkData)', () => {
  it('应该 sectorKlines=null 时不可用', () => {
    const r = scoreSectorHeat(null, null);
    expect(r.score).toBeNull();
    expect(r.available).toBe(false);
  });

  it('应该 sectorKlines <20 条时不可用', () => {
    const r = scoreSectorHeat(genSectorKlines({ count: 10, start: 100, daily: 1 }), null);
    expect(r.score).toBeNull();
    expect(r.available).toBe(false);
  });

  it('应该首条价格异常（0/NaN）时不可用', () => {
    const arr = genSectorKlines({ count: 30, start: 100, daily: 1 });
    arr[0] = { close: 0, date: '2024-01-01' };
    expect(scoreSectorHeat(arr, null).available).toBe(false);
    arr[0] = { close: NaN, date: '2024-01-01' };
    expect(scoreSectorHeat(arr, null).available).toBe(false);
  });

  it('应该板块多头排列时 score > 70 且含"板块多头排列"', () => {
    const kl = genSectorKlines({ count: 30, start: 100, daily: 2 });
    const r = scoreSectorHeat(kl, null);
    expect(r.score).toBeGreaterThan(70);
    expect(r.signals.join('|')).toMatch(/板块多头排列/);
    expect(r.available).toBe(true);
  });

  it('应该板块空头排列时扣分并给出空头信号', () => {
    const kl = genSectorKlines({ count: 30, start: 200, daily: -2 });
    const r = scoreSectorHeat(kl, null);
    expect(r.signals.join('|')).toMatch(/板块空头排列/);
    expect(r.score).toBeLessThan(70);
  });

  it('应该跑赢基准时给出跑赢信号', () => {
    const kl = genSectorKlines({ count: 30, start: 100, daily: 3 });
    const bm = genBenchmark({ count: 30, start: 4000, daily: 0 });
    const r = scoreSectorHeat(kl, bm);
    expect(r.signals.join('|')).toMatch(/跑赢/);
    expect(r.detail.relativeReturn).toBeGreaterThan(0);
  });

  it('应该跑输基准时给出跑输信号', () => {
    const kl = genSectorKlines({ count: 30, start: 100, daily: -1 });
    const bm = genBenchmark({ count: 30, start: 4000, daily: 10 });
    const r = scoreSectorHeat(kl, bm);
    expect(r.signals.join('|')).toMatch(/跑输/);
  });

  it('应该 score 永远在 [0,100]', () => {
    const cases = [
      genSectorKlines({ count: 30, start: 100, daily: 5 }),
      genSectorKlines({ count: 30, start: 200, daily: -5 }),
      genSectorKlines({ count: 30, start: 100, daily: 0 }),
      genSectorKlines({ count: 25, start: 100, daily: 0.1 }),
    ];
    const bm = genBenchmark({ count: 30, start: 4000, daily: 1 });
    for (const kl of cases) {
      const r = scoreSectorHeat(kl, bm);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });
});

// ═════════════════════════════════════════
// fmtMoney(n)
// ═════════════════════════════════════════
describe('fmtMoney(n)', () => {
  it('应该 >=1亿 用"亿"单位', () => {
    expect(fmtMoney(2.5e8)).toBe('2.50亿');
    expect(fmtMoney(1e9)).toBe('10.00亿');
  });

  it('应该 1万 ~ 1亿 用"万"单位', () => {
    expect(fmtMoney(5e4)).toBe('5.00万');
    expect(fmtMoney(1.2e7)).toBe('1200.00万');
  });

  it('应该小额数字（<1万）直接整数显示', () => {
    expect(fmtMoney(999)).toBe('999');
    expect(fmtMoney(0)).toBe('0');
    expect(fmtMoney(100.6)).toBe('101');
  });

  it('应该 null/undefined/NaN 返回 "--"', () => {
    expect(fmtMoney(null)).toBe('--');
    expect(fmtMoney(undefined)).toBe('--');
    expect(fmtMoney(NaN)).toBe('--');
  });

  it('应该负数也能正确显示带"亿"/"万"', () => {
    expect(fmtMoney(-2.5e8)).toBe('-2.50亿');
    expect(fmtMoney(-3e4)).toBe('-3.00万');
    expect(fmtMoney(-500)).toBe('-500');
  });

  it('应该边界值 1e8 恰好触发"亿"', () => {
    expect(fmtMoney(1e8)).toBe('1.00亿');
  });

  it('应该边界值 1e4 恰好触发"万"', () => {
    expect(fmtMoney(1e4)).toBe('1.00万');
  });
});

// ═════════════════════════════════════════
// getAction(score)
// ═════════════════════════════════════════
describe('getAction(score)', () => {
  it('应该 score >= 75 → 强烈加仓 green priority=1', () => {
    const r = getAction(85);
    expect(r.label).toMatch(/强烈加仓/);
    expect(r.color).toBe('green');
    expect(r.priority).toBe(1);
  });

  it('应该 65-74 → 考虑加仓 green priority=2', () => {
    const r = getAction(70);
    expect(r.label).toMatch(/考虑加仓/);
    expect(r.color).toBe('green');
    expect(r.priority).toBe(2);
  });

  it('应该 45-64 → 持有观望 yellow priority=3', () => {
    const r = getAction(55);
    expect(r.label).toMatch(/持有观望/);
    expect(r.color).toBe('yellow');
    expect(r.priority).toBe(3);
  });

  it('应该 35-44 → 考虑减仓 red priority=4', () => {
    const r = getAction(40);
    expect(r.label).toMatch(/考虑减仓/);
    expect(r.color).toBe('red');
    expect(r.priority).toBe(4);
  });

  it('应该 <35 → 强烈卖出 red priority=5', () => {
    const r = getAction(20);
    expect(r.label).toMatch(/强烈卖出/);
    expect(r.color).toBe('red');
    expect(r.priority).toBe(5);
  });

  it('应该 NaN/null → 数据不足 priority=99', () => {
    expect(getAction(NaN).priority).toBe(99);
    expect(getAction(NaN).label).toMatch(/数据不足/);
    expect(getAction(null).priority).toBe(99);
    expect(getAction(null).label).toMatch(/数据不足/);
  });

  it('应该边界值 75/74/65/64/45/44/35/34 精确分档', () => {
    expect(getAction(75).priority).toBe(1);
    expect(getAction(74).priority).toBe(2);
    expect(getAction(65).priority).toBe(2);
    expect(getAction(64).priority).toBe(3);
    expect(getAction(45).priority).toBe(3);
    expect(getAction(44).priority).toBe(4);
    expect(getAction(35).priority).toBe(4);
    expect(getAction(34).priority).toBe(5);
  });

  it('应该所有有效返回都包含 label/color/priority 三个属性', () => {
    [100, 70, 50, 40, 0, NaN, null].forEach(s => {
      const r = getAction(s);
      expect(r).toHaveProperty('label');
      expect(r).toHaveProperty('color');
      expect(r).toHaveProperty('priority');
    });
  });
});
