/**
 * lib/utils.js 单元测试
 * 覆盖: parseJSONP / parseJSObject / scalePrice
 */
import { describe, it, expect } from 'vitest';
import utils from './utils.js';
const { parseJSONP, parseJSObject, scalePrice } = utils;

describe('parseJSONP(text, varName)', () => {
  it('应该直接解析纯 JSON 文本', () => {
    expect(parseJSONP('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
  });
  it('应该解析 jsonpgz(...) 格式', () => {
    const r = parseJSONP('jsonpgz({"fundcode":"006479","name":"X"})');
    expect(r).toEqual({ fundcode: '006479', name: 'X' });
  });
  it('应该解析 callback(...) 格式', () => {
    const r = parseJSONP('callback({"Data":{"LSJZList":[]}})');
    expect(r).toEqual({ Data: { LSJZList: [] } });
  });
  it('应该解析 var 赋值（对象）格式', () => {
    const r = parseJSONP('var rankData={"a":1};', 'rankData');
    expect(r).toEqual({ a: 1 });
  });
  it('应该解析 var 赋值（数组）格式', () => {
    const r = parseJSONP('var listData=[1,2,3];', 'listData');
    expect(r).toEqual([1, 2, 3]);
  });
  it('应该 varName 不匹配且无 callback 包装时回落到 null', () => {
    expect(parseJSONP('var foo={"a":1};', 'bar')).toBeNull();
  });
  it('应该 null/空串/undefined 返回 null', () => {
    expect(parseJSONP(null)).toBeNull();
    expect(parseJSONP('')).toBeNull();
    expect(parseJSONP(undefined)).toBeNull();
  });
  it('应该无效文本返回 null', () => {
    expect(parseJSONP('this is not json or jsonp')).toBeNull();
    expect(parseJSONP('jsonpgz(broken')).toBeNull();
  });
  it('应该解析多行包含中文的 jsonpgz', () => {
    const r = parseJSONP('jsonpgz({\n  "name":"易方达基金",\n  "code":"110011"\n})');
    expect(r.name).toBe('易方达基金');
    expect(r.code).toBe('110011');
  });
  it('应该 JSON 优先于其他包装模式', () => {
    expect(parseJSONP('{"x":3.14}')).toEqual({ x: 3.14 });
  });
  it('应该不传 varName 时只匹配 jsonpgz/callback', () => {
    expect(parseJSONP('var foo={"a":1};')).toBeNull();
  });
  it('应该 callback 嵌套中文也能正确解析', () => {
    const r = parseJSONP('callback({"msg":"成功","code":0})');
    expect(r).toEqual({ msg: '成功', code: 0 });
  });
});

describe('parseJSObject(text)', () => {
  it('应该解析标准 JSON', () => {
    expect(parseJSObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('应该解析无引号 key 的对象字面量 {a:1}', () => {
    expect(parseJSObject('{a:1,b:2}')).toEqual({ a: 1, b: 2 });
  });
  it('应该解析嵌套对象字面量', () => {
    expect(parseJSObject('{a:1, b:{c:2, d:3}}')).toEqual({ a: 1, b: { c: 2, d: 3 } });
  });
  it('应该解析 key 带 _ 或 $ 或数字的形式', () => {
    expect(parseJSObject('{_foo:1, $bar:2, key3:"v"}')).toEqual({ _foo: 1, $bar: 2, key3: 'v' });
  });
  it('应该无效输入返回 null', () => {
    expect(parseJSObject('not an object at all')).toBeNull();
  });
  it('应该空字符串返回 null', () => {
    expect(parseJSObject('')).toBeNull();
  });
  it('应该包含字符串值的对象也能正确解析', () => {
    expect(parseJSObject('{name:"hello", age:30}')).toEqual({ name: 'hello', age: 30 });
  });
});

describe('scalePrice(raw, market)', () => {
  it('应该把整数价格除以 100', () => {
    expect(scalePrice(1234)).toBe(12.34);
    expect(scalePrice(100)).toBe(1);
  });
  it('应该 null 原样返回', () => { expect(scalePrice(null)).toBeNull(); });
  it('应该 undefined 原样返回', () => { expect(scalePrice(undefined)).toBeUndefined(); });
  it('应该 NaN 原样返回', () => { expect(Number.isNaN(scalePrice(NaN))).toBe(true); });
  it('应该 0 返回 0', () => { expect(scalePrice(0)).toBe(0); });
  it('应该处理负数', () => { expect(scalePrice(-500)).toBe(-5); });
  it('应该忽略 market 参数（统一 /100）', () => {
    expect(scalePrice(2500, 'SH')).toBe(25);
    expect(scalePrice(2500, 'SZ')).toBe(25);
    expect(scalePrice(2500, undefined)).toBe(25);
  });
  it('应该处理极大值', () => { expect(scalePrice(100000)).toBe(1000); });
});
