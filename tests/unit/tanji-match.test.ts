/**
 * T1 单元测试：探迹适配器（src/adapters/tanji.ts）+ 匹配算法（src/domain/matching.ts）。
 *
 * 全部使用注入的 mock fetch / mock 搜索端口，**不访问真实网络、不调用真实 unlock**。
 * 覆盖：USCC 精确、名称精确/近似、无结果、英文抬头匹配、错误归一、
 * 限频令牌桶/优先级、超时、幂等键透传、unlock 安全闸门。
 */
import { describe, expect, it } from 'vitest';
import { LeadError } from '../../src/shared/errors';
import {
  RateLimiter,
  TanjiClient,
  createTanjiClient,
  createTanjiClientFromEnv,
  type TanjiFetch,
} from '../../src/adapters/tanji';
import {
  buildSearchAttempts,
  matchCompany,
  nameSimilarity,
  normalizeUscc,
  scoreCandidate,
  type MatchCandidateSource,
} from '../../src/domain/matching';

// ---------------------------------------------------------------------------
// mock 基建
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

interface MockReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type ReplyHandler = (call: RecordedCall) => MockReply | Promise<MockReply>;

function makeMockFetch(handler: ReplyHandler | MockReply): { fetchImpl: TanjiFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: TanjiFetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) headers[key.toLowerCase()] = String(value);
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
      signal: init?.signal,
    };
    calls.push(call);
    const reply: MockReply = typeof handler === 'function' ? await handler(call) : handler;
    const status = reply.status ?? 200;
    const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    const responseHeaders = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => responseHeaders.get(name.toLowerCase()) ?? null },
      text: async () => text,
    };
  };
  return { fetchImpl, calls };
}

function okReply(data: unknown): MockReply {
  return { status: 200, json: { ok: true, data, meta: {}, error: null } };
}

function errReply(status: number, code: string, message = 'upstream error', data?: unknown, headers?: Record<string, string>): MockReply {
  return {
    status,
    headers,
    json: { ok: false, data: data ?? null, meta: {}, error: { code, message } },
  };
}

/** 测试默认客户端：不真实网络；限频调高避免等待；短超时 */
function makeClient(fetchImpl: TanjiFetch, overrides: Partial<ConstructorParameters<typeof TanjiClient>[0]> = {}): TanjiClient {
  return new TanjiClient({
    baseUrl: 'http://127.0.0.1:8787',
    token: 'test-token',
    ratePerMin: 60_000,
    fetchImpl,
    timeoutMs: 1_000,
    ...overrides,
  });
}

/** 上游 CompanySummary 样例（字段取自 docs/09 §2.5 实测结构，数据合成/脱敏） */
function companySummary(overrides: Partial<MatchCandidateSource> & { id: string; name: string }): MatchCandidateSource {
  return {
    uscc: null,
    province: null,
    city: null,
    address: null,
    score: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 适配器基础：status / 请求头 / envelope 解包 / 分页参数
// ---------------------------------------------------------------------------

describe('tanji adapter: 基础请求与 envelope', () => {
  it('GET /v1/status 带 Bearer，解包 envelope，解析额度', async () => {
    const { fetchImpl, calls } = makeMockFetch(
      okReply({
        loggedIn: true,
        version: '1.2.0',
        quota: {
          daily: { limit: 500, used: 0, remaining: 500, unit: '次' },
          monthly: { limit: 1500, used: 1277, remaining: 223 },
          enterpriseMonthly: { limit: 19500, used: 7586, remaining: 11914 },
          settlementDay: 11,
          nearlySevenDayUnlockCount: 37,
        },
      }),
    );
    const client = makeClient(fetchImpl);
    const status = await client.getStatus();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/v1/status');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.authorization).toBe('Bearer test-token');
    expect(status.loggedIn).toBe(true);
    expect(status.quota?.daily?.remaining).toBe(500);
    expect(status.quota?.monthly?.limit).toBe(1500);
    expect(status.quota?.monthly?.used).toBe(1277);
    expect(status.quota?.enterpriseMonthly?.remaining).toBe(11914);
    expect(status.quota?.settlementDay).toBe(11);
    expect(status.quota?.nearlySevenDayUnlockCount).toBe(37);
  });

  it('search/name 默认 pageSize=20、maxPages=2；socialCreditCode 默认 maxPages=1', async () => {
    const { fetchImpl, calls } = makeMockFetch(okReply({ companies: [] }));
    const client = makeClient(fetchImpl);

    await client.searchByName({ name: '河北测试机械有限公司' });
    await client.searchByName({ name: '91130100TEST0000X1', field: 'socialCreditCode' });

    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/v1/search/name');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({ name: '河北测试机械有限公司', field: 'name', pageSize: 20, maxPages: 2 });
    expect(calls[1]?.body).toEqual({ name: '91130100TEST0000X1', field: 'socialCreditCode', pageSize: 20, maxPages: 1 });
  });

  it('pageSize>100 / maxPages>50 / 名称过短 → VALIDATION_ERROR 且不发请求', async () => {
    const { fetchImpl, calls } = makeMockFetch(okReply({ companies: [] }));
    const client = makeClient(fetchImpl);

    await expect(client.searchByName({ name: '河北测试', pageSize: 101 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(client.searchByName({ name: '河北测试', maxPages: 51 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(client.searchByName({ name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toHaveLength(0);
  });

  it('非 envelope 响应也可解析（兼容直接返回 data 的上游实现）', async () => {
    const { fetchImpl } = makeMockFetch({ status: 200, json: { loggedIn: true, quota: { daily: { limit: 1, used: 0, remaining: 1 } } } });
    const client = makeClient(fetchImpl);
    const status = await client.getStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.quota?.daily?.remaining).toBe(1);
  });

  it('GET /v1/companies/{id} 与 contacts：contacts 未解锁返回 unlocked=false+空数组', async () => {
    const { fetchImpl, calls } = makeMockFetch((call) => {
      if (call.url.includes('/contacts')) {
        return okReply({ companyId: 'c_1', unlocked: false, contacts: [], counts: { mobile: 0, phone: 0, email: 0, total: 0 } });
      }
      return okReply({
        id: 'c_1',
        name: '河北测试机械有限公司',
        uscc: '91130100TEST0000X1',
        province: '河北省',
        industry: { name: '机械制造' },
        tags: ['测试'],
      });
    });
    const client = makeClient(fetchImpl);

    const detail = await client.getCompany('c_1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/v1/companies/c_1');
    expect(detail.name).toBe('河北测试机械有限公司');
    expect(detail.raw['uscc']).toBe('91130100TEST0000X1');

    const contacts = await client.getContacts('c_1');
    expect(calls[1]?.url).toBe('http://127.0.0.1:8787/v1/companies/c_1/contacts');
    expect(contacts.unlocked).toBe(false);
    expect(contacts.contacts).toEqual([]);
    expect(contacts.counts?.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 错误归一（docs/04 §7）
// ---------------------------------------------------------------------------

describe('tanji adapter: 错误码归一', () => {
  it('401 → UNAUTHORIZED（不可重试）', async () => {
    const { fetchImpl } = makeMockFetch(errReply(401, 'UNAUTHORIZED', 'bad token'));
    const client = makeClient(fetchImpl);
    await expect(client.getStatus()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      retryable: false,
    });
    const err = await client.getStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeadError);
    expect((err as LeadError).details?.upstreamStatus).toBe(401);
  });

  it('409 + QUOTA_EXHAUSTED → QUOTA_EXHAUSTED（unlock 前置/额度判断依赖此码）', async () => {
    const { fetchImpl } = makeMockFetch(errReply(409, 'QUOTA_EXHAUSTED', '本月额度已用尽'));
    const client = makeClient(fetchImpl);
    await expect(client.getStatus()).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED', retryable: false });
  });

  it('上游 VERIFICATION_REQUIRED → SOURCE_VERIFICATION_PENDING', async () => {
    const { fetchImpl } = makeMockFetch(errReply(200, 'VERIFICATION_REQUIRED', '需要人工验证'));
    const client = makeClient(fetchImpl);
    await expect(client.searchByName({ name: '河北测试机械' })).rejects.toMatchObject({
      code: 'SOURCE_VERIFICATION_PENDING',
    });
  });

  it('429 → UPSTREAM_RATE_LIMITED（可重试），带 retryAfterMs 并暂停令牌桶', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const { fetchImpl } = makeMockFetch(errReply(429, 'RATE_LIMITED', 'too many requests', undefined, { 'Retry-After': '5' }));
    const client = makeClient(fetchImpl, {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await expect(client.getStatus()).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', retryable: true });
    const err = await client.getStatus().catch((e: unknown) => e);
    expect((err as LeadError).details?.retryAfterMs).toBe(5000);
    // 桶已被暂停，下一次请求会先等待（fake sleep 记录 5s）
    await client.getStatus().catch(() => undefined);
    expect(sleeps.some((ms) => ms >= 5000)).toBe(true);
  });

  it('5xx → SOURCE_UNAVAILABLE（可重试）；网络异常/超时 → SOURCE_UNAVAILABLE', async () => {
    const serverError = makeMockFetch(errReply(503, 'UPSTREAM_UNAVAILABLE', 'down'));
    await expect(makeClient(serverError.fetchImpl).getStatus()).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      retryable: true,
    });

    const networkError = makeClient(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(networkError.getStatus()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryable: true });

    const hangingFetch: TanjiFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const timeoutClient = makeClient(hangingFetch, { timeoutMs: 20 });
    const err = await timeoutClient.getStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeadError);
    expect((err as LeadError).code).toBe('SOURCE_UNAVAILABLE');
    expect((err as LeadError).details?.aborted).toBe(true);
  });

  it('200 非法 JSON → SOURCE_UNAVAILABLE；4xx 其它 → UPSTREAM_BAD_REQUEST', async () => {
    const badJson = makeClient(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>not json</html>',
    }));
    await expect(badJson.getStatus()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });

    const badRequest = makeMockFetch(errReply(422, 'INVALID_PARAMS', 'bad field'));
    await expect(makeClient(badRequest.fetchImpl).searchByName({ name: '河北测试机械' })).rejects.toMatchObject({
      code: 'UPSTREAM_BAD_REQUEST',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. 限频令牌桶（20 req/min）+ 优先级
// ---------------------------------------------------------------------------

describe('tanji adapter: 令牌桶限频', () => {
  it('20 req/min 桶：前 20 个立即通过，第 21 个等待 3s 补充 1 个令牌', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter({
      ratePerMin: 20,
      capacity: 20,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < 20; i++) {
      const release = await limiter.acquire();
      release();
    }
    expect(sleeps).toEqual([]);
    const release = await limiter.acquire();
    release();
    expect(sleeps).toEqual([3000]);
  });

  it('并发=1（串行），高优先级（unlock）先于批量读拿到令牌', async () => {
    let clock = 0;
    const limiter = new RateLimiter({
      ratePerMin: 20,
      capacity: 1,
      concurrency: 1,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    });
    const running = await limiter.acquire();
    const order: string[] = [];
    const normal = limiter.acquire(0).then((release) => {
      order.push('normal');
      return release;
    });
    const high = limiter.acquire(10).then((release) => {
      order.push('unlock');
      return release;
    });
    running(); // 释放后：unlock 优先拿令牌
    const highRelease = await high;
    highRelease();
    const normalRelease = await normal;
    normalRelease();
    expect(order).toEqual(['unlock', 'normal']);
  });
});

// ---------------------------------------------------------------------------
// 4. 匹配算法：USCC 精确 / 名称 / 无结果 / 英文抬头
// ---------------------------------------------------------------------------

const DATE = '2026-11-16';

describe('matching: USCC 精确匹配', () => {
  it('USCC 归一化大小写后精确命中 → confidence=1.0, method=uscc', async () => {
    const { fetchImpl, calls } = makeMockFetch((call) => {
      expect(call.url).toBe('http://127.0.0.1:8787/v1/search/name');
      expect((call.body as Record<string, unknown>).field).toBe('socialCreditCode');
      return okReply({
        queryId: 'q_uscc',
        companies: [
          companySummary({
            id: '37622fca11453f94',
            name: '河北示例机械有限公司',
            uscc: '91130100TEST0000A1',
            province: '河北省',
            address: '河北省邯郸市永年区临洺关镇',
            score: 1024.9454,
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
        hasMore: false,
        pagesFetched: 1,
        warnings: [],
      });
    });
    const client = makeClient(fetchImpl);
    const result = await matchCompany(
      {
        name: '河北示例机械有限公司',
        uscc: '91130100TEST0000A1', // 小写/带空格也应命中
        province: '河北省',
        platform: 'boss',
      },
      client,
    );

    expect(result.matched).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.method).toBe('uscc');
    expect(result.queryName).toBe('91130100TEST0000A1');
    expect(result.candidates).toEqual([
      { id: '37622fca11453f94', name: '河北示例机械有限公司', uscc: '91130100TEST0000A1', score: 1 },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('USCC 未命中 → 回退名称搜索（method 为名称类，searches 记录两次）', async () => {
    const { fetchImpl, calls } = makeMockFetch((call) => {
      const body = call.body as Record<string, unknown>;
      if (body.field === 'socialCreditCode') {
        return okReply({ companies: [companySummary({ id: 'other', name: '别家公司', uscc: '91130100OTHER00001' })], total: 1 });
      }
      return okReply({
        companies: [
          companySummary({
            id: 'c_target',
            name: '河北测试机械有限公司',
            uscc: '91130100TEST0000X1',
            province: '河北省',
            score: 800,
          }),
        ],
        total: 1,
      });
    });
    const client = makeClient(fetchImpl);
    const result = await matchCompany(
      { name: '河北测试机械有限公司', uscc: '91130100TEST0000X1', province: '河北省' },
      client,
    );

    expect(calls).toHaveLength(2);
    expect(result.matched).toBe(true);
    expect(result.method).toBe('name_exact');
    expect(result.candidates[0]?.id).toBe('c_target');
    expect(result.searches.map((s) => s.field)).toEqual(['socialCreditCode', 'name']);
  });
});

describe('matching: 名称精确/近似 + 省市 + 相关度', () => {
  it('归一化后完全相等 → name_exact，精确候选排第一，包含关系候选分更低', async () => {
    const { fetchImpl } = makeMockFetch(
      okReply({
        companies: [
          companySummary({
            id: 'c_short',
            name: '河北示例机械有限公司邯郸永年分公司',
            uscc: '91130100TEST0000B2',
            province: '河北省',
            address: '河北省邯郸市永年区',
            score: 474.98373,
          }),
          companySummary({
            id: 'c_exact',
            name: '河北示例机械有限公司',
            uscc: '91130100TEST0000A1',
            province: '河北省',
            address: '河北省邯郸市永年区临洺关镇',
            score: 1024.9454,
          }),
          companySummary({ id: 'c_unrelated', name: '河北示例建筑有限公司', uscc: '91130100TEST0000C3', province: '河北省', score: 107.02037 }),
        ],
        total: 3,
      }),
    );
    const result = await matchCompany(
      { name: '河北示例机械有限公司', province: '河北省', city: '邯郸市', platform: 'boss' },
      makeClient(fetchImpl),
    );

    expect(result.matched).toBe(true);
    expect(result.method).toBe('name_exact');
    expect(result.lowConfidence).toBe(false);
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.candidates[0]?.id).toBe('c_exact');
    // 候选含 {id,name,uscc,score}，最多 5 条，按分数降序
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    expect(Object.keys(result.candidates[0] ?? {}).sort()).toEqual(['id', 'name', 'score', 'uscc']);
    expect(result.candidates.map((c) => c.score)).toEqual([...result.candidates.map((c) => c.score)].sort((a, b) => b - a));
  });

  it('Boss 简称（包含关系）→ name_fuzzy；低置信度仍 matched 但记录 lowConfidence', async () => {
    const { fetchImpl } = makeMockFetch(
      okReply({
        companies: [
          companySummary({
            id: 'c_target',
            name: '河北示例机械有限公司',
            uscc: '91130100TEST0000A1',
            province: '河北省',
            address: '河北省邯郸市永年区',
            score: 900,
          }),
        ],
        total: 1,
      }),
    );
    const client = makeClient(fetchImpl);
    const result = await matchCompany({ name: '示例机', province: '河北省', platform: 'boss' }, client);
    expect(result.matched).toBe(true);
    expect(result.method).toBe('name_fuzzy');
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    expect(result.confidence).toBeLessThan(0.9);

    // 完全无关的候选：低分仍自动匹配（用户决策）但 lowConfidence=true
    const { fetchImpl: fetch2 } = makeMockFetch(
      okReply({
        companies: [
          companySummary({
            id: 'c_far',
            name: '河北示例建筑有限公司',
            uscc: '91130100TEST0000C3',
            province: '广东省',
            score: 10,
          }),
        ],
        total: 1,
      }),
    );
    const low = await matchCompany({ name: '河北示例机械有限公司', province: '河北省' }, makeClient(fetch2));
    expect(low.matched).toBe(true);
    expect(low.lowConfidence).toBe(true);
    expect(low.confidence).toBeLessThan(0.55);
  });

  it('无结果 → matched=false, confidence=0, method=none, queryName 保留', async () => {
    const calls: string[] = [];
    const search = {
      async searchByName(params: { name: string }) {
        calls.push(params.name);
        return { companies: [] as MatchCandidateSource[], total: 0 };
      },
    };
    const result = await matchCompany({ name: '不存在的测试公司', province: '河北省' }, search);
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.method).toBe('none');
    expect(result.candidates).toEqual([]);
    expect(result.queryName).toBe('不存在的测试公司');
    expect(calls).toEqual(['不存在的测试公司']);
  });

  it('scoreCandidate 权重可解释：精确+省+市+相关度接近 1.0，无省市则更低', () => {
    const candidate = companySummary({
      id: 'c1',
      name: '河北测试机械有限公司',
      uscc: '91130100TEST0000X1',
      province: '河北省',
      address: '河北省石家庄市桥西区测试路1号',
    });
    const full = scoreCandidate(
      { name: '河北测试机械有限公司', province: '河北省', city: '石家庄市' },
      candidate,
      { name: '河北测试机械有限公司', field: 'name' },
    );
    expect(full.relation).toBe('exact');
    expect(full.provinceMatch).toBe(true);
    expect(full.nameScore).toBeCloseTo(0.6, 4);
    // 无城市输入 → 无城市加分
    const noCity = scoreCandidate(
      { name: '河北测试机械有限公司', province: '河北省' },
      candidate,
      { name: '河北测试机械有限公司', field: 'name' },
    );
    expect(noCity.cityMatch).toBe(false);
    expect(full.score).toBeGreaterThan(noCity.score);
  });

  it('nameSimilarity：相同为 1，无关名称接近 0', () => {
    expect(nameSimilarity('河北测试机械有限公司', '河北测试机械有限公司')).toBe(1);
    expect(nameSimilarity('河北测试机械有限公司', '广州南方纺织有限公司')).toBeLessThan(0.4);
    expect(normalizeUscc(' 91130100 test-0000x1 ')).toBe('91130100TEST0000X1');
  });
});

describe('matching: 英文抬头（Ali/Mic，BR-18）', () => {
  it('ali 平台优先用英文抬头搜索，跨语言命中中文主体 → method=english_name', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { fetchImpl } = makeMockFetch((call) => {
      bodies.push(call.body as Record<string, unknown>);
      return okReply({
        companies: [
          companySummary({
            id: '37e1f57a7cabe8ba',
            name: '河北示例金属制品有限公司',
            uscc: '91130100TEST0000D4',
            province: '河北省',
            address: '河北省石家庄市裕华区裕华路街道槐北路98号',
            score: 276.70786,
          }),
        ],
        total: 1,
      });
    });
    const client = makeClient(fetchImpl);
    const result = await matchCompany(
      {
        name: '河北示例金属制品有限公司',
        englishName: 'Hebei Example Industrial Metal Co., Ltd.',
        province: '河北省',
        city: '石家庄市',
        platform: 'ali',
      },
      client,
    );

    // 第一次搜索使用去法律后缀/截断后的英文核心名（避免 Tanji keywords too long）
    expect(bodies[0]?.name).toBe('Hebei Example Industrial Metal');
    expect(bodies[0]?.field).toBe('name');
    expect(result.matched).toBe(true);
    expect(result.method).toBe('english_name');
    expect(result.queryName).toBe('Hebei Example Industrial Metal');
    expect(result.candidates[0]?.uscc).toBe('91130100TEST0000D4');
    // 跨语言命中：相关度(0.3*rel)+省(+0.2)+市(+0.2)+相关度(+0.1*rel) ≈ 0.51（低置信度如实记录）
    expect(result.confidence).toBeGreaterThan(0.45);
    expect(result.lowConfidence).toBe(true);
    expect(result.searches[0]?.field).toBe('name');
  });

  it('候选带 englishName 时按同语言规则精确比较（英文抬头命中）', async () => {
    const { fetchImpl } = makeMockFetch(
      okReply({
        companies: [
          companySummary({
            id: '3762300d937f3769',
            name: '河北示例线缆集团股份有限公司',
            englishName: 'Hebei Huatong Wires & Cables Group Co., Ltd.',
            uscc: '91130100TEST0000E5',
            province: '河北省',
            address: '河北省唐山市示例经济开发区示例街1号',
            score: 466.13403,
          }),
        ],
        total: 1,
      }),
    );
    const result = await matchCompany(
      {
        name: '河北示例线缆集团股份有限公司',
        englishName: 'Hebei Huatong Wires & Cables Group Co., Ltd.',
        province: '河北省',
        city: '唐山市',
        platform: 'mic',
      },
      makeClient(fetchImpl),
    );
    expect(result.matched).toBe(true);
    expect(result.candidates[0]?.id).toBe('3762300d937f3769');
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.lowConfidence).toBe(false);
  });

  it('英文搜索无结果时回退中文名搜索', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    const { fetchImpl } = makeMockFetch((call) => {
      const body = call.body as Record<string, unknown>;
      attempts.push(body);
      if (body.name === 'Test Hebei Machinery' || body.name === 'Test Hebei Machinery Co., Ltd.') return okReply({ companies: [], total: 0 });
      return okReply({
        companies: [
          companySummary({
            id: 'c_cn',
            name: '河北测试机械有限公司',
            uscc: '91130100TEST0000X1',
            province: '河北省',
            score: 600,
          }),
        ],
        total: 1,
      });
    });
    const result = await matchCompany(
      { name: '河北测试机械有限公司', englishName: 'Test Hebei Machinery Co., Ltd.', province: '河北省', platform: 'ali' },
      makeClient(fetchImpl),
    );
    expect(attempts[0]?.name).toBe('Test Hebei Machinery');
    expect(attempts[1]?.name).toBe('Test Hebei Machinery Co., Ltd.');
    expect(attempts[2]?.name).toBe('河北测试机械有限公司');
    expect(result.matched).toBe(true);
    expect(result.method).toBe('name_exact');
  });

  it('buildSearchAttempts：ali/mic 英文优先，boss/zhilian 中文优先，USCC 最前', () => {
    const ali = buildSearchAttempts({ name: '河北测试机械有限公司', englishName: 'Test Hebei Machinery Co., Ltd.', platform: 'ali' });
    expect(ali.map((a) => a.field)).toEqual(['name', 'name', 'name']);
    expect(ali[0]?.name).toBe('Test Hebei Machinery');
    expect(ali[1]?.name).toContain('Test Hebei');
    expect(ali[2]?.name).toContain('河北测试');

    const boss = buildSearchAttempts({ name: '河北测试机械有限公司', englishName: 'Test Hebei Machinery Co., Ltd.', platform: 'boss' });
    expect(boss[0]?.name).toContain('河北测试');

    const withUscc = buildSearchAttempts({ name: '河北测试机械有限公司', uscc: '91130100TEST0000X1', platform: 'boss' });
    expect(withUscc[0]).toEqual({ field: 'socialCreditCode', name: '91130100TEST0000X1' });
  });

  it('无 name/uscc → VALIDATION_ERROR', async () => {
    const search = { searchByName: async () => ({ companies: [] }) };
    await expect(matchCompany({ name: '' }, search)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// 5. 解锁安全闸门 + 幂等键透传（绝不真实调用）
// ---------------------------------------------------------------------------

describe('tanji adapter: unlock 安全闸门与幂等键', () => {
  it('默认 allowUnlock=false：unlockCompany 抛 UNSUPPORTED 且不发出网络请求', async () => {
    const { fetchImpl, calls } = makeMockFetch(okReply({}));
    const client = makeClient(fetchImpl);
    await expect(client.unlockCompany('cmp_1')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(calls).toHaveLength(0);
  });

  it('allowUnlock=true（P7 授权场景）时幂等键原样透传、请求体为 confirm/quota/contacts', async () => {
    const { fetchImpl, calls } = makeMockFetch(
      okReply({
        companyId: 'cmp_1',
        companyName: '河北测试机械有限公司',
        alreadyUnlocked: false,
        unlockedBy: 'main',
        unlockedAt: '2026-11-16T02:00:00.000Z',
        quotaCost: 1,
        quotaBefore: 223,
        quotaAfter: 222,
        contacts: [
          { contactId: 'ct_1', name: '测试联系人', type: 'mobile', value: '13800000000', masked: false, isKeyLead: true, unlocked: true },
        ],
      }),
    );
    const client = makeClient(fetchImpl, { allowUnlock: true });
    const result = await client.unlockCompany('cmp_1', { idempotencyKey: 'unlock:cmp_1:2026-11-16' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/v1/companies/cmp_1/unlock');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({
      confirm: true,
      quota: true,
      contacts: true,
      idempotencyKey: 'unlock:cmp_1:2026-11-16',
    });
    expect(result.alreadyUnlocked).toBe(false);
    expect(result.quotaCost).toBe(1);
    expect(result.quotaBefore).toBe(223);
    expect(result.quotaAfter).toBe(222);
    expect(result.contacts[0]?.value).toBe('13800000000');
  });

  it('createTanjiClientFromEnv：TANJI_ALLOW_UNLOCK 控制解锁开关，默认关闭', () => {
    const call = makeMockFetch(okReply({}));
    const off = createTanjiClientFromEnv({ TANJI_CLIENT_URL: 'http://127.0.0.1:8787', TANJI_API_TOKEN: 't' }, { fetchImpl: call.fetchImpl });
    expect(off.allowUnlock).toBe(false);
    const on = createTanjiClientFromEnv(
      { TANJI_CLIENT_URL: 'http://127.0.0.1:8787', TANJI_API_TOKEN: 't', TANJI_ALLOW_UNLOCK: 'true' },
      { fetchImpl: call.fetchImpl },
    );
    expect(on.allowUnlock).toBe(true);
    expect(createTanjiClient({ allowUnlock: false }).allowUnlock).toBe(false);
  });
});
