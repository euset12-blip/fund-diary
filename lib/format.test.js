/**
 * lib/format.js 单元测试
 * 覆盖: formatMoney / formatPercent / formatProfit / barChart
 */
import { describe, it, expect } from 'vitest';
import format from './format.js';
const { formatMoney, formatPercent, formatProfit, barChart } = format;

describe('formatMoney(n)', () => {
  it('应该 >=1万亿 用"万亿"', () => {
    expect(formatMoney(1.5e12)).toBe('1.50万亿');
    expect(formatMoney(1e12)).toBe('1.00万亿');
  });
  it('应该 >=1亿 用"亿"', () => {
    expect(formatMoney(2.5e8)).toBe('2.50亿');
    expect(formatMoney(1e8)).toBe('1.00亿');
  });
  it('应该 >=1万 用"万"', () => {
    expect(formatMoney(1.23e4)).toBe('1.23万');
    expect(formatMoney(99999)).toBe('10.00万');
  });
  it('应该 <1万 保留 2 位小数', () => {
    expect(formatMoney(123.456)).toBe('123.46');
    expect(formatMoney(0)).toBe('0.00');
  });
  it('应该 null/undefined/NaN 返回 "--"', () => {
    expect(formatMoney(null)).toBe('--');
    expect(formatMoney(undefined)).toBe('--');
    expect(formatMoney(NaN)).toBe('--');
  });
  it('应该负数也用同一档位', () => {
    expect(formatMoney(-3e8)).toBe('-3.00亿');
    expect(formatMoney(-5000)).toBe('-5000.00');
  });
  it('应该万亿边界值 1e12 恰好触发"万亿"', () => {
    expect(formatMoney(1e12)).toBe('1.00万亿');
  });
  it('应该 9999.99 显示为数字而非"万"', () => {
    expect(formatMoney(9999.99)).toBe('9999.99');
  });
});

describe('formatPercent(n)', () => {
  it('应该正数带 + 号', () => { expect(formatPercent(3.14)).toBe('+3.14%'); });
  it('应该 0 带 + 号', () => { expect(formatPercent(0)).toBe('+0.00%'); });
  it('应该负数自然带 - 号', () => { expect(formatPercent(-2.5)).toBe('-2.50%'); });
  it('应该 null/undefined/NaN 返回 "--"', () => {
    expect(formatPercent(null)).toBe('--');
    expect(formatPercent(undefined)).toBe('--');
    expect(formatPercent(NaN)).toBe('--');
  });
  it('应该保留 2 位小数', () => {
    expect(formatPercent(1.235)).toMatch(/^\+1\.2[34]%$/);
    expect(formatPercent(0.005)).toMatch(/^\+0\.0[01]%$/);
  });
});

describe('formatProfit(amount, pct)', () => {
  it('应该正盈亏带 +¥ 前缀', () => { expect(formatProfit(1234.5, 5.5)).toBe('+¥1235 (+5.5%)'); });
  it('应该负盈亏带 -¥ 前缀', () => { expect(formatProfit(-500, -3.2)).toBe('-¥500 (-3.2%)'); });
  it('应该 pct 为 0 时仍输出', () => { expect(formatProfit(100, 0)).toBe('+¥100 (+0.0%)'); });
  it('应该缺省 pct 时不输出百分号部分', () => {
    expect(formatProfit(123)).toBe('+¥123');
    expect(formatProfit(-50)).toBe('-¥50');
  });
  it('应该 null/undefined/NaN 返回 "--"', () => {
    expect(formatProfit(null, 1)).toBe('--');
    expect(formatProfit(NaN, 1)).toBe('--');
  });
  it('应该 pct 为 NaN 时只输出金额部分', () => {
    expect(formatProfit(100, NaN)).toBe('+¥100');
    expect(formatProfit(100, null)).toBe('+¥100');
  });
  it('应该 0 正确归到正向', () => { expect(formatProfit(0, 0)).toBe('+¥0 (+0.0%)'); });
});

describe('barChart(value, max, width)', () => {
  it('应该完全填满（value=max）', () => { expect(barChart(10, 10, 10)).toBe('██████████'); });
  it('应该完全为空（value=0）', () => { expect(barChart(0, 10, 10)).toBe('░░░░░░░░░░'); });
  it('应该半满（value=max/2）', () => { expect(barChart(5, 10, 10)).toBe('█████░░░░░'); });
  it('应该默认宽度 20', () => { expect(barChart(10, 10).length).toBe(20); });
  it('应该接近满时几乎填满', () => { expect(barChart(9, 10, 10)).toBe('█████████░'); });
  it('应该负数按绝对值处理', () => { expect(barChart(-5, 10, 10)).toBe('█████░░░░░'); });
  it('应该 width=1 也能工作', () => {
    expect(barChart(10, 10, 1)).toBe('█');
    expect(barChart(0, 10, 1)).toBe('░');
  });
  it('应该所有输出只包含 █ 和 ░ 两种字符', () => {
    const out = barChart(7, 10, 10);
    expect(out).toMatch(/^[█░]+$/);
    expect(out.length).toBe(10);
  });
});
