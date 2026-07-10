import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试文件：源码同目录 .test.js（排除 tests/ 临时文件夹）
    include: ['**/*.test.js'],
    exclude: ['node_modules/**', 'tests/**'],

    // 超时 10s（纯函数测试足够）
    testTimeout: 10_000,

    // 默认不监听文件变化（CI 模式）
    watch: false,
  },
});
