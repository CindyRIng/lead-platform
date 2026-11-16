/**
 * 合成公司 fixture（**虚构数据，非真实企业/个人**）。
 *
 * 覆盖场景：
 *  - 跨源重复（同一公司在多个平台出现）→ 去重/合并
 *  - 有 USCC / 无 USCC / 英文抬头 → 探迹 USCC / 名称 / 英文名匹配
 *  - 探迹已解锁（alreadyUnlocked 不扣额度）/ 未解锁（需要 unlock）
 *  - 探迹匹配不到（unmatched，不消耗额度）
 *  - 海关数据 high/medium/low/none（含噪声记录）
 *
 * 命名约定：公司名、法人、联系人、电话、USCC 全部为合成值；
 * USCC 形如 `91SYNTH0000000001A`，一眼可辨非真实统一社会信用代码。
 */

export interface SyntheticContact {
  contactId: string;
  name: string;
  position: string;
  department: string;
  region: string;
  type: 'mobile' | 'phone' | 'email';
  value: string;
  masked: boolean;
  source: string;
  isKeyLead: boolean;
}

export interface BossPresence {
  companyId: string;
  sourceName: string;
  industry: string;
  scale: string;
  stage: string;
  /** 可被哪些检索关键词命中 */
  keywords: string[];
  jobCountRound1: number;
  bossCount: number;
  intro: string;
  tags: string[];
  benefits: string[];
  address: string;
}

export interface ZhilianPresence {
  companyNumber: string;
  sourceName: string;
  industry: string;
  size: string;
  keywords: string[];
  jobCountRound1: number;
  intro: string;
  tags: string[];
  benefits: string[];
  address: string;
  website: string;
}

export interface AliPresence {
  companyId: string;
  /** 英文抬头（B2B 店铺名） */
  companyName: string;
  storeSubdomain: string;
  keywords: string[];
  mainProducts: string[];
  location: {
    country: 'CN';
    countryName: 'China';
    province: 'Hebei';
    provinceCode: 'CN-13';
    city: string;
    cityCode: string;
    address: string;
    display: string;
    confidence: 'high';
    source: 'detail';
  };
  joinedYears: number;
  supplierIndex: { stars: number; maxStars: 5; label: string };
  membership: {
    plan: string;
    label: string;
    rank: number;
    verifiedSupplier: boolean;
    verifiedPro: boolean;
    paidMember: boolean;
    goldSupplier: boolean;
    onsiteAssessment: boolean;
    goldYears: number;
    assessedBy: string | null;
  };
  rating: { score: number; count: number };
  businessType: { raw: string; manufacturer: boolean; tradingCompany: boolean };
  profile: {
    establishedYear: number;
    annualRevenue: { value: string; kind: 'number' };
    employees: string;
    mainMarkets: string[];
    paymentMethods: string;
    deliveryTerms: string;
    contractManufacturing: string[];
    description: string;
    advantageDescription: string;
    capacityTags: string[];
  };
  performance: {
    storeRating: { score: number; count: number };
    onTimeDeliveryRate: string;
    responseRate: string;
    responseTime: string;
    floorSpaceText: string;
    productionLines: number;
    totalExportRevenueUSD: string;
  };
  capabilities: { certifications: string[]; productionCapacity: string };
  trust: { verifiedSupplier: boolean; assessedBy: string | null };
  identity: { supplierIndexStars: number; joinedYears: number };
}

export interface MicPresence {
  account: string;
  companyId: string;
  /** 英文抬头 */
  companyName: string;
  /** 英文城市名（api_value） */
  city: string;
  mainProducts: string[];
  businessTypes: string[];
  membership: {
    tier: 'diamond' | 'gold' | 'free' | 'unknown';
    raw_cs_level: number | null;
    raw_member_level: string | null;
    since_year: number | null;
    evidence: string[];
    confidence: 'high' | 'medium' | 'low';
  };
  audited: boolean;
  capabilityStars: number;
  systemCertifications: string[];
  employees: string | null;
  turnover: string | null;
  plantArea: string | null;
  establishedAt: string | null;
  address: string;
  companyUrl: string;
  companyInfoUrl: string;
}

export interface TanjiPresence {
  id: string;
  /** 权威注册名（中文） */
  name: string;
  uscc: string;
  legalRepresentative: string;
  regCapital: { value: number; coinType: '人民币'; text: string };
  foundTime: string;
  address: string;
  province: '河北省';
  operStatus: string;
  industry: { first: string; second: string; third: string; fourth: string };
  scale: string | null;
  tags: string[];
  businessScope: string;
  homepage: string | null;
  /** 可被 tanji search/name 命中的名称（中文名 / 英文抬头） */
  matchNames: string[];
  matchScore: number;
  /** 初始是否已解锁（true → 走 alreadyUnlocked 路径，不扣额度） */
  contactsUnlocked: boolean;
  contacts: SyntheticContact[];
}

export interface SyntheticCompany {
  key: string;
  /** 中文公司名（合成） */
  name: string;
  englishName: string | null;
  uscc: string | null;
  cityCode: string;
  cityName: string;
  province: '河北省';
  legalRepresentative: string;
  regCapital: string;
  foundTime: string;
  industry: string;
  scale: string;
  address: string;
  businessScope: string;
  boss?: BossPresence;
  zhilian?: ZhilianPresence;
  ali?: AliPresence;
  mic?: MicPresence;
  tanji: TanjiPresence | null;
  /** 是否应产生海关查询（仅 Ali/Mic 且资料可查；no_data 也仍会查询） */
  customsQueryNames: string[] | null;
}

const HEBEI = '河北省';
const NOISE = '（合成测试数据，非真实企业）';

function contact(
  contactId: string,
  name: string,
  position: string,
  type: SyntheticContact['type'],
  value: string,
  opts: Partial<SyntheticContact> = {},
): SyntheticContact {
  return {
    contactId,
    name,
    position,
    department: '国际业务部',
    region: '石家庄',
    type,
    value,
    masked: false,
    source: 'tanji',
    isKeyLead: true,
    ...opts,
  };
}

export const COMPANIES: SyntheticCompany[] = [
  {
    key: 'chenxing',
    name: '河北辰星机械制造有限公司',
    englishName: 'Hebei Chenxing Machinery Manufacturing Co., Ltd.',
    uscc: '91SYNTH0000000001A',
    cityCode: '130100',
    cityName: '石家庄市',
    province: HEBEI,
    legalRepresentative: '示例法人甲',
    regCapital: '300万人民币',
    foundTime: '2012-03-15',
    industry: '通用设备制造业',
    scale: '100-499人',
    address: `河北省石家庄市示例高新区创业大道 1 号${NOISE}`,
    businessScope: '通用机械设备及配件制造、销售；货物或技术进出口。（合成测试数据）',
    boss: {
      companyId: 'boss_cx_001',
      sourceName: '辰星机械',
      industry: '进出口贸易',
      scale: '100-499人',
      stage: '不需要融资',
      keywords: ['外贸', '国际贸易'],
      jobCountRound1: 3,
      bossCount: 2,
      intro: '合成测试公司简介：从事通用机械设备制造与出口。',
      tags: ['进出口贸易', '机械设备'],
      benefits: ['双休', '五险', '年终奖'],
      address: '石家庄市示例高新区创业大道 1 号',
    },
    ali: {
      companyId: 'ali_cx_1001',
      companyName: 'Hebei Chenxing Machinery Manufacturing Co., Ltd.',
      storeSubdomain: 'chenxing-machinery',
      keywords: ['machinery'],
      mainProducts: ['Fence Post', 'Garden Gate', 'Gabions'],
      location: {
        country: 'CN',
        countryName: 'China',
        province: 'Hebei',
        provinceCode: 'CN-13',
        city: 'Shijiazhuang',
        cityCode: 'CN-13-1301',
        address: `Room 101, Example Building, No. 1 Chuangye Road, Shijiazhuang, Hebei, China${NOISE}`,
        display: 'Hebei, China',
        confidence: 'high',
        source: 'detail',
      },
      joinedYears: 12,
      supplierIndex: { stars: 3, maxStars: 5, label: 'Supplier Index' },
      membership: {
        plan: 'verified_supplier',
        label: 'Verified Supplier',
        rank: 2,
        verifiedSupplier: true,
        verifiedPro: false,
        paidMember: true,
        goldSupplier: true,
        onsiteAssessment: true,
        goldYears: 12,
        assessedBy: 'SGS Group',
      },
      rating: { score: 4.8, count: 32 },
      businessType: { raw: 'Manufacturer, Trading Company', manufacturer: true, tradingCompany: true },
      profile: {
        establishedYear: 2012,
        annualRevenue: { value: '8000000', kind: 'number' },
        employees: '51 - 100 People',
        mainMarkets: ['North America', 'Western Europe'],
        paymentMethods: 'T/T, L/C',
        deliveryTerms: 'FOB, CIF',
        contractManufacturing: ['OEM Service Offered'],
        description: 'Synthetic test store description for Chenxing Machinery.',
        advantageDescription: 'Synthetic advantages.',
        capacityTags: ['Year Established', 'Total Employees'],
      },
      performance: {
        storeRating: { score: 4.8, count: 32 },
        onTimeDeliveryRate: '99.0%',
        responseRate: '96.0%',
        responseTime: '<2h',
        floorSpaceText: '8,000㎡',
        productionLines: 3,
        totalExportRevenueUSD: '5000000',
      },
      capabilities: { certifications: ['ISO 9001', 'CE'], productionCapacity: 'OEM/ODM' },
      trust: { verifiedSupplier: true, assessedBy: 'SGS Group' },
      identity: { supplierIndexStars: 3, joinedYears: 12 },
    },
    tanji: {
      id: 'tanji_cx_001',
      name: '河北辰星机械制造有限公司',
      uscc: '91SYNTH0000000001A',
      legalRepresentative: '示例法人甲',
      regCapital: { value: 3000000, coinType: '人民币', text: '300.000000万人民币' },
      foundTime: '2012-03-15',
      address: `河北省石家庄市示例高新区创业大道 1 号${NOISE}`,
      province: HEBEI,
      operStatus: '营业 > 存续(在营、开业、在册)',
      industry: { first: '制造业', second: '通用设备制造业', third: '金属加工机械制造', fourth: '机床功能部件及附件制造' },
      scale: '100-499人',
      tags: ['进出口', '机械制造'],
      businessScope: '通用机械设备及配件制造、销售；货物或技术进出口。（合成测试数据）',
      homepage: 'https://example.invalid/chenxing',
      matchNames: ['河北辰星机械制造有限公司', 'Hebei Chenxing Machinery Manufacturing Co., Ltd.'],
      matchScore: 466,
      contactsUnlocked: true,
      contacts: [
        contact('tjc_cx_001', '示例联系人甲', '外贸经理', 'mobile', '13800000001'),
        contact('tjc_cx_002', '示例联系人乙', '外贸专员', 'email', 'contact-a@example.invalid', { isKeyLead: false }),
      ],
    },
    customsQueryNames: [
      'Hebei Chenxing Machinery Manufacturing Co., Ltd.',
      '河北辰星机械制造有限公司',
    ],
  },
  {
    key: 'yunfan',
    name: '河北云帆进出口贸易有限公司',
    englishName: 'Hebei Yunfan Import & Export Trading Co., Ltd.',
    uscc: '91SYNTH0000000002B',
    cityCode: '130200',
    cityName: '唐山市',
    province: HEBEI,
    legalRepresentative: '示例法人乙',
    regCapital: '500万人民币',
    foundTime: '2015-07-01',
    industry: '批发业',
    scale: '20-99人',
    address: `河北省唐山市示例区示例路 2 号${NOISE}`,
    businessScope: '钢材、管件、机械设备批发零售；货物或技术进出口。（合成测试数据）',
    zhilian: {
      companyNumber: 'ZL_yf_001',
      sourceName: '云帆进出口',
      industry: '贸易/进出口',
      size: '20-99人',
      keywords: ['外贸', '跨境电商'],
      jobCountRound1: 2,
      intro: '合成测试公司简介：钢材与管件出口贸易。',
      tags: ['进出口', '贸易'],
      benefits: ['双休', '五险'],
      address: '唐山市示例区示例路 2 号',
      website: 'https://example.invalid/yunfan',
    },
    mic: {
      account: 'yunfan-trade',
      companyId: '2000000002',
      companyName: 'Hebei Yunfan Import & Export Trading Co., Ltd.',
      city: 'Tangshan',
      mainProducts: ['Steel Pipe', 'Pipe Fitting', 'Flange'],
      businessTypes: ['Trading Company'],
      membership: {
        tier: 'gold',
        raw_cs_level: 30,
        raw_member_level: 'gold',
        since_year: 2016,
        evidence: ['json:csLevel=30', 'json:memberLevel=gold'],
        confidence: 'high',
      },
      audited: true,
      capabilityStars: 2,
      systemCertifications: ['ISO 9001'],
      employees: '20-50 People',
      turnover: 'US$1M - US$5M',
      plantArea: null,
      establishedAt: '2015-07-01',
      address: `Tangshan, Hebei, China${NOISE}`,
      companyUrl: 'https://example.invalid/mic/yunfan-trade',
      companyInfoUrl: 'https://example.invalid/mic/yunfan-trade/info',
    },
    tanji: {
      id: 'tanji_yf_001',
      name: '河北云帆进出口贸易有限公司',
      uscc: '91SYNTH0000000002B',
      legalRepresentative: '示例法人乙',
      regCapital: { value: 5000000, coinType: '人民币', text: '500.000000万人民币' },
      foundTime: '2015-07-01',
      address: `河北省唐山市示例区示例路 2 号${NOISE}`,
      province: HEBEI,
      operStatus: '营业 > 存续(在营、开业、在册)',
      industry: { first: '批发和零售业', second: '批发业', third: '矿产品、建材及化工产品批发', fourth: '金属及金属矿批发' },
      scale: '20-99人',
      tags: ['进出口', '钢材贸易'],
      businessScope: '钢材、管件、机械设备批发零售；货物或技术进出口。（合成测试数据）',
      homepage: null,
      matchNames: ['河北云帆进出口贸易有限公司', 'Hebei Yunfan Import & Export Trading Co., Ltd.'],
      matchScore: 224,
      contactsUnlocked: false,
      contacts: [
        contact('tjc_yf_001', '示例联系人丙', '总经理', 'mobile', '13800000002', { region: '唐山' }),
        contact('tjc_yf_002', '示例联系人丁', '外贸业务员', 'phone', '0311-00000002', { region: '唐山', isKeyLead: false }),
      ],
    },
    customsQueryNames: [
      'Hebei Yunfan Import & Export Trading Co., Ltd.',
      '河北云帆进出口贸易有限公司',
    ],
  },
  {
    key: 'hengyue',
    name: '石家庄恒岳金属制品有限公司',
    englishName: 'Shijiazhuang Hengyue Metal Products Co., Ltd.',
    uscc: null,
    cityCode: '130100',
    cityName: '石家庄市',
    province: HEBEI,
    legalRepresentative: '示例法人丙',
    regCapital: '100万人民币',
    foundTime: '2018-11-20',
    industry: '金属制品业',
    scale: '50-99人',
    address: `河北省石家庄市示例工业园 3 号${NOISE}`,
    businessScope: '金属丝网、护栏制品加工销售；货物进出口。（合成测试数据）',
    ali: {
      companyId: 'ali_hy_1002',
      companyName: 'Shijiazhuang Hengyue Metal Products Co., Ltd.',
      storeSubdomain: 'hengyue-metal',
      keywords: ['hardware', 'metal'],
      mainProducts: ['Wire Mesh', 'Fence Panel', 'Razor Wire'],
      location: {
        country: 'CN',
        countryName: 'China',
        province: 'Hebei',
        provinceCode: 'CN-13',
        city: 'Shijiazhuang',
        cityCode: 'CN-13-1301',
        address: `No. 3 Example Industrial Park, Shijiazhuang, Hebei, China${NOISE}`,
        display: 'Hebei, China',
        confidence: 'high',
        source: 'detail',
      },
      joinedYears: 6,
      supplierIndex: { stars: 2, maxStars: 5, label: 'Supplier Index' },
      membership: {
        plan: 'gold_supplier',
        label: 'Gold Supplier',
        rank: 3,
        verifiedSupplier: false,
        verifiedPro: false,
        paidMember: true,
        goldSupplier: true,
        onsiteAssessment: false,
        goldYears: 6,
        assessedBy: null,
      },
      rating: { score: 4.5, count: 12 },
      businessType: { raw: 'Manufacturer', manufacturer: true, tradingCompany: false },
      profile: {
        establishedYear: 2018,
        annualRevenue: { value: '2000000', kind: 'number' },
        employees: '11 - 50 People',
        mainMarkets: ['Southern Europe'],
        paymentMethods: 'T/T',
        deliveryTerms: 'FOB',
        contractManufacturing: [],
        description: 'Synthetic test store description for Hengyue Metal.',
        advantageDescription: 'Synthetic advantages.',
        capacityTags: ['Year Established'],
      },
      performance: {
        storeRating: { score: 4.5, count: 12 },
        onTimeDeliveryRate: '97.0%',
        responseRate: '90.0%',
        responseTime: '<8h',
        floorSpaceText: '3,000㎡',
        productionLines: 1,
        totalExportRevenueUSD: '800000',
      },
      capabilities: { certifications: ['ISO 9001'], productionCapacity: 'OEM' },
      trust: { verifiedSupplier: false, assessedBy: null },
      identity: { supplierIndexStars: 2, joinedYears: 6 },
    },
    tanji: null,
    customsQueryNames: ['Shijiazhuang Hengyue Metal Products Co., Ltd.', '石家庄恒岳金属制品有限公司'],
  },
  {
    key: 'lanjing',
    name: '唐山蓝鲸重工科技有限公司',
    englishName: null,
    uscc: '91SYNTH0000000004D',
    cityCode: '130200',
    cityName: '唐山市',
    province: HEBEI,
    legalRepresentative: '示例法人丁',
    regCapital: '1000万人民币',
    foundTime: '2010-05-08',
    industry: '专用设备制造业',
    scale: '200-499人',
    address: `河北省唐山市示例开发区 4 号${NOISE}`,
    businessScope: '重型机械设备研发、制造、销售；货物进出口。（合成测试数据）',
    boss: {
      companyId: 'boss_lj_002',
      sourceName: '蓝鲸重工',
      industry: '机械设备/机电/重工',
      scale: '200-499人',
      stage: '不需要融资',
      keywords: ['外贸'],
      jobCountRound1: 2,
      bossCount: 1,
      intro: '合成测试公司简介：重型机械制造。',
      tags: ['机械制造', '进出口'],
      benefits: ['五险一金', '双休'],
      address: '唐山市示例开发区 4 号',
    },
    tanji: {
      id: 'tanji_lj_002',
      name: '唐山蓝鲸重工科技有限公司',
      uscc: '91SYNTH0000000004D',
      legalRepresentative: '示例法人丁',
      regCapital: { value: 10000000, coinType: '人民币', text: '1000.000000万人民币' },
      foundTime: '2010-05-08',
      address: `河北省唐山市示例开发区 4 号${NOISE}`,
      province: HEBEI,
      operStatus: '营业 > 存续(在营、开业、在册)',
      industry: { first: '制造业', second: '专用设备制造业', third: '采矿、冶金、建筑专用设备制造', fourth: '冶金专用设备制造' },
      scale: '200-499人',
      tags: ['重工', '进出口'],
      businessScope: '重型机械设备研发、制造、销售；货物进出口。（合成测试数据）',
      homepage: null,
      matchNames: ['唐山蓝鲸重工科技有限公司'],
      matchScore: 380,
      contactsUnlocked: false,
      contacts: [contact('tjc_lj_001', '示例联系人戊', '外贸总监', 'mobile', '13800000003', { region: '唐山' })],
    },
    customsQueryNames: null,
  },
  {
    key: 'huaxi',
    name: '保定华曦新能源设备有限公司',
    englishName: 'Baoding Huaxi New Energy Equipment Co., Ltd.',
    uscc: '91SYNTH0000000005E',
    cityCode: '130600',
    cityName: '保定市',
    province: HEBEI,
    legalRepresentative: '示例法人戊',
    regCapital: '800万人民币',
    foundTime: '2016-09-12',
    industry: '电气机械和器材制造业',
    scale: '100-299人',
    address: `河北省保定市示例产业园 5 号${NOISE}`,
    businessScope: '新能源发电设备、逆变器研发制造销售；货物或技术进出口。（合成测试数据）',
    mic: {
      account: 'huaxi-energy',
      companyId: '2000000005',
      companyName: 'Baoding Huaxi New Energy Equipment Co., Ltd.',
      city: 'Baoding',
      mainProducts: ['Solar Panel', 'Inverter', 'Energy Storage System'],
      businessTypes: ['Manufacturer/Factory'],
      membership: {
        tier: 'gold',
        raw_cs_level: 30,
        raw_member_level: 'gold',
        since_year: 2018,
        evidence: ['json:csLevel=30'],
        confidence: 'high',
      },
      audited: true,
      capabilityStars: 2,
      systemCertifications: ['ISO 9001', 'CE'],
      employees: null,
      turnover: null,
      plantArea: null,
      establishedAt: null,
      address: `Baoding, Hebei, China${NOISE}`,
      companyUrl: 'https://example.invalid/mic/huaxi-energy',
      companyInfoUrl: 'https://example.invalid/mic/huaxi-energy/info',
    },
    tanji: {
      id: 'tanji_hx_003',
      name: '保定华曦新能源设备有限公司',
      uscc: '91SYNTH0000000005E',
      legalRepresentative: '示例法人戊',
      regCapital: { value: 8000000, coinType: '人民币', text: '800.000000万人民币' },
      foundTime: '2016-09-12',
      address: `河北省保定市示例产业园 5 号${NOISE}`,
      province: HEBEI,
      operStatus: '营业 > 存续(在营、开业、在册)',
      industry: { first: '制造业', second: '电气机械和器材制造业', third: '电机制造', fourth: '发电机及发电机组制造' },
      scale: '100-299人',
      tags: ['新能源', '进出口'],
      businessScope: '新能源发电设备、逆变器研发制造销售；货物或技术进出口。（合成测试数据）',
      homepage: null,
      matchNames: ['保定华曦新能源设备有限公司', 'Baoding Huaxi New Energy Equipment Co., Ltd.'],
      matchScore: 277,
      contactsUnlocked: false,
      contacts: [
        contact('tjc_hx_001', '示例联系人己', '国际业务经理', 'mobile', '13800000004', { region: '保定' }),
        contact('tjc_hx_002', '示例联系人庚', '销售工程师', 'email', 'contact-b@example.invalid', { region: '保定', isKeyLead: false }),
      ],
    },
    customsQueryNames: [
      'Baoding Huaxi New Energy Equipment Co., Ltd.',
      '保定华曦新能源设备有限公司',
    ],
  },
  {
    key: 'haichuan',
    name: '沧州海川管道装备有限公司',
    englishName: 'Cangzhou Haichuan Pipe Equipment Co., Ltd.',
    uscc: '91SYNTH0000000006F',
    cityCode: '130900',
    cityName: '沧州市',
    province: HEBEI,
    legalRepresentative: '示例法人己',
    regCapital: '2000万人民币',
    foundTime: '2009-02-18',
    industry: '金属制品业',
    scale: '100-299人',
    address: `河北省沧州市示例工业区 6 号${NOISE}`,
    businessScope: '管道装备、管件、法兰制造销售；货物或技术进出口。（合成测试数据）',
    ali: {
      companyId: 'ali_hc_1003',
      companyName: 'Cangzhou Haichuan Pipe Equipment Co., Ltd.',
      storeSubdomain: 'haichuan-pipe',
      keywords: ['pipe fitting'],
      mainProducts: ['Pipe Fitting', 'Flange', 'Steel Pipe'],
      location: {
        country: 'CN',
        countryName: 'China',
        province: 'Hebei',
        provinceCode: 'CN-13',
        city: 'Cangzhou',
        cityCode: 'CN-13-1309',
        address: `No. 6 Example Industrial Zone, Cangzhou, Hebei, China${NOISE}`,
        display: 'Hebei, China',
        confidence: 'high',
        source: 'detail',
      },
      joinedYears: 16,
      supplierIndex: { stars: 3, maxStars: 5, label: 'Supplier Index' },
      membership: {
        plan: 'verified_pro',
        label: 'Verified Pro Supplier',
        rank: 1,
        verifiedSupplier: true,
        verifiedPro: true,
        paidMember: true,
        goldSupplier: true,
        onsiteAssessment: true,
        goldYears: 16,
        assessedBy: 'TUV',
      },
      rating: { score: 4.9, count: 58 },
      businessType: { raw: 'Manufacturer, Trading Company', manufacturer: true, tradingCompany: true },
      profile: {
        establishedYear: 2009,
        annualRevenue: { value: '15000000', kind: 'number' },
        employees: '101 - 200 People',
        mainMarkets: ['Eastern Europe', 'Mid East'],
        paymentMethods: 'T/T, L/C',
        deliveryTerms: 'FOB, CFR, CIF',
        contractManufacturing: ['OEM Service Offered'],
        description: 'Synthetic test store description for Haichuan Pipe.',
        advantageDescription: 'Synthetic advantages.',
        capacityTags: ['Factory Size', 'Production Lines'],
      },
      performance: {
        storeRating: { score: 4.9, count: 58 },
        onTimeDeliveryRate: '98.5%',
        responseRate: '97.0%',
        responseTime: '<1h',
        floorSpaceText: '20,000㎡',
        productionLines: 5,
        totalExportRevenueUSD: '12000000',
      },
      capabilities: { certifications: ['ISO 9001', 'API'], productionCapacity: 'OEM/ODM' },
      trust: { verifiedSupplier: true, assessedBy: 'TUV' },
      identity: { supplierIndexStars: 3, joinedYears: 16 },
    },
    mic: {
      account: 'haichuan-pipe',
      companyId: '2000000006',
      companyName: 'Cangzhou Haichuan Pipe Equipment Co., Ltd.',
      city: 'Cangzhou',
      mainProducts: ['Pipe Fitting', 'Flange', 'Steel Pipe'],
      businessTypes: ['Manufacturer/Factory & Trading Company'],
      membership: {
        tier: 'diamond',
        raw_cs_level: 50,
        raw_member_level: 'diamond',
        since_year: 2013,
        evidence: ['json:csLevel=50', 'json:memberLevel=diamond'],
        confidence: 'high',
      },
      audited: true,
      capabilityStars: 3,
      systemCertifications: ['ISO 9001', 'TUV', 'CE'],
      employees: null,
      turnover: null,
      plantArea: null,
      establishedAt: '2009-02-18',
      address: `Cangzhou, Hebei, China${NOISE}`,
      companyUrl: 'https://example.invalid/mic/haichuan-pipe',
      companyInfoUrl: 'https://example.invalid/mic/haichuan-pipe/info',
    },
    tanji: {
      id: 'tanji_hc_004',
      name: '沧州海川管道装备有限公司',
      uscc: '91SYNTH0000000006F',
      legalRepresentative: '示例法人己',
      regCapital: { value: 20000000, coinType: '人民币', text: '2000.000000万人民币' },
      foundTime: '2009-02-18',
      address: `河北省沧州市示例工业区 6 号${NOISE}`,
      province: HEBEI,
      operStatus: '营业 > 存续(在营、开业、在册)',
      industry: { first: '制造业', second: '金属制品业', third: '结构性金属制品制造', fourth: '金属结构制造' },
      scale: '100-299人',
      tags: ['管道装备', '进出口'],
      businessScope: '管道装备、管件、法兰制造销售；货物或技术进出口。（合成测试数据）',
      homepage: null,
      matchNames: ['沧州海川管道装备有限公司', 'Cangzhou Haichuan Pipe Equipment Co., Ltd.'],
      matchScore: 350,
      contactsUnlocked: true,
      contacts: [
        contact('tjc_hc_001', '示例联系人辛', '外贸部经理', 'mobile', '13800000005', { region: '沧州' }),
        contact('tjc_hc_002', '示例联系人壬', '外贸业务员', 'email', 'contact-c@example.invalid', { region: '沧州', isKeyLead: false }),
      ],
    },
    customsQueryNames: [
      'Cangzhou Haichuan Pipe Equipment Co., Ltd.',
      '沧州海川管道装备有限公司',
    ],
  },
];

export function companyByKey(key: string): SyntheticCompany {
  const c = COMPANIES.find((x) => x.key === key);
  if (!c) throw new Error(`unknown synthetic company key: ${key}`);
  return c;
}

export function bossCompanies(): SyntheticCompany[] {
  return COMPANIES.filter((c) => c.boss);
}

export function zhilianCompanies(): SyntheticCompany[] {
  return COMPANIES.filter((c) => c.zhilian);
}

export function aliCompanies(): SyntheticCompany[] {
  return COMPANIES.filter((c) => c.ali);
}

export function micCompanies(): SyntheticCompany[] {
  return COMPANIES.filter((c) => c.mic);
}

export function tanjiCompanies(): SyntheticCompany[] {
  return COMPANIES.filter((c) => c.tanji);
}

export function findBossCompany(companyId: string): SyntheticCompany | undefined {
  return COMPANIES.find((c) => c.boss?.companyId === companyId);
}

export function findZhilianCompany(companyNumber: string): SyntheticCompany | undefined {
  return COMPANIES.find((c) => c.zhilian?.companyNumber === companyNumber);
}

export function findAliCompany(companyId: string): SyntheticCompany | undefined {
  return COMPANIES.find((c) => c.ali?.companyId === companyId);
}

export function findMicCompany(account: string): SyntheticCompany | undefined {
  return COMPANIES.find((c) => c.mic?.account === account);
}

export function findTanjiById(id: string): SyntheticCompany | undefined {
  return COMPANIES.find((c) => c.tanji?.id === id);
}

/** 跨平台 ID 查询（测试断言用） */
export function findCompanyByPlatformId(platform: 'boss' | 'zhilian' | 'ali' | 'mic', platformId: string): SyntheticCompany | undefined {
  switch (platform) {
    case 'boss':
      return findBossCompany(platformId);
    case 'zhilian':
      return findZhilianCompany(platformId);
    case 'ali':
      return findAliCompany(platformId);
    case 'mic':
      return findMicCompany(platformId);
  }
}

function normName(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, 'AND')
    .replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 英文公司名通用词（不参与弱匹配 token 交集，避免仅靠 HEBEI+LTD 误配到其他公司） */
const NAME_STOPWORDS = new Set([
  'CO', 'LTD', 'LIMITED', 'GROUP', 'CORP', 'CORPORATION', 'COMPANY', 'THE', 'AND',
  'INC', 'LLC', 'GMBH', 'IMPORT', 'EXPORT', 'TRADING', 'INDUSTRIAL', 'INTERNATIONAL',
]);

function nameTokens(normalized: string): string[] {
  return normalized
    .split(' ')
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
}

/**
 * 合成 tanji 名称搜索：field=name 时按 matchNames 精确/包含匹配；
 * field=socialCreditCode 时按 USCC 精确匹配。
 * 返回匹配公司 + 分数（分数仅用于候选排序，非真实上游值）。
 */
export function searchTanji(name: string, field: 'name' | 'socialCreditCode' = 'name'): Array<{ company: SyntheticCompany; score: number }> {
  const q = normName(name);
  if (!q) return [];
  const out: Array<{ company: SyntheticCompany; score: number }> = [];
  for (const c of COMPANIES) {
    const t = c.tanji;
    if (!t) continue;
    if (field === 'socialCreditCode') {
      if (t.uscc.toUpperCase() === q.replace(/\s+/g, '')) out.push({ company: c, score: 500 });
      continue;
    }
    let best = 0;
    for (const n of t.matchNames) {
      const nn = normName(n);
      if (nn === q) best = Math.max(best, t.matchScore + 100);
      else if (q.length >= 4 && (nn.includes(q) || q.includes(nn))) best = Math.max(best, t.matchScore);
      else {
        // token 交集（>=2 个非通用词）视为弱命中；中文名无空格时整体一个 token
        const qTokens = nameTokens(q);
        const nTokens = new Set(nameTokens(nn));
        const common = qTokens.filter((x) => nTokens.has(x));
        if (common.length >= 2) best = Math.max(best, t.matchScore * (0.6 + 0.1 * Math.min(common.length, 3)));
      }
    }
    if (best > 0) out.push({ company: c, score: Math.round(best * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function findTanjiByUscc(uscc: string): SyntheticCompany | undefined {
  const u = uscc.toUpperCase().trim();
  return COMPANIES.find((c) => c.tanji && c.tanji.uscc.toUpperCase() === u);
}
