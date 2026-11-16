/**
 * 合成岗位 fixture（Boss / 智联）。
 *
 * `rounds` 数组表示第 1 次刷新、第 2 次刷新…时上游返回的在招岗位集合，
 * 用于验证岗位生命周期（新增 / 下线 / 重新上线）与 `platform.jobs.updated` 聚合事件：
 *  - round1 → round2 中消失的岗位应被标为 closed（closed_at 正确）；
 *  - round2 中新出现的岗位 first_seen_at 应为第二次刷新时间；
 *  - closed 后再次出现（可选 round3）应恢复 active 并保留 first_seen_at。
 *
 * 所有内容为虚构测试数据（招聘人姓名为示例值，非真实 PII）。
 */

export interface BossJobFixture {
  jobId: string;
  title: string;
  salaryText: string;
  salaryMin?: number;
  salaryMax?: number;
  experience: string;
  degree: string;
  cityName: string;
  district: string;
  businessDistrict: string;
  recruiterName: string;
  recruiterTitle: string;
  jobUrl: string;
}

export interface ZhilianJobFixture {
  positionNumber: string;
  title: string;
  salaryText: string;
  salaryMin: number;
  salaryMax: number;
  education: string;
  experience: string;
  cityName: string;
  district: string;
  publishTime: string;
  recruiterName: string;
  jobUrl: string;
}

/** companyKey → 每轮刷新返回的岗位列表（index 0 = round1） */
export const BOSS_JOB_ROUNDS: Record<string, BossJobFixture[][]> = {
  chenxing: [
    [
      {
        jobId: 'bossjob_cx_001',
        title: '外贸业务员',
        salaryText: '6-10K',
        experience: '1-3年',
        degree: '大专',
        cityName: '石家庄',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者甲',
        recruiterTitle: 'HR',
        jobUrl: 'https://example.invalid/boss/job/bossjob_cx_001',
      },
      {
        jobId: 'bossjob_cx_002',
        title: '外贸经理',
        salaryText: '10-15K',
        experience: '3-5年',
        degree: '本科',
        cityName: '石家庄',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者甲',
        recruiterTitle: 'HR',
        jobUrl: 'https://example.invalid/boss/job/bossjob_cx_002',
      },
      {
        jobId: 'bossjob_cx_003',
        title: '单证员',
        salaryText: '5-8K',
        experience: '1-3年',
        degree: '大专',
        cityName: '石家庄',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者乙',
        recruiterTitle: '招聘主管',
        jobUrl: 'https://example.invalid/boss/job/bossjob_cx_003',
      },
    ],
    // 第二次刷新：001 仍在招，002 下线，004 新增
    [
      {
        jobId: 'bossjob_cx_001',
        title: '外贸业务员',
        salaryText: '6-10K',
        experience: '1-3年',
        degree: '大专',
        cityName: '石家庄',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者甲',
        recruiterTitle: 'HR',
        jobUrl: 'https://example.invalid/boss/job/bossjob_cx_001',
      },
      {
        jobId: 'bossjob_cx_004',
        title: '跨境电商运营',
        salaryText: '8-12K',
        experience: '1-3年',
        degree: '本科',
        cityName: '石家庄',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者乙',
        recruiterTitle: '招聘主管',
        jobUrl: 'https://example.invalid/boss/job/bossjob_cx_004',
      },
    ],
  ],
  lanjing: [
    [
      {
        jobId: 'bossjob_lj_001',
        title: '海外销售工程师',
        salaryText: '8-13K',
        experience: '3-5年',
        degree: '本科',
        cityName: '唐山',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者丙',
        recruiterTitle: 'HR',
        jobUrl: 'https://example.invalid/boss/job/bossjob_lj_001',
      },
      {
        jobId: 'bossjob_lj_002',
        title: '外贸跟单员',
        salaryText: '5-7K',
        experience: '1-3年',
        degree: '大专',
        cityName: '唐山',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者丙',
        recruiterTitle: 'HR',
        jobUrl: 'https://example.invalid/boss/job/bossjob_lj_002',
      },
    ],
    // 第二次刷新：无变化（用于验证不产生 job 聚合事件 / 不重复 first_seen_at）
    [
      {
        jobId: 'bossjob_lj_001',
        title: '海外销售工程师',
        salaryText: '8-13K',
        experience: '3-5年',
        degree: '本科',
        cityName: '唐山',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者丙',
        recruiterTitle: 'HR',
        jobUrl: 'https://example.invalid/boss/job/bossjob_lj_001',
      },
      {
        jobId: 'bossjob_lj_002',
        title: '外贸跟单员',
        salaryText: '5-7K',
        experience: '1-3年',
        degree: '大专',
        cityName: '唐山',
        district: '示例区',
        businessDistrict: '示例商圈',
        recruiterName: '示例招聘者丙',
        recruiterTitle: 'HR',
        jobUrl: 'https://example.invalid/boss/job/bossjob_lj_002',
      },
    ],
  ],
};

export const ZHILIAN_JOB_ROUNDS: Record<string, ZhilianJobFixture[][]> = {
  yunfan: [
    [
      {
        positionNumber: 'ZLJOB_yf_001',
        title: '外贸业务员',
        salaryText: '5000-10000元',
        salaryMin: 5000,
        salaryMax: 10000,
        education: '大专',
        experience: '1-3年',
        cityName: '唐山',
        district: '示例区',
        publishTime: '2026-10-20T09:00:00+08:00',
        recruiterName: '示例招聘者丁',
        jobUrl: 'https://example.invalid/zhilian/job/ZLJOB_yf_001',
      },
      {
        positionNumber: 'ZLJOB_yf_002',
        title: '跨境电商专员',
        salaryText: '6000-9000元',
        salaryMin: 6000,
        salaryMax: 9000,
        education: '本科',
        experience: '1-3年',
        cityName: '唐山',
        district: '示例区',
        publishTime: '2026-10-22T09:00:00+08:00',
        recruiterName: '示例招聘者丁',
        jobUrl: 'https://example.invalid/zhilian/job/ZLJOB_yf_002',
      },
    ],
    // 第二次刷新：001 下线，002 保留，003 新增
    [
      {
        positionNumber: 'ZLJOB_yf_002',
        title: '跨境电商专员',
        salaryText: '6000-9000元',
        salaryMin: 6000,
        salaryMax: 9000,
        education: '本科',
        experience: '1-3年',
        cityName: '唐山',
        district: '示例区',
        publishTime: '2026-10-22T09:00:00+08:00',
        recruiterName: '示例招聘者丁',
        jobUrl: 'https://example.invalid/zhilian/job/ZLJOB_yf_002',
      },
      {
        positionNumber: 'ZLJOB_yf_003',
        title: '外贸单证员',
        salaryText: '4500-7000元',
        salaryMin: 4500,
        salaryMax: 7000,
        education: '大专',
        experience: '经验不限',
        cityName: '唐山',
        district: '示例区',
        publishTime: '2026-11-15T09:00:00+08:00',
        recruiterName: '示例招聘者戊',
        jobUrl: 'https://example.invalid/zhilian/job/ZLJOB_yf_003',
      },
    ],
  ],
};

/** 取第 round 轮（1-based）的岗位集合；越界时回退到最后一轮。 */
export function bossJobsFor(companyKey: string, round: number): BossJobFixture[] {
  const rounds = BOSS_JOB_ROUNDS[companyKey];
  if (!rounds || rounds.length === 0) return [];
  const idx = Math.min(Math.max(round, 1) - 1, rounds.length - 1);
  return rounds[idx] ?? [];
}

export function zhilianJobsFor(companyKey: string, round: number): ZhilianJobFixture[] {
  const rounds = ZHILIAN_JOB_ROUNDS[companyKey];
  if (!rounds || rounds.length === 0) return [];
  const idx = Math.min(Math.max(round, 1) - 1, rounds.length - 1);
  return rounds[idx] ?? [];
}
