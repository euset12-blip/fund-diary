import { describe, expect, it } from 'vitest';
import signalEngine from './signal-engine.js';

const {
  calcFundCompositeMA,
  countDaysBelowMA20,
  generateIntradayCommands,
} = signalEngine;

function makeMaData(overrides = {}) {
  return {
    valuation: 0.95,
    ma5: 0.98,
    ma10: 1,
    ma20: 1,
    alignment: 'short_bearish',
    nearMA20: false,
    nearMA10: false,
    devMA20: -5,
    ...overrides,
  };
}

function makeHistory(values) {
  return values.map((nav, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, nav }));
}

describe('countDaysBelowMA20', () => {
  it('counts only consecutive latest days below MA20', () => {
    expect(countDaysBelowMA20(makeHistory([0.9, 0.95, 0.99, 1.01, 0.8]), 1, 5)).toBe(3);
  });

  it('returns 0 when the latest day is above MA20', () => {
    expect(countDaysBelowMA20(makeHistory([1.01, 0.95, 0.9]), 1, 5)).toBe(0);
  });
});

describe('calcFundCompositeMA', () => {
  it('builds mixed MA data from historical NAV plus intraday valuation', () => {
    const history = makeHistory(Array.from({ length: 20 }, (_, i) => 1 + i * 0.01)).reverse();
    const result = calcFundCompositeMA(history, 1.25);

    expect(result.ma5).toBeGreaterThan(1);
    expect(result.ma20).toBeGreaterThan(1);
    expect(result.valuation).toBe(1.25);
    expect(result.devMA20).toBeTypeOf('number');
  });

  it('returns null when inputs are insufficient', () => {
    expect(calcFundCompositeMA(makeHistory([1, 1.01]), 1.02)).toBeNull();
    expect(calcFundCompositeMA(makeHistory([1, 1.01, 1.02, 1.03, 1.04]), 0)).toBeNull();
  });
});

describe('generateIntradayCommands', () => {
  it('emits stop_loss after three consecutive MA20 breaks for stop-loss strategies', () => {
    const commands = generateIntradayCommands(
      { code: '004253', name: '黄金' },
      makeMaData({ valuation: 0.94 }),
      { valuation: 0.94 },
      -6,
      makeHistory([0.94, 0.95, 0.96, 1.02]),
      { type: 'stop_loss' }
    );

    expect(commands[0].type).toBe('stop_loss');
    expect(commands[0].priority).toBe(1);
  });

  it('keeps hold_dip funds from direct stop-loss after MA20 breaks', () => {
    const commands = generateIntradayCommands(
      { code: '006479', name: '纳指' },
      makeMaData({ valuation: 0.94 }),
      { valuation: 0.94 },
      -12,
      makeHistory([0.94, 0.95, 0.96, 1.02]),
      { type: 'hold_dip', desc: '纳指' }
    );

    expect(commands.some(c => c.type === 'stop_loss')).toBe(false);
    expect(commands[0].type).toBe('hold_through_dip');
  });

  it('emits protective_profit for profitable first MA20 break', () => {
    const commands = generateIntradayCommands(
      { code: '001', name: '高盈利基金' },
      makeMaData({ valuation: 0.99 }),
      { valuation: 0.99 },
      12,
      makeHistory([0.99, 1.01, 1.02]),
      { type: 'stop_loss' }
    );

    expect(commands.map(c => c.type)).toContain('protective_profit');
  });

  it('emits take_profit for large gains when no protective profit has fired', () => {
    const commands = generateIntradayCommands(
      { code: '002', name: '赢家基金' },
      makeMaData({ valuation: 1.08, ma5: 1.04, ma10: 1.02, ma20: 1, alignment: 'bullish_aligned' }),
      { valuation: 1.08 },
      25,
      makeHistory([1.02, 1.03, 1.04]),
      { type: 'stop_loss' }
    );

    expect(commands.map(c => c.type)).toContain('take_profit');
  });

  it('emits dip_buy when drawdown is deep and price recovers above MA5', () => {
    const history = makeHistory([
      0.9, 0.88, 0.87, 0.86, 0.85, 0.84, 0.83, 0.82, 0.81, 0.8,
      1.2, 1.22, 1.24, 1.26, 1.28, 1.3, 1.32, 1.34, 1.36, 1.38,
    ]);

    const commands = generateIntradayCommands(
      { code: '003', name: '深回撤基金' },
      makeMaData({ valuation: 0.92, ma5: 0.9, ma20: 1, alignment: 'sideways' }),
      { valuation: 0.92 },
      -8,
      history,
      { type: 'hold_dip' }
    );

    expect(commands.some(c => c.type.startsWith('dip_buy'))).toBe(true);
  });

  it('returns an empty command list without MA or valuation data', () => {
    expect(generateIntradayCommands({}, null, { valuation: 1 }, 0, [], {})).toEqual([]);
    expect(generateIntradayCommands({}, makeMaData(), null, 0, [], {})).toEqual([]);
  });
});
