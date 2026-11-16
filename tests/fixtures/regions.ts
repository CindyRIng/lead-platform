/**
 * 合成区域 fixture —— 河北省 11 个地级市 + 四平台映射值。
 *
 * 映射值来自 docs/04 第 4.2 节（实测值），是区域注册表 / mock 上游共用的测试基线。
 * 本文件不含任何真实企业/PII 数据。
 */

export interface HebeiCityFixture {
  /** GB/T 2260 市级代码 */
  code: string;
  /** 规范名（带「市」） */
  name: string;
  /** 短名（不带「市」），Boss/智联城市名常用 */
  shortName: string;
  /** Boss cityCode */
  bossCityCode: string;
  /** 智联 code */
  zhilianCode: string;
  /** Ali code */
  aliCode: string;
  /** Ali nameEn */
  aliNameEn: string;
  /** Mic api_value（英文名，大小写不敏感） */
  micName: string;
}

export const HEBEI_PROVINCE = {
  code: '130000',
  name: '河北省',
  shortName: '河北',
  aliCode: 'CN-13',
  aliNameEn: 'Hebei',
  micValue: 'Hebei',
} as const;

export const HEBEI_CITIES: HebeiCityFixture[] = [
  { code: '130100', name: '石家庄市', shortName: '石家庄', bossCityCode: '101090100', zhilianCode: '565', aliCode: 'CN-13-1301', aliNameEn: 'Shijiazhuang', micName: 'Shijiazhuang' },
  { code: '130200', name: '唐山市', shortName: '唐山', bossCityCode: '101090500', zhilianCode: '566', aliCode: 'CN-13-1302', aliNameEn: 'Tangshan', micName: 'Tangshan' },
  { code: '130300', name: '秦皇岛市', shortName: '秦皇岛', bossCityCode: '101091100', zhilianCode: '567', aliCode: 'CN-13-1303', aliNameEn: 'Qinhuangdao', micName: 'Qinhuangdao' },
  { code: '130400', name: '邯郸市', shortName: '邯郸', bossCityCode: '101091000', zhilianCode: '568', aliCode: 'CN-13-1304', aliNameEn: 'Handan', micName: 'Handan' },
  { code: '130500', name: '邢台市', shortName: '邢台', bossCityCode: '101090900', zhilianCode: '569', aliCode: 'CN-13-1305', aliNameEn: 'Xingtai', micName: 'Xingtai' },
  { code: '130600', name: '保定市', shortName: '保定', bossCityCode: '101090200', zhilianCode: '570', aliCode: 'CN-13-1306', aliNameEn: 'Baoding', micName: 'Baoding' },
  { code: '130700', name: '张家口市', shortName: '张家口', bossCityCode: '101090300', zhilianCode: '571', aliCode: 'CN-13-1307', aliNameEn: 'Zhangjiakou', micName: 'Zhangjiakou' },
  { code: '130800', name: '承德市', shortName: '承德', bossCityCode: '101090400', zhilianCode: '572', aliCode: 'CN-13-1308', aliNameEn: 'Chengde', micName: 'Chengde' },
  { code: '130900', name: '沧州市', shortName: '沧州', bossCityCode: '101090700', zhilianCode: '573', aliCode: 'CN-13-1309', aliNameEn: 'Cangzhou', micName: 'Cangzhou' },
  { code: '131000', name: '廊坊市', shortName: '廊坊', bossCityCode: '101090600', zhilianCode: '574', aliCode: 'CN-13-1310', aliNameEn: 'Langfang', micName: 'Langfang' },
  { code: '131100', name: '衡水市', shortName: '衡水', bossCityCode: '101090800', zhilianCode: '575', aliCode: 'CN-13-1311', aliNameEn: 'Hengshui', micName: 'Hengshui' },
];

export function cityByCode(code: string): HebeiCityFixture | undefined {
  return HEBEI_CITIES.find((c) => c.code === code);
}

export function cityByBossCode(bossCityCode: string): HebeiCityFixture | undefined {
  return HEBEI_CITIES.find((c) => c.bossCityCode === bossCityCode);
}

export function cityByZhilianCode(zhilianCode: string): HebeiCityFixture | undefined {
  return HEBEI_CITIES.find((c) => c.zhilianCode === zhilianCode);
}

export function cityByAliCode(aliCode: string): HebeiCityFixture | undefined {
  return HEBEI_CITIES.find((c) => c.aliCode === aliCode);
}

export function cityByMicName(micName: string): HebeiCityFixture | undefined {
  const v = micName.toLowerCase();
  return HEBEI_CITIES.find((c) => c.micName.toLowerCase() === v || c.aliNameEn.toLowerCase() === v);
}
