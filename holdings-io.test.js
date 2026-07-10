import { describe, expect, it } from 'vitest';
import holdingsIo from './holdings-io.js';

const { normalizeHolding } = holdingsIo;

const config = {
  fundIndexMap: {
    '006479': { name: '纳斯达克100', sector: '美股科技' },
  },
};

describe('normalizeHolding', () => {
  it('adds the legacy profitLoss alias from profit', () => {
    const h = normalizeHolding({
      code: '006479',
      shortName: '广发纳指C',
      holdAmount: 1254.06,
      totalInvested: 1090,
      profit: 164.06,
    }, config);

    expect(h.name).toBe('纳斯达克100');
    expect(h.sector).toBe('美股科技');
    expect(h.profit).toBe(164.06);
    expect(h.profitLoss).toBe(164.06);
  });

  it('derives profit fields when only amount and invested principal exist', () => {
    const h = normalizeHolding({
      code: '000001',
      name: '测试基金',
      holdAmount: '90.50',
      totalInvested: '100',
    }, { fundIndexMap: {} });

    expect(h.profit).toBe(-9.5);
    expect(h.profitLoss).toBe(-9.5);
  });

  it('keeps yjb profitAmount compatible with local profit fields', () => {
    const h = normalizeHolding({
      code: '000002',
      name: '养基宝基金',
      profitAmount: 12.34,
      holdAmount: 112.34,
      totalInvested: 100,
    }, { fundIndexMap: {} });

    expect(h.profit).toBe(12.34);
    expect(h.profitLoss).toBe(12.34);
  });
});
