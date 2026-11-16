/**
 * 合成 fixtures 统一出口。
 *
 * 所有数据均为虚构测试数据（公司名/法人/联系人/电话/USCC 均非真实），
 * 禁止把真实公司/PII 写入本目录（见 docs/09 与任务约束）。
 */
export * from './regions.js';
export * from './companies.js';
export * from './jobs.js';
export * from './customs.js';

/** fixture 数据包版本（验收报告写入，便于追踪） */
export const FIXTURE_VERSION = '2026-11-16.1';
