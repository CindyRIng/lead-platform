/**
 * F3 领域工具单元测试：名称归一化 / 游标分页 / WHERE 构造 / 压缩与内容哈希
 */
import { describe, expect, it } from 'vitest';
import {
  companyNameKey,
  companyNameKeys,
  containsCjk,
  englishNameTokens,
  normalizeChineseCompanyName,
  normalizeCompanyName,
  normalizeEnglishCompanyName,
  normalizeRegionName,
  stripBracketContent,
  stripLegalSuffixCn,
  stripRegionPrefixCn,
  toHalfWidth,
} from '../../src/domain/normalize.js';
import {
  buildCursorPage,
  decodeCursor,
  decodeSeqCursor,
  decodeUpdatedAtCursor,
  encodeCursor,
  encodeSeqCursor,
  encodeUpdatedAtCursor,
  parseLimit,
  parseNonNegativeInt,
  parseOffset,
} from '../../src/domain/pagination.js';
import { assertIdentifier, buildWhere, escapeLikePattern, limitOffset } from '../../src/domain/query.js';
import {
  compressBody,
  compressPayload,
  contentHash,
  decompressAuto,
  decompressBody,
  decompressJson,
  toBuffer,
} from '../../src/utils/compress.js';
import { LeadError } from '../../src/shared/errors.js';

function expectValidationError(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LeadError);
    expect((err as LeadError).code).toBe('VALIDATION_ERROR');
    return;
  }
  throw new Error('expected LeadError(VALIDATION_ERROR)');
}

describe('normalize', () => {
  it('全半角统一 / 去括号内容', () => {
    expect(toHalfWidth('ＡＢＣ（中国）有限公司')).toBe('ABC(中国)有限公司');
    expect(stripBracketContent('河北XX（曾用名：YY）有限公司')).toBe('河北XX有限公司');
    expect(stripBracketContent('ABC(China) Trading Co., Ltd.')).toBe('ABC Trading Co., Ltd.');
  });

  it('中文：去括号/标点/法律后缀/河北省市前缀', () => {
    expect(normalizeChineseCompanyName('河北石家庄ABC机械有限公司')).toBe('ABC机械');
    expect(normalizeChineseCompanyName('河北省保定市XX商贸有限责任公司')).toBe('XX商贸');
    expect(normalizeChineseCompanyName('石家庄三全食品（曾用名）股份有限公司')).toBe('三全食品');
    expect(normalizeChineseCompanyName('唐山 市 某某 贸易 有限公司')).toBe('某某贸易');
    // 后缀写法统一
    expect(normalizeChineseCompanyName('河北XX贸易有限责任公司')).toBe(
      normalizeChineseCompanyName('河北XX贸易有限公司'),
    );
    expect(stripLegalSuffixCn('XX集团有限公司')).toBe('XX');
    expect(stripRegionPrefixCn('河北省唐山市XX有限公司')).toBe('XX有限公司');
  });

  it('英文：小写/去标点/去法律实体后缀/& 归一', () => {
    expect(normalizeEnglishCompanyName('ABC Machinery Co., Ltd.')).toBe('abc machinery');
    expect(normalizeEnglishCompanyName('ABC MACHINERY LIMITED')).toBe('abc machinery');
    expect(normalizeEnglishCompanyName('A&B Import and Export Inc.')).toBe('a and b import and export');
    expect(normalizeEnglishCompanyName('  Global   Trading  LLC ')).toBe('global trading');
  });

  it('统一入口 / key / 判定工具', () => {
    expect(normalizeCompanyName('河北石家庄ABC机械有限公司')).toBe('ABC机械');
    expect(normalizeCompanyName('ABC Machinery Co., Ltd.')).toBe('abc machinery');
    expect(normalizeCompanyName('')).toBe('');
    expect(normalizeCompanyName(null)).toBe('');
    expect(containsCjk('河北ABC')).toBe(true);
    expect(containsCjk('ABC Machinery')).toBe(false);
    expect(companyNameKey('  河北 ABC 机械有限公司 ')).toBe('ABC机械');
    expect(normalizeRegionName('河北省')).toBe('河北');
    expect(normalizeRegionName('石家庄市')).toBe('石家庄');
    expect(normalizeRegionName('内蒙古自治区')).toBe('内蒙古');
    expect(englishNameTokens('ABC Machinery Co., Ltd.')).toEqual(['abc', 'machinery']);
    const keys = companyNameKeys('河北ABC机械有限公司');
    expect(keys).toContain('ABC机械');
  });

  it('不激进合并：不同行业后缀不互相归一', () => {
    expect(normalizeCompanyName('河北XX贸易有限公司')).not.toBe(normalizeCompanyName('河北XX机械有限公司'));
  });
});

describe('pagination', () => {
  it('cursor 编解码 roundtrip', () => {
    const cursor = encodeCursor({ updatedAt: '2026-01-01T00:00:00.000Z', id: 'cmp_1' });
    expect(cursor).not.toContain('=');
    expect(decodeCursor(cursor)).toEqual({ updatedAt: '2026-01-01T00:00:00.000Z', id: 'cmp_1' });
    expect(decodeUpdatedAtCursor(encodeUpdatedAtCursor('2026-01-01T00:00:00.000Z', 'x'))).toEqual({
      updatedAt: '2026-01-01T00:00:00.000Z',
      id: 'x',
    });
    expect(decodeSeqCursor(encodeSeqCursor(42))).toBe(42);
  });

  it('非法 cursor 抛 VALIDATION_ERROR', () => {
    expectValidationError(() => decodeCursor('not-base64-json'));
    expectValidationError(() => decodeCursor(''));
    expectValidationError(() => decodeCursor(Buffer.from('123').toString('base64url')));
    expectValidationError(() => decodeCursor(Buffer.from('[]').toString('base64url')));
    expectValidationError(() => decodeSeqCursor(encodeCursor({ seq: 'x' })));
  });

  it('limit/offset/since 解析', () => {
    expect(parseLimit(undefined)).toBe(20);
    expect(parseLimit('50')).toBe(50);
    expect(parseLimit('0')).toBe(1);
    expect(parseLimit('999')).toBe(200);
    expectValidationError(() => parseLimit('x'));
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset('10')).toBe(10);
    expectValidationError(() => parseOffset('-1'));
    expect(parseNonNegativeInt(undefined, 'sinceSeq')).toBeNull();
    expect(parseNonNegativeInt('5', 'sinceSeq')).toBe(5);
    expectValidationError(() => parseNonNegativeInt('-5', 'sinceSeq'));
  });

  it('buildCursorPage 多取一条判断 hasMore', () => {
    const rows = [1, 2, 3];
    const page = buildCursorPage(rows, 2, (last) => ({ id: last }));
    expect(page.items).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTruthy();
    const lastPage = buildCursorPage([1, 2], 2, (last) => ({ id: last }));
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.nextCursor).toBeNull();
  });
});

describe('query helpers', () => {
  it('WhereBuilder 生成安全 SQL 与按序参数', () => {
    const where = buildWhere()
      .eq('province', '河北省')
      .in('enrichment_status', ['discovered', 'source_detailed'])
      .isNotNull('tanji_company_id')
      .contains('name', '50%_off')
      .gte('version', 2)
      .build();
    expect(where.sql).toContain('province = ?');
    expect(where.sql).toContain('enrichment_status IN (?,?)');
    expect(where.sql).toContain("name LIKE ? ESCAPE '\\'");
    expect(where.params).toEqual([
      '河北省',
      'discovered',
      'source_detailed',
      '50%_off',
      2,
    ].map((v, i) => (i === 3 ? '%50\\%\\_off%' : v)));
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('空 IN / orGroup / toWhereSql', () => {
    const emptyIn = buildWhere().in('x', []).build();
    expect(emptyIn.sql).toBe('1 = 0');
    expect(buildWhere().toWhereSql()).toBe('');
    const grouped = buildWhere()
      .eq('a', 1)
      .orGroup((inner) => inner.eq('b', 2).eq('c', 3))
      .build();
    expect(grouped.sql).toBe('a = ? AND (b = ? AND c = ?)');
    expect(grouped.params).toEqual([1, 2, 3]);
  });

  it('assertIdentifier / limitOffset 校验', () => {
    expect(assertIdentifier('companies.name')).toBe('companies.name');
    expect(() => assertIdentifier('name; DROP TABLE x')).toThrow();
    expect(limitOffset(10, 20)).toBe('LIMIT 10 OFFSET 20');
    expectValidationError(() => limitOffset(-1, 0));
  });
});

describe('compress', () => {
  it('contentHash 稳定且带 sha256 前缀', () => {
    const h1 = contentHash('hello world');
    const h2 = contentHash('hello world');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentHash('hello world')).not.toBe(contentHash('hello world!'));
    expect(contentHash({ a: 1 })).toBe(contentHash('{"a":1}'));
    expect(toBuffer({ a: 1 }).toString()).toBe('{"a":1}');
    expect(toBuffer('x').toString()).toBe('x');
    expect(toBuffer(Buffer.from('y')).toString()).toBe('y');
  });

  it('brotli 压缩/解压 + 压缩比', () => {
    const payload = 'LeadPlatform '.repeat(200);
    const compressed = compressBody(payload, 'brotli');
    expect(compressed.encoding).toBe('brotli');
    expect(compressed.storedBytes).toBeLessThan(compressed.originalBytes);
    expect(decompressBody(compressed.body, 'brotli').toString()).toBe(payload);
    expect(decompressAuto(compressed.body).data.toString()).toBe(payload);
  });

  it('gzip / plain / decompressAuto 容错', () => {
    const payload = JSON.stringify({ x: 'y'.repeat(100) });
    const gzip = compressBody(payload, 'gzip');
    expect(gzip.encoding).toBe('gzip');
    expect(decompressBody(gzip.body, gzip.encoding).toString()).toBe(payload);
    expect(decompressAuto(gzip.body).encoding).toBe('gzip');
    expect(decompressAuto(gzip.body).data.toString()).toBe(payload);

    const plain = compressPayload(payload, 'plain');
    expect(plain.body.toString()).toBe(payload);
    expect(decompressAuto(Buffer.from(payload)).encoding).toBe('plain');

    expect(decompressJson<{ x: string }>(gzip.body, 'gzip', { x: '' })).toEqual({ x: JSON.parse(payload).x });
    expect(decompressJson(gzip.body, 'bogus', { fallback: true })).toEqual({ fallback: true });
  });
});
