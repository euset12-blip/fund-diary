/**
 * sector-volume.js 单元测试
 * 覆盖: describeVolume / volumePriceSignal
 */
import { describe, it, expect } from 'vitest';
import sectorVolume from './sector-volume.js';
const { describeVolume, volumePriceSignal } = sectorVolume;

describe('describeVolume(ratio)', () => {
  describe('档位返回值', () => {
    it('应该把 ratio >= 2.0 标记为"巨量"', () => {
      expect(describeVolume(2.0)).toBe('巨量');
      expect(describeVolume(3.5)).toBe('巨量');
    });
    it('应该把 1.5 <= ratio < 2.0 标记为"明显放量"', () => {
      expect(describeVolume(1.5)).toBe('明显放量');
      expect(describeVolume(1.7)).toBe('明显放量');
    });
    it('应该把 1.2 <= ratio < 1.5 标记为"放量"', () => {
      expect(describeVolume(1.2)).toBe('放量');
      expect(describeVolume(1.35)).toBe('放量');
    });
    it('应该把 0.8 <= ratio < 1.2 标记为"正常"', () => {
      expect(describeVolume(0.8)).toBe('正常');
      expect(describeVolume(1.0)).toBe('正常');
      expect(describeVolume(1.19)).toBe('正常');
    });
    it('应该把 0.5 <= ratio < 0.8 标记为"缩量"', () => {
      expect(describeVolume(0.5)).toBe('缩量');
      expect(describeVolume(0.7)).toBe('缩量');
    });
    it('应该把 ratio < 0.5 标记为"地量"', () => {
      expect(describeVolume(0.49)).toBe('地量');
      expect(describeVolume(0.1)).toBe('地量');
    });
  });

  describe('边界值精确测试', () => {
    it('2.0 命中"巨量"（含等号）', () => { expect(describeVolume(2.0)).toBe('巨量'); });
    it('2.01 命中"巨量"', () => { expect(describeVolume(2.01)).toBe('巨量'); });
    it('1.99 命中"明显放量"', () => { expect(describeVolume(1.99)).toBe('明显放量'); });
    it('1.5 命中"明显放量"（含等号）', () => { expect(describeVolume(1.5)).toBe('明显放量'); });
    it('1.51 命中"明显放量"', () => { expect(describeVolume(1.51)).toBe('明显放量'); });
    it('1.49 命中"放量"', () => { expect(describeVolume(1.49)).toBe('放量'); });
    it('1.2 命中"放量"', () => { expect(describeVolume(1.2)).toBe('放量'); });
    it('1.19 命中"正常"', () => { expect(describeVolume(1.19)).toBe('正常'); });
    it('0.8 命中"正常"', () => { expect(describeVolume(0.8)).toBe('正常'); });
    it('0.79 命中"缩量"', () => { expect(describeVolume(0.79)).toBe('缩量'); });
    it('0.5 命中"缩量"', () => { expect(describeVolume(0.5)).toBe('缩量'); });
    it('0.49 命中"地量"', () => { expect(describeVolume(0.49)).toBe('地量'); });
  });

  describe('异常输入', () => {
    it('ratio=0 返回"地量"不崩溃', () => { expect(describeVolume(0)).toBe('地量'); });
    it('负数返回"地量"不抛错', () => {
      expect(() => describeVolume(-1)).not.toThrow();
      expect(describeVolume(-1)).toBe('地量');
    });
    it('Infinity 返回"巨量"', () => { expect(describeVolume(Infinity)).toBe('巨量'); });
    it('总是返回字符串类型', () => {
      [0, 0.5, 1, 1.2, 1.5, 2, 10, -1, Infinity].forEach(r => {
        expect(typeof describeVolume(r)).toBe('string');
      });
    });
  });
});

describe('volumePriceSignal(pctChg, volumeRatio)', () => {
  describe('放量上涨（bullish）', () => {
    it('涨幅>0.3 量比>=1.2 → bullish', () => {
      const r = volumePriceSignal(1.5, 1.5);
      expect(r.level).toBe('bullish');
      expect(r.signal).toBe('📈');
      expect(r.desc).toContain('放量上涨');
    });
    it('涨5%量比2.0 → bullish', () => {
      const r = volumePriceSignal(5, 2.0);
      expect(r.level).toBe('bullish');
    });
  });

  describe('缩量上涨（neutral）', () => {
    it('涨幅>0.3 量比<=0.8 → 缩量上涨', () => {
      const r = volumePriceSignal(1.0, 0.6);
      expect(r.signal).toBe('⚠️');
      expect(r.desc).toContain('缩量上涨');
    });
    it('量比恰好0.8 → 缩量上涨', () => {
      expect(volumePriceSignal(0.5, 0.8).signal).toBe('⚠️');
    });
  });

  describe('放量下跌（bearish）', () => {
    it('跌幅<-0.3 量比>=1.2 → bearish', () => {
      const r = volumePriceSignal(-1.5, 1.5);
      expect(r.level).toBe('bearish');
      expect(r.signal).toBe('🔴');
      expect(r.desc).toContain('放量下跌');
    });
    it('跌停-10% 量比5.0 → bearish', () => {
      expect(volumePriceSignal(-10, 5.0).level).toBe('bearish');
    });
  });

  describe('缩量下跌（neutral）', () => {
    it('跌幅<-0.3 量比<=0.8 → 缩量下跌', () => {
      const r = volumePriceSignal(-1.0, 0.5);
      expect(r.signal).toBe('⚪');
      expect(r.desc).toContain('缩量下跌');
    });
  });

  describe('量价正常', () => {
    it('涨0.2%量比1.0 → 量价正常', () => {
      const r = volumePriceSignal(0.2, 1.0);
      expect(r.signal).toBe('➖');
      expect(r.desc).toContain('量价正常');
    });
    it('上涨但量比中性 → ➖', () => { expect(volumePriceSignal(0.5, 1.0).signal).toBe('➖'); });
    it('下跌但量比中性 → ➖', () => { expect(volumePriceSignal(-0.5, 1.0).signal).toBe('➖'); });
  });

  describe('边界条件 ±0.01', () => {
    it('pctChg=0.3 不算上涨', () => { expect(volumePriceSignal(0.3, 2.0).signal).toBe('➖'); });
    it('pctChg=-0.3 不算下跌', () => { expect(volumePriceSignal(-0.3, 2.0).signal).toBe('➖'); });
    it('pctChg=0.31 + 量比1.2 → bullish', () => { expect(volumePriceSignal(0.31, 1.2).level).toBe('bullish'); });
    it('pctChg=-0.31 + 量比1.2 → bearish', () => { expect(volumePriceSignal(-0.31, 1.2).level).toBe('bearish'); });
    it('量比1.19 + 涨1% → ➖', () => { expect(volumePriceSignal(1.0, 1.19).signal).toBe('➖'); });
    it('量比0.81 + 涨1% → ➖', () => { expect(volumePriceSignal(1.0, 0.81).signal).toBe('➖'); });
  });

  describe('极端值', () => {
    it('涨停10% 量比5.0 不崩', () => {
      expect(() => volumePriceSignal(10, 5.0)).not.toThrow();
      expect(volumePriceSignal(10, 5.0).level).toBe('bullish');
    });
    it('跌停-10% 量比5.0 → bearish', () => { expect(volumePriceSignal(-10, 5.0).level).toBe('bearish'); });
    it('量比为0 不崩', () => {
      expect(() => volumePriceSignal(1.0, 0)).not.toThrow();
      expect(volumePriceSignal(1.0, 0).desc).toContain('缩量上涨');
    });
  });

  describe('返回值结构完整性', () => {
    it('所有调用都返回 signal/level/desc', () => {
      const cases = [[1.5, 1.5], [1.0, 0.6], [-1.5, 1.5], [-1.0, 0.5], [0.2, 1.0], [0, 0], [10, 10], [-10, -10]];
      for (const [p, v] of cases) {
        const r = volumePriceSignal(p, v);
        expect(r).toHaveProperty('signal');
        expect(r).toHaveProperty('level');
        expect(r).toHaveProperty('desc');
        expect(['bullish', 'neutral', 'bearish']).toContain(r.level);
        expect(r.desc.length).toBeGreaterThan(0);
      }
    });
  });
});
