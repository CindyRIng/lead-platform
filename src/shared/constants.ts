/** 全局常量/枚举（冻结） */
import type { Platform, Stage, JobStatus, EventType } from './domain.js';

export const PLATFORMS: Platform[] = ['boss', 'zhilian', 'ali', 'mic'];
export const SOURCE_LABELS: Record<Platform, string> = {
  boss: 'Boss直聘',
  zhilian: '智联招聘',
  ali: '阿里巴巴国际站',
  mic: '中国制造网',
};

export const STAGES: Stage[] = [
  'source_detail',
  'tanji_match',
  'tanji_detail',
  'unlock',
  'contact_sync',
  'platform_profile',
  'platform_jobs',
  'customs',
];
export const JOB_STATUSES: JobStatus[] = ['pending', 'running', 'waiting_quota', 'done', 'failed', 'dead', 'cancelled'];
export const EVENT_TYPES: EventType[] = [
  'company.created',
  'company.updated',
  'contact.unlocked',
  'company.merged',
  'company.rematched',
  'platform.profile.updated',
  'platform.jobs.updated',
  'customs.updated',
];

export const DEFAULT_KEYWORDS: Record<Platform, string[]> = {
  boss: ['外贸', '外贸业务员', '外贸经理', '外贸单证员', '国际贸易', '跨境电商', '外贸跟单', '外贸专员', '海外销售', '国际业务'],
  zhilian: ['外贸', '外贸业务员', '外贸经理', '外贸单证员', '国际贸易', '跨境电商', '外贸跟单', '外贸专员', '海外销售', '国际业务'],
  ali: ['machinery', 'hardware', 'auto parts', 'pipe fitting', 'glass', 'bicycle', 'furniture'],
  mic: [],
};

export const DEFAULT_UNLOCK_POLICY = {
  mode: 'priority' as const,
  order: ['recruiting', 'paid_member', 'customs', 'rest'],
};

export const HEBEI_PROVINCE = { name: '河北省', code: '130000' };
export const HEBEI_CITIES: Array<{ name: string; code: string }> = [
  { name: '石家庄市', code: '130100' },
  { name: '唐山市', code: '130200' },
  { name: '秦皇岛市', code: '130300' },
  { name: '邯郸市', code: '130400' },
  { name: '邢台市', code: '130500' },
  { name: '保定市', code: '130600' },
  { name: '张家口市', code: '130700' },
  { name: '承德市', code: '130800' },
  { name: '沧州市', code: '130900' },
  { name: '廊坊市', code: '131000' },
  { name: '衡水市', code: '131100' },
];
