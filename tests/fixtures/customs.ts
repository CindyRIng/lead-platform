/**
 * 合成 fuma 海关提单 fixture（**全部为虚构数据，非真实企业/PII**）。
 *
 * 语义（对齐 docs/04 §6.6 与 docs/08）：
 *  - `companyFlag=1`：全球进口数据视图（境外进口商 → 中国出口商），目标公司通常作为 **exporter** 出现；
 *  - `companyFlag=2`：中国贸易数据视图，可能同时出现目标公司作为 exporter（境外买家）与 importer（境外供应商）；
 *  - `totalNum/allCount` 是上游**模糊命中**总数（远大于真实匹配数 → 用于 low confidence 场景）；
 *  - 每条记录都被 customs worker 做名称 token 过滤 + 角色分类，未命中记为 unmatched。
 *
 * 覆盖场景：
 *  - chenxing：high（≥5 条命中，含 exporter + importer 两种角色）
 *  - haichuan：high（5 条 exporter）
 *  - yunfan：medium（4 条命中：exporter + importer）
 *  - huaxi：低置信（2 条命中 + 大量噪声，totalNum 很大）
 *  - hengyue：no_data（totalNum=0，list 为空 → 不重试）
 */

export type CustomsFlag = 1 | 2;

export interface CustomsRecordFixture {
  tradeno: string;
  blnumber: string;
  sourcetype: string;
  source: string;
  inout: 'import' | 'export';
  regdate: string;
  rawimporter: string | null;
  importer: string;
  importercountry: string;
  importercountryen: string;
  rawexporter: string | null;
  exporter: string;
  exportercountry: string;
  exportercountryen: string;
  hscode: string;
  detail: string;
  weight: number;
  count: number;
  countunit: string;
  money: number;
  usedbuyername: string | null;
  usedsuppliername: string | null;
  updatetime: string;
  customs: string | null;
  tradetype: string | null;
}

export interface CompanyCustomsFixture {
  /** 可用于命中该 fixture 的查询名（英文抬头 / 中文注册名），大小写不敏感 */
  queryNames: string[];
  totals: Record<CustomsFlag, number>;
  records: Record<CustomsFlag, CustomsRecordFixture[]>;
}

function rec(partial: Partial<CustomsRecordFixture> & { tradeno: string; inout: CustomsRecordFixture['inout'] }): CustomsRecordFixture {
  const date = partial.regdate ?? '2026-10-15';
  return {
    tradeno: partial.tradeno,
    blnumber: partial.blnumber ?? `BL_SYNTH_${partial.tradeno}`,
    sourcetype: 'trade',
    source: partial.source ?? 'US',
    inout: partial.inout,
    regdate: date,
    rawimporter: partial.rawimporter ?? null,
    importer: partial.importer ?? 'SYNTHETIC UNKNOWN IMPORTER',
    importercountry: partial.importercountry ?? 'US',
    importercountryen: partial.importercountryen ?? 'United States',
    rawexporter: partial.rawexporter ?? null,
    exporter: partial.exporter ?? 'SYNTHETIC UNKNOWN EXPORTER',
    exportercountry: partial.exportercountry ?? 'CN',
    exportercountryen: partial.exportercountryen ?? 'China',
    hscode: partial.hscode ?? '848210',
    detail: partial.detail ?? 'SYNTHETIC GOODS',
    weight: partial.weight ?? 1000,
    count: partial.count ?? 10,
    countunit: partial.countunit ?? 'PKG',
    money: partial.money ?? 0,
    usedbuyername: partial.usedbuyername ?? partial.importer ?? null,
    usedsuppliername: partial.usedsuppliername ?? partial.rawexporter ?? null,
    updatetime: partial.updatetime ?? date,
    customs: null,
    tradetype: null,
  };
}

const CX = 'HEBEI CHENXING MACHINERY MANUFACTURING CO.,LTD';
const YF = 'HEBEI YUNFAN IMPORT AND EXPORT TRADING CO.,LTD';
const HY = 'SHIJIAZHUANG HENGYUE METAL PRODUCTS CO.,LTD';
const HX = 'BAODING HUAXI NEW ENERGY EQUIPMENT CO.,LTD';
const HC = 'CANGZHOU HAICHUAN PIPE EQUIPMENT CO.,LTD';

export const CUSTOMS_FIXTURES: Record<string, CompanyCustomsFixture> = {
  /**
   * 高置信：flag1 6 条 exporter 命中 + 2 条噪声；flag2 2 条 exporter + 1 条 importer + 1 条噪声。
   * matched = 9（exporter 8 / importer 1）→ confidence=high。
   */
  chenxing: {
    queryNames: ['Hebei Chenxing Machinery Manufacturing Co., Ltd.', '河北辰星机械制造有限公司'],
    totals: { 1: 1310, 2: 754 },
    records: {
      1: [
        rec({ tradeno: 'SYN_CX_IMP_001', inout: 'import', regdate: '2026-11-08', rawimporter: 'SYNTHETIC BUYER ONE LLC', importer: 'SYNTHETIC BUYER ONE LLC', importercountryen: 'United States', rawexporter: `${CX.slice(0, 38)}`, exporter: CX, hscode: '848210', detail: 'BEARING HOUSING', weight: 12000, count: 100 }),
        rec({ tradeno: 'SYN_CX_IMP_002', inout: 'import', regdate: '2026-11-05', rawimporter: 'SYNTHETIC BUYER TWO LLC', importer: 'SYNTHETIC BUYER TWO LLC', importercountryen: 'Ukraine', exporter: CX, hscode: '848210', detail: 'BEARING HOUSING', weight: 8000, count: 60 }),
        rec({ tradeno: 'SYN_CX_IMP_003', inout: 'import', regdate: '2026-10-24', rawimporter: 'SYNTHETIC BUYER THREE SP ZOO', importer: 'SYNTHETIC BUYER THREE SP ZOO', importercountryen: 'Poland', exporter: CX, hscode: '848220', detail: 'TAPERED ROLLER BEARING', weight: 5400, count: 40 }),
        rec({ tradeno: 'SYN_CX_IMP_004', inout: 'import', regdate: '2026-10-18', rawimporter: 'SYNTHETIC BUYER FOUR GMBH', importer: 'SYNTHETIC BUYER FOUR GMBH', importercountryen: 'Germany', exporter: CX, hscode: '848210', detail: 'BEARING HOUSING', weight: 6100, count: 45 }),
        rec({ tradeno: 'SYN_CX_IMP_005', inout: 'import', regdate: '2026-10-11', rawimporter: 'SYNTHETIC BUYER FIVE INC', importer: 'SYNTHETIC BUYER FIVE INC', importercountryen: 'United States', exporter: CX, hscode: '848230', detail: 'SPHERICAL ROLLER BEARING', weight: 7200, count: 50 }),
        rec({ tradeno: 'SYN_CX_IMP_006', inout: 'import', regdate: '2026-09-30', rawimporter: 'SYNTHETIC BUYER SIX CO LTD', importer: 'SYNTHETIC BUYER SIX CO LTD', importercountryen: 'Vietnam', exporter: CX, hscode: '848210', detail: 'BEARING HOUSING', weight: 4300, count: 30 }),
        // 噪声（名称不含目标公司 token，应被过滤为 unmatched）
        rec({ tradeno: 'SYN_CX_NOISE_001', inout: 'import', regdate: '2026-11-02', rawimporter: 'SYNTHETIC NOISE BUYER', importer: 'SYNTHETIC NOISE BUYER', importercountryen: 'Brazil', rawexporter: 'OTHER SYNTHETIC TRADING CO', exporter: 'OTHER SYNTHETIC TRADING CO', hscode: '730890', detail: 'STEEL STRUCTURE' }),
        rec({ tradeno: 'SYN_CX_NOISE_002', inout: 'import', regdate: '2026-10-21', rawimporter: 'SYNTHETIC NOISE BUYER TWO', importer: 'SYNTHETIC NOISE BUYER TWO', importercountryen: 'Mexico', rawexporter: 'ANOTHER SYNTHETIC FACTORY', exporter: 'ANOTHER SYNTHETIC FACTORY', hscode: '731815', detail: 'BOLTS' }),
      ],
      2: [
        rec({ tradeno: 'SYN_CX_CN_001', inout: 'import', regdate: '2026-10-28', rawimporter: 'SYNTHETIC BUYER SEVEN BV', importer: 'SYNTHETIC BUYER SEVEN BV', importercountryen: 'Netherlands', exporter: CX, hscode: '848210', detail: 'BEARING HOUSING' }),
        // 目标公司作为进口商（从德国供应商进口）
        rec({ tradeno: 'SYN_CX_CN_002', inout: 'export', regdate: '2026-09-19', rawimporter: 'HEBEI CHENXING MACHINERY MANUFACTURING CO., LTD', importer: 'HEBEI CHENXING MACHINERY MANUFACTURING CO., LTD', importercountryen: 'China', rawexporter: 'SYNTHETIC SUPPLIER EIGHT GMBH', exporter: 'SYNTHETIC SUPPLIER EIGHT GMBH', exportercountry: 'DE', exportercountryen: 'Germany', hscode: '845811', detail: 'CNC LATHE' }),
        rec({ tradeno: 'SYN_CX_CN_NOISE_001', inout: 'export', regdate: '2026-09-12', rawimporter: 'SYNTHETIC NOISE THREE', importer: 'SYNTHETIC NOISE THREE', importercountryen: 'China', rawexporter: 'UNRELATED SYNTHETIC SUPPLIER', exporter: 'UNRELATED SYNTHETIC SUPPLIER', exportercountryen: 'Italy', hscode: '820730', detail: 'TOOLS' }),
      ],
    },
  },

  /** 中置信：flag1 2 条 exporter，flag2 1 条 exporter + 1 条 importer → matched=4 → medium。 */
  yunfan: {
    queryNames: ['Hebei Yunfan Import & Export Trading Co., Ltd.', '河北云帆进出口贸易有限公司'],
    totals: { 1: 218, 2: 96 },
    records: {
      1: [
        rec({ tradeno: 'SYN_YF_IMP_001', inout: 'import', regdate: '2026-11-01', rawimporter: 'SYNTHETIC BUYER NINE CO LTD', importer: 'SYNTHETIC BUYER NINE CO LTD', importercountry: 'VN', importercountryen: 'Vietnam', exporter: YF, hscode: '730719', detail: 'PIPE FITTING', weight: 21000, count: 120 }),
        rec({ tradeno: 'SYN_YF_IMP_002', inout: 'import', regdate: '2026-10-12', rawimporter: 'SYNTHETIC BUYER TEN CO LTD', importer: 'SYNTHETIC BUYER TEN CO LTD', importercountry: 'TH', importercountryen: 'Thailand', exporter: YF, hscode: '730719', detail: 'PIPE FITTING', weight: 15000, count: 80 }),
      ],
      2: [
        rec({ tradeno: 'SYN_YF_CN_001', inout: 'import', regdate: '2026-10-03', rawimporter: 'SYNTHETIC BUYER ELEVEN PTE LTD', importer: 'SYNTHETIC BUYER ELEVEN PTE LTD', importercountry: 'SG', importercountryen: 'Singapore', exporter: YF, hscode: '730719', detail: 'PIPE FITTING' }),
        rec({ tradeno: 'SYN_YF_CN_002', inout: 'export', regdate: '2026-09-25', rawimporter: 'HEBEI YUNFAN IMPORT AND EXPORT TRADING CO LTD', importer: 'HEBEI YUNFAN IMPORT AND EXPORT TRADING CO LTD', importercountryen: 'China', rawexporter: 'SYNTHETIC SUPPLIER TWELVE CO LTD', exporter: 'SYNTHETIC SUPPLIER TWELVE CO LTD', exportercountry: 'KR', exportercountryen: 'Korea', hscode: '846261', detail: 'HYDRAULIC PRESS' }),
      ],
    },
  },

  /** 低置信：totalNum 很大但命中仅 2 条 → 不应展示 Top 榜单。 */
  huaxi: {
    queryNames: ['Baoding Huaxi New Energy Equipment Co., Ltd.', '保定华曦新能源设备有限公司'],
    totals: { 1: 500, 2: 0 },
    records: {
      1: [
        rec({ tradeno: 'SYN_HX_IMP_001', inout: 'import', regdate: '2026-10-26', rawimporter: 'SYNTHETIC BUYER THIRTEEN BV', importer: 'SYNTHETIC BUYER THIRTEEN BV', importercountryen: 'Netherlands', exporter: HX, hscode: '854143', detail: 'SOLAR PANEL', weight: 9800, count: 70 }),
        rec({ tradeno: 'SYN_HX_IMP_002', inout: 'import', regdate: '2026-10-08', rawimporter: 'SYNTHETIC BUYER FOURTEEN SL', importer: 'SYNTHETIC BUYER FOURTEEN SL', importercountryen: 'Spain', exporter: HX, hscode: '854143', detail: 'SOLAR PANEL', weight: 7600, count: 55 }),
        ...Array.from({ length: 6 }, (_, i) =>
          rec({ tradeno: `SYN_HX_NOISE_00${i + 1}`, inout: 'import', regdate: '2026-10-0' + ((i % 9) + 1), rawimporter: `SYNTHETIC NOISE IMPORTER ${i + 1}`, importer: `SYNTHETIC NOISE IMPORTER ${i + 1}`, importercountryen: 'Brazil', rawexporter: `UNRELATED SYNTHETIC EXPORTER ${i + 1}`, exporter: `UNRELATED SYNTHETIC EXPORTER ${i + 1}`, hscode: '850440', detail: 'POWER SUPPLY' }),
        ),
      ],
      2: [],
    },
  },

  /** 高置信：flag1 5 条 exporter 命中 + 1 条噪声；flag2 无记录。 */
  haichuan: {
    queryNames: ['Cangzhou Haichuan Pipe Equipment Co., Ltd.', '沧州海川管道装备有限公司'],
    totals: { 1: 2400, 2: 0 },
    records: {
      1: [
        rec({ tradeno: 'SYN_HC_IMP_001', inout: 'import', regdate: '2026-11-07', rawimporter: 'SYNTHETIC BUYER FIFTEEN LLC', importer: 'SYNTHETIC BUYER FIFTEEN LLC', importercountryen: 'United States', exporter: HC, hscode: '730719', detail: 'PIPE FITTING', weight: 18000, count: 90 }),
        rec({ tradeno: 'SYN_HC_IMP_002', inout: 'import', regdate: '2026-10-30', rawimporter: 'SYNTHETIC BUYER SIXTEEN GMBH', importer: 'SYNTHETIC BUYER SIXTEEN GMBH', importercountryen: 'Germany', exporter: HC, hscode: '730791', detail: 'FLANGE', weight: 12500, count: 65 }),
        rec({ tradeno: 'SYN_HC_IMP_003', inout: 'import', regdate: '2026-10-22', rawimporter: 'SYNTHETIC BUYER SEVENTEEN SRL', importer: 'SYNTHETIC BUYER SEVENTEEN SRL', importercountryen: 'Italy', exporter: HC, hscode: '730719', detail: 'PIPE FITTING', weight: 9300, count: 48 }),
        rec({ tradeno: 'SYN_HC_IMP_004', inout: 'import', regdate: '2026-10-14', rawimporter: 'SYNTHETIC BUYER EIGHTEEN SA', importer: 'SYNTHETIC BUYER EIGHTEEN SA', importercountryen: 'Poland', exporter: HC, hscode: '730791', detail: 'FLANGE', weight: 7400, count: 39 }),
        rec({ tradeno: 'SYN_HC_IMP_005', inout: 'import', regdate: '2026-10-02', rawimporter: 'SYNTHETIC BUYER NINETEEN FZE', importer: 'SYNTHETIC BUYER NINETEEN FZE', importercountryen: 'United Arab Emirates', exporter: HC, hscode: '730719', detail: 'PIPE FITTING', weight: 6600, count: 34 }),
        rec({ tradeno: 'SYN_HC_NOISE_001', inout: 'import', regdate: '2026-09-28', rawimporter: 'SYNTHETIC NOISE BUYER FOUR', importer: 'SYNTHETIC NOISE BUYER FOUR', importercountryen: 'Russia', rawexporter: 'UNRELATED SYNTHETIC TRADING', exporter: 'UNRELATED SYNTHETIC TRADING', hscode: '730419', detail: 'SEAMLESS PIPE' }),
      ],
      2: [],
    },
  },

  /** 无数据：totalNum=0 且 list 为空（正常 no_data，不重试）。 */
  hengyue: {
    queryNames: ['Shijiazhuang Hengyue Metal Products Co., Ltd.', '石家庄恒岳金属制品有限公司'],
    totals: { 1: 0, 2: 0 },
    records: { 1: [], 2: [] },
  },
};

/** 归一原始名称字段：真实 fuma 中 raw* 可能为 null，但 exporter/importer 字段有值；补全便于名称过滤/样例断言 */
for (const fixture of Object.values(CUSTOMS_FIXTURES)) {
  for (const flag of [1, 2] as const) {
    for (const record of fixture.records[flag]) {
      if (!record.rawimporter && record.importer) record.rawimporter = record.importer;
      if (!record.rawexporter && record.exporter) record.rawexporter = record.exporter;
      if (!record.usedbuyername && record.rawimporter) record.usedbuyername = record.rawimporter;
      if (!record.usedsuppliername && record.rawexporter) record.usedsuppliername = record.rawexporter;
    }
  }
}

/** 按查询名（英文抬头 / 中文名，大小写不敏感）找海关 fixture。 */
export function findCustomsFixtureByQueryName(name: string): CompanyCustomsFixture | undefined {
  const q = name.trim().toUpperCase();
  if (!q) return undefined;
  for (const fixture of Object.values(CUSTOMS_FIXTURES)) {
    if (fixture.queryNames.some((n) => n.toUpperCase() === q)) return fixture;
  }
  // 宽松匹配：查询名包含在任一 fixture 名称中（或反向），用于英文/中文名混用场景
  for (const fixture of Object.values(CUSTOMS_FIXTURES)) {
    if (fixture.queryNames.some((n) => {
      const nn = n.toUpperCase();
      return q.length >= 6 && (nn.includes(q) || q.includes(nn));
    })) return fixture;
  }
  return undefined;
}

export function customsKeyForQueryName(name: string): string | undefined {
  const direct = findCustomsFixtureByQueryName(name);
  if (!direct) return undefined;
  return Object.entries(CUSTOMS_FIXTURES).find(([, f]) => f === direct)?.[0];
}
