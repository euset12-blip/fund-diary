/**
 * lib/analytics.js 单元测试
 * 覆盖: calcMASeries / countDaysBelowMA / calcVolatility / dynamicThresholds / calcMASlope / trendAdjustedMultipliers
 */
import { describe, it, expect } from 'vitest';
import analytics from './analytics.js';
const { calcMASeries, countDaysBelowMA, calcVolatility, dynamicThresholds, calcMASlope, trendAdjustedMultipliers } = analytics;

// calcMASeries — 输入 旧→新，返回 number[]
describe('calcMASeries(prices, period)', () => {
  it('应该 [1..10] period=5 返回 6 个均值', () => {
    const r = calcMASeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(r.length).toBe(6);
    expect(r[0]).toBe(3);
    expect(r[5]).toBe(8);
  });
  it('应该长度恰好等于 period 时返回 1 个均值', () => {
    expect(calcMASeries([2, 4, 6, 8, 10], 5)).toEqual([6]);
  });
  it('应该 data < period 时返回空数组', () => { expect(calcMASeries([1, 2, 3], 5)).toEqual([]); });
  it('应该空数组返回空数组', () => { expect(calcMASeries([], 3)).toEqual([]); });
  it('应该 period=1 时返回原数组的副本', () => {
    expect(calcMASeries([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });
  it('应该返回长度为 N - period + 1', () => {
    const r = calcMASeries([10, 20, 30, 40, 50, 60], 3);
    expect(r.length).toBe(4);
    expect(r[0]).toBe(20);
    expect(r[3]).toBe(50);
  });
  it('应该处理浮点数价格', () => {
    const r = calcMASeries([1.1, 1.2, 1.3, 1.4, 1.5], 3);
    expect(r[0]).toBeCloseTo(1.2, 6);
    expect(r[2]).toBeCloseTo(1.4, 6);
  });
});

// countDaysBelowMA — navs 新→旧，连续计数
describe('countDaysBelowMA(navs, ma)', () => {
  it('应该连续低于均线时正确计数', () => {
    const navs = [{ nav: 0.9 }, { nav: 0.91 }, { nav: 0.95 }, { nav: 1.1 }, { nav: 1.2 }];
    expect(countDaysBelowMA(navs, 1.0)).toBe(3);
  });
  it('应该首日就高于均线时返回 0', () => {
    expect(countDaysBelowMA([{ nav: 1.5 }, { nav: 0.9 }], 1.0)).toBe(0);
  });
  it('应该全部低于均线时返回数组长度', () => {
    expect(countDaysBelowMA([{ nav: 0.1 }, { nav: 0.2 }, { nav: 0.3 }], 1.0)).toBe(3);
  });
  it('应该数组为空时返回 0', () => { expect(countDaysBelowMA([], 1.0)).toBe(0); });
  it('应该 nav 等于 ma 时不计数（严格小于）', () => {
    expect(countDaysBelowMA([{ nav: 1.0 }, { nav: 0.9 }], 1.0)).toBe(0);
  });
  it('应该一旦回到均线上方就停止', () => {
    const navs = [{ nav: 0.9 }, { nav: 0.95 }, { nav: 1.1 }, { nav: 0.5 }, { nav: 0.3 }];
    expect(countDaysBelowMA(navs, 1.0)).toBe(2);
  });
});

// calcVolatility — 输入 旧→新
describe('calcVolatility(navs, lookback)', () => {
  it('应该输入数据过少时返回 null', () => {
    const navs = Array.from({ length: 10 }, (_, i) => ({ nav: 1.0 + i * 0.01 }));
    expect(calcVolatility(navs, 90)).toBeNull();
  });
  it('应该输入 null/undefined 时返回 null', () => {
    expect(calcVolatility(null)).toBeNull();
    expect(calcVolatility(undefined)).toBeNull();
  });
  it('应该收益率不足 20 时返回 null', () => {
    const navs = Array.from({ length: 11 }, (_, i) => ({ nav: 1.0 + i * 0.01 }));
    expect(calcVolatility(navs, 10)).toBeNull();
  });
  it('应该平盘时 stddev=0', () => {
    const navs = Array.from({ length: 100 }, () => ({ nav: 1.0 }));
    const r = calcVolatility(navs, 90);
    expect(r).not.toBeNull();
    expect(r.stddev).toBe(0);
    expect(r.mean).toBe(0);
    expect(r.count).toBeGreaterThanOrEqual(20);
  });
  it('应该正常波动序列返回有效统计量', () => {
    const navs = [];
    let v = 1.0;
    for (let i = 0; i < 120; i++) {
      v *= (1 + (i % 2 === 0 ? 0.01 : -0.01));
      navs.push({ nav: v });
    }
    const r = calcVolatility(navs, 90);
    expect(r).not.toBeNull();
    expect(r.stddev).toBeGreaterThan(0);
    expect(r.count).toBeGreaterThanOrEqual(20);
  });
  it('应该忽略 nav <=0 的无效收益率', () => {
    const navs = Array.from({ length: 100 }, (_, i) => ({ nav: i === 0 ? 0 : 1.0 + i * 0.001 }));
    const r = calcVolatility(navs, 90);
    expect(r).not.toBeNull();
    expect(r.count).toBeLessThan(100);
  });
});

// dynamicThresholds(volatility, multipliers)
describe('dynamicThresholds(volatility, multipliers)', () => {
  it('应该使用默认乘数返回 4 个字段', () => {
    const r = dynamicThresholds(0.02);
    expect(r.stopLoss).toBeCloseTo(-4, 6);
    expect(r.dipBuy).toBeCloseTo(-3, 6);
    expect(r.takeProfit).toBeCloseTo(5, 6);
    expect(r.dailyVolatility).toBeCloseTo(2, 6);
  });
  it('应该 volatility=0 时所有阈值为 0', () => {
    const r = dynamicThresholds(0);
    expect(r.stopLoss).toBe(-0);
    expect(r.takeProfit).toBe(0);
  });
  it('应该自定义乘数生效', () => {
    const r = dynamicThresholds(0.01, { stopLoss: -3, dipBuy: -2, takeProfit: 4 });
    expect(r.stopLoss).toBeCloseTo(-3, 6);
    expect(r.takeProfit).toBeCloseTo(4, 6);
  });
  it('应该波动率放大时阈值同比例放大', () => {
    const small = dynamicThresholds(0.01);
    const big = dynamicThresholds(0.05);
    expect(Math.abs(big.stopLoss)).toBeGreaterThan(Math.abs(small.stopLoss));
    expect(big.takeProfit).toBeGreaterThan(small.takeProfit);
  });
});

// calcMASlope — 输入 旧→新
describe('calcMASlope(prices, period, lookback)', () => {
  it('应该数据不足时返回 null', () => { expect(calcMASlope([1, 2, 3], 20, 5)).toBeNull(); });
  it('应该上升趋势返回 trend=up', () => {
    const prices = Array.from({ length: 40 }, (_, i) => 1.0 + i * 0.01);
    const r = calcMASlope(prices, 20, 5);
    expect(r.trend).toBe('up');
    expect(r.slope).toBeGreaterThan(0);
  });
  it('应该下降趋势返回 trend=down', () => {
    const prices = Array.from({ length: 40 }, (_, i) => 2.0 - i * 0.01);
    const r = calcMASlope(prices, 20, 5);
    expect(r.trend).toBe('down');
    expect(r.slope).toBeLessThan(0);
  });
  it('应该平盘返回 trend=flat', () => {
    const prices = Array.from({ length: 40 }, () => 1.0);
    const r = calcMASlope(prices, 20, 5);
    expect(r.trend).toBe('flat');
    expect(r.slope).toBe(0);
  });
  it('应该自定义 period 与 lookback', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 1.0 + i * 0.005);
    expect(calcMASlope(prices, 10, 3).trend).toBe('up');
  });
  it('应该返回的 slope/pctPerDay 经过 toFixed 处理', () => {
    const prices = Array.from({ length: 40 }, (_, i) => 1.0 + i * 0.01);
    const r = calcMASlope(prices, 20, 5);
    expect(String(r.slope)).toMatch(/^-?\d+(\.\d{1,3})?$/);
    expect(String(r.pctPerDay)).toMatch(/^-?\d+(\.\d{1,4})?$/);
  });
});

// trendAdjustedMultipliers(trend, base)
describe('trendAdjustedMultipliers(trend, base)', () => {
  const base = { stopLoss: -2, dipBuy: -1.5, takeProfit: 2.5 };
  it('应该 trend=up 时收紧止损/止盈，放宽补仓', () => {
    const r = trendAdjustedMultipliers('up', base);
    expect(r.stopLoss).toBeCloseTo(-1.6, 6);
    expect(r.dipBuy).toBeCloseTo(-1.95, 6);
    expect(r.takeProfit).toBeCloseTo(1.75, 6);
  });
  it('应该 trend=down 时放宽止损/止盈，收紧补仓', () => {
    const r = trendAdjustedMultipliers('down', base);
    expect(r.stopLoss).toBeCloseTo(-2.6, 6);
    expect(r.dipBuy).toBeCloseTo(-0.9, 6);
    expect(r.takeProfit).toBeCloseTo(3.5, 6);
  });
  it('应该 trend=flat 时保持原值', () => {
    const r = trendAdjustedMultipliers('flat', base);
    expect(r.stopLoss).toBe(-2);
    expect(r.dipBuy).toBe(-1.5);
    expect(r.takeProfit).toBe(2.5);
  });
  it('应该未提供 base 时使用默认值', () => {
    const r = trendAdjustedMultipliers('up');
    expect(r.stopLoss).toBeCloseTo(-1.6, 6);
  });
  it('应该未知趋势字符串保持 base 不变', () => {
    const r = trendAdjustedMultipliers('sideways', base);
    expect(r.stopLoss).toBe(-2);
  });
  it('应该返回的是新对象而非引用 base', () => {
    const r = trendAdjustedMultipliers('up', base);
    expect(r).not.toBe(base);
    expect(base.stopLoss).toBe(-2);
  });
});
