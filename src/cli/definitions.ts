/**
 * CLI 命令清单（元数据）—— `lead --help`、scripts/gen.ts → spec/cli-commands.json 同源。
 * 实际执行在 src/cli/commands.ts；所有命令最终映射到 REST。
 */

export interface CliOptionMeta {
  flags: string;
  description: string;
  default?: string | boolean | number;
  choices?: string[];
  /** 是否必填（commander 用 --flag <v> 时由实现校验） */
  required?: boolean;
}

export interface CliArgMeta {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

export interface CliCommandMeta {
  /** 命令路径，如 "goal list" */
  path: string;
  description: string;
  usage?: string;
  group: string;
  args?: CliArgMeta[];
  options?: CliOptionMeta[];
  /** 对应 REST（无 = 本地/流式处理） */
  rest?: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string };
}

const jsonOpt: CliOptionMeta = { flags: '--json', description: '输出与 REST data 一致的 JSON' };

export const CLI_COMMANDS: CliCommandMeta[] = [
  /* ---------------------------- runtime ---------------------------- */
  {
    path: 'status',
    group: 'runtime',
    description: '服务运行态总览（版本/DB/队列/上游/额度/告警）',
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/status' },
  },
  {
    path: 'quota',
    group: 'runtime',
    description: '探迹额度（日/月/企业月 + 结算日 + 近 7 天解锁）',
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/quota' },
  },
  {
    path: 'sources',
    group: 'runtime',
    description: '五个上游健康/登录态/限频/最近错误',
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/sources' },
  },
  {
    path: 'stats',
    group: 'runtime',
    description: '采集/补全/解锁/事件统计；--kind coverage 返回覆盖度',
    options: [
      { flags: '--kind <kind>', description: 'summary|coverage|unlocks', default: 'summary', choices: ['summary', 'coverage', 'unlocks'] },
      { flags: '--from <iso>', description: '起始时间（ISO 8601）' },
      { flags: '--to <iso>', description: '结束时间（ISO 8601）' },
      { flags: '--run-id <id>', description: '限定 Run' },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/stats' },
  },

  /* ----------------------------- goal ------------------------------ */
  {
    path: 'goal list',
    group: 'goal',
    description: 'Goal 列表',
    options: [
      { flags: '--enabled', description: '只看启用的' },
      { flags: '--disabled', description: '只看停用的' },
      { flags: '--limit <n>', description: '条数', default: 50 },
      { flags: '--offset <n>', description: '偏移', default: 0 },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/goals' },
  },
  {
    path: 'goal show <id>',
    group: 'goal',
    description: 'Goal 详情（含 resolvedCities / 最近 runs）',
    args: [{ name: 'id', description: 'Goal ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/goals/:id' },
  },
  {
    path: 'goal create',
    group: 'goal',
    description: '创建 Goal（区域 + 平台 + 关键词 + 上限 + cron）',
    options: [
      { flags: '--name <name>', description: 'Goal 名称', required: true },
      { flags: '--province <province>', description: '省名或 GB code，如 河北省', default: '河北省' },
      { flags: '--city-codes <csv>', description: '地级市 GB code 子集（逗号分隔；缺省=全省）' },
      { flags: '--platforms <csv>', description: 'boss,zhilian,ali,mic', default: 'boss,zhilian,ali,mic' },
      { flags: '--keywords-boss <csv>', description: 'Boss 关键词（逗号分隔）' },
      { flags: '--keywords-zhilian <csv>', description: '智联关键词（逗号分隔）' },
      { flags: '--keywords-ali <csv>', description: 'Ali 行业关键词（逗号分隔）' },
      { flags: '--max-leads <n>', description: '单轮线索上限' },
      { flags: '--daily-limit <n>', description: '每日线索上限' },
      { flags: '--cron <cron>', description: '5 段 cron', default: '0 2 * * *' },
      { flags: '--priority <n>', description: '优先级', default: 100 },
      { flags: '--disabled', description: '创建后停用' },
      jsonOpt,
    ],
    rest: { method: 'POST', path: '/v1/goals' },
  },
  {
    path: 'goal update <id>',
    group: 'goal',
    description: '更新 Goal（--enable/--disable/--cron/--platforms/--version 等）',
    args: [{ name: 'id', description: 'Goal ID', required: true }],
    options: [
      { flags: '--name <name>', description: '新名称' },
      { flags: '--enable', description: '启用' },
      { flags: '--disable', description: '停用' },
      { flags: '--cron <cron>', description: '新 cron' },
      { flags: '--platforms <csv>', description: '平台子集（逗号分隔）' },
      { flags: '--keywords-boss <csv>', description: 'Boss 关键词（逗号分隔）' },
      { flags: '--keywords-zhilian <csv>', description: '智联关键词（逗号分隔）' },
      { flags: '--keywords-ali <csv>', description: 'Ali 行业关键词（逗号分隔）' },
      { flags: '--max-leads <n>', description: '单轮线索上限' },
      { flags: '--priority <n>', description: '优先级' },
      { flags: '--version <n>', description: '乐观锁 expectedVersion' },
      jsonOpt,
    ],
    rest: { method: 'PATCH', path: '/v1/goals/:id' },
  },
  {
    path: 'goal run <id>',
    group: 'goal',
    description: '手动触发 Run（--wait 跟随进度）',
    args: [{ name: 'id', description: 'Goal ID', required: true }],
    options: [
      { flags: '--wait', description: '轮询跟随直到结束' },
      { flags: '--interval <sec>', description: '--wait 轮询间隔', default: 5 },
      jsonOpt,
    ],
    rest: { method: 'POST', path: '/v1/goals/:id/run' },
  },
  {
    path: 'goal runs <id>',
    group: 'goal',
    description: 'Goal 的运行历史',
    args: [{ name: 'id', description: 'Goal ID', required: true }],
    options: [{ flags: '--limit <n>', description: '条数', default: 50 }, { flags: '--offset <n>', description: '偏移', default: 0 }, jsonOpt],
    rest: { method: 'GET', path: '/v1/goals/:id/runs' },
  },

  /* ------------------------------ run ------------------------------ */
  {
    path: 'run list',
    group: 'run',
    description: 'Run 列表',
    options: [
      { flags: '--goal <id>', description: '按 Goal 过滤' },
      { flags: '--status <status>', description: 'pending|running|completed|partial|failed|cancelled' },
      { flags: '--limit <n>', description: '条数', default: 50 },
      { flags: '--offset <n>', description: '偏移', default: 0 },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/runs' },
  },
  {
    path: 'run show <id>',
    group: 'run',
    description: 'Run 详情（平台/城市/关键词进度）',
    args: [{ name: 'id', description: 'Run ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/runs/:id' },
  },
  {
    path: 'run cancel <id>',
    group: 'run',
    description: '取消运行中的 Run',
    args: [{ name: 'id', description: 'Run ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'POST', path: '/v1/runs/:id/cancel' },
  },

  /* ---------------------------- company ---------------------------- */
  {
    path: 'company list',
    group: 'company',
    description: '公司列表（区域/平台/状态/关键词过滤，游标分页）',
    options: [
      { flags: '--province <province>', description: '省' },
      { flags: '--city <city>', description: '市' },
      { flags: '--platform <platform>', description: 'boss|zhilian|ali|mic' },
      { flags: '--unlock-status <status>', description: 'none|pending|waiting_quota|unlocked|failed' },
      { flags: '--enrichment-status <status>', description: 'discovered|source_detailed|tanji_matched|tanji_enriched|unmatched|failed' },
      { flags: '--q <keyword>', description: '公司名关键词（≥2 字符）' },
      { flags: '--updated-since <iso>', description: '增量时间' },
      { flags: '--limit <n>', description: '条数', default: 20 },
      { flags: '--cursor <cursor>', description: '游标' },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/companies' },
  },
  {
    path: 'company show <id>',
    group: 'company',
    description: '公司详情（主档+来源+联系人+最近变更）',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [
      { flags: '--include <csv>', description: 'platforms,customs,contacts,sources,changes' },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/companies/:id' },
  },
  {
    path: 'company sources <id>',
    group: 'company',
    description: '公司来源证据',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/companies/:id/sources' },
  },
  {
    path: 'company contacts <id>',
    group: 'company',
    description: '公司联系人（明文）',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [
      { flags: '--type <type>', description: 'mobile|phone|email' },
      { flags: '--unlocked-only', description: '仅已解锁' },
      { flags: '--limit <n>', description: '条数', default: 200 },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/companies/:id/contacts' },
  },
  {
    path: 'company changes <id>',
    group: 'company',
    description: '公司字段级变更历史',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [
      { flags: '--since-version <n>', description: '从该版本之后' },
      { flags: '--limit <n>', description: '条数', default: 100 },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/companies/:id/changes' },
  },
  {
    path: 'company snapshots <id>',
    group: 'company',
    description: '公司原始快照元数据列表',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [
      { flags: '--kind <kind>', description: '快照类型' },
      { flags: '--platform <platform>', description: '平台' },
      { flags: '--limit <n>', description: '条数', default: 20 },
      { flags: '--cursor <cursor>', description: '游标' },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/companies/:id/snapshots' },
  },
  {
    path: 'company platforms <id>',
    group: 'company',
    description: '各平台最新档案卡片',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/companies/:id/platforms' },
  },
  {
    path: 'company platform <id> <platform>',
    group: 'company',
    description: '单平台完整档案',
    args: [
      { name: 'id', description: 'Company ID', required: true },
      { name: 'platform', description: 'boss|zhilian|ali|mic', required: true },
    ],
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/companies/:id/platforms/:platform' },
  },
  {
    path: 'company jobs <id> <platform>',
    group: 'company',
    description: 'Boss/智联岗位列表（active/closed 历史）',
    args: [
      { name: 'id', description: 'Company ID', required: true },
      { name: 'platform', description: 'boss|zhilian', required: true },
    ],
    options: [
      { flags: '--status <status>', description: 'active|closed', default: 'active' },
      { flags: '--limit <n>', description: '条数', default: 50 },
      { flags: '--cursor <cursor>', description: '游标' },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/companies/:id/platforms/:platform/jobs' },
  },
  {
    path: 'company platform-changes <id> <platform>',
    group: 'company',
    description: '平台档案变更历史',
    args: [
      { name: 'id', description: 'Company ID', required: true },
      { name: 'platform', description: 'boss|zhilian|ali|mic', required: true },
    ],
    options: [
      { flags: '--since-version <n>', description: '从该版本之后' },
      { flags: '--limit <n>', description: '条数', default: 100 },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/companies/:id/platforms/:platform/changes' },
  },
  {
    path: 'company refresh <id>',
    group: 'company',
    description: '手动刷新平台档案/岗位（202 + job）',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [
      { flags: '--platforms <csv>', description: '平台子集，逗号分隔' },
      { flags: '--kinds <csv>', description: 'profile,jobs,store,customs' },
      jsonOpt,
    ],
    rest: { method: 'POST', path: '/v1/companies/:id/refresh' },
  },
  {
    path: 'company customs <id>',
    group: 'company',
    description: '海关画像（Ali/Mic）',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/companies/:id/customs' },
  },
  {
    path: 'company customs-refresh <id>',
    group: 'company',
    description: '手动刷新海关画像（202 + job）',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'POST', path: '/v1/companies/:id/customs/refresh' },
  },
  {
    path: 'company rematch <id>',
    group: 'company',
    description: '重新匹配探迹主体（202 + job）',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [{ flags: '--force', description: '强制重匹配' }, jsonOpt],
    rest: { method: 'POST', path: '/v1/companies/:id/rematch' },
  },
  {
    path: 'company unlock <id>',
    group: 'company',
    description: '手动优先解锁（202 + job；消耗探迹额度）',
    args: [{ name: 'id', description: 'Company ID', required: true }],
    options: [
      { flags: '--idempotency-key <key>', description: '幂等键（缺省 <companyId>:<yyyy-mm-dd>）' },
      jsonOpt,
    ],
    rest: { method: 'POST', path: '/v1/companies/:id/unlock' },
  },

  /* ------------------------ changes / events ----------------------- */
  {
    path: 'changes',
    group: 'changes',
    description: '全局增量变更（sinceSeq 游标）',
    options: [
      { flags: '--since-seq <n>', description: '从该 seq 之后', default: 0 },
      { flags: '--types <csv>', description: '事件类型过滤（逗号分隔）' },
      { flags: '--company <id>', description: '按公司过滤' },
      { flags: '--limit <n>', description: '条数', default: 100 },
      { flags: '--cursor <cursor>', description: '游标' },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/changes' },
  },
  {
    path: 'events tail',
    group: 'events',
    description: '跟随 SSE 事件流（Ctrl-C 退出）',
    options: [
      { flags: '--types <csv>', description: '事件类型过滤' },
      { flags: '--since-seq <n>', description: '从该 seq 之后' },
      { flags: '--company <id>', description: '按公司过滤' },
      { flags: '--timeout <sec>', description: '运行窗口秒数（0=不超时）', default: 0 },
      jsonOpt,
    ],
  },

  /* ---------------------------- webhook ---------------------------- */
  {
    path: 'webhook list',
    group: 'webhook',
    description: 'Webhook 订阅列表',
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/webhooks' },
  },
  {
    path: 'webhook create',
    group: 'webhook',
    description: '创建 Webhook 订阅',
    options: [
      { flags: '--url <url>', description: '回调 URL', required: true },
      { flags: '--events <csv>', description: '事件类型（逗号分隔）', required: true },
      { flags: '--secret <secret>', description: '签名密钥（缺省随机生成）' },
      { flags: '--description <text>', description: '说明' },
      jsonOpt,
    ],
    rest: { method: 'POST', path: '/v1/webhooks' },
  },
  {
    path: 'webhook update <id>',
    group: 'webhook',
    description: '更新订阅（url/events/active）',
    args: [{ name: 'id', description: '订阅 ID', required: true }],
    options: [
      { flags: '--url <url>', description: '新回调 URL' },
      { flags: '--events <csv>', description: '新事件类型' },
      { flags: '--enable', description: '启用' },
      { flags: '--disable', description: '停用' },
      jsonOpt,
    ],
    rest: { method: 'PATCH', path: '/v1/webhooks/:id' },
  },
  {
    path: 'webhook delete <id>',
    group: 'webhook',
    description: '删除订阅',
    args: [{ name: 'id', description: '订阅 ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'DELETE', path: '/v1/webhooks/:id' },
  },
  {
    path: 'webhook deliveries <id>',
    group: 'webhook',
    description: '投递记录（--status dead 查死信）',
    args: [{ name: 'id', description: '订阅 ID', required: true }],
    options: [
      { flags: '--status <status>', description: 'pending|delivered|failed|dead' },
      { flags: '--limit <n>', description: '条数', default: 50 },
      { flags: '--cursor <cursor>', description: '游标' },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/webhooks/:id/deliveries' },
  },
  {
    path: 'webhook replay <id> <deliveryId>',
    group: 'webhook',
    description: '重放一条投递',
    args: [
      { name: 'id', description: '订阅 ID', required: true },
      { name: 'deliveryId', description: '投递 ID', required: true },
    ],
    options: [jsonOpt],
    rest: { method: 'POST', path: '/v1/webhooks/:id/deliveries/:deliveryId/replay' },
  },

  /* ------------------------------ job ------------------------------ */
  {
    path: 'job list',
    group: 'job',
    description: '流水线任务列表（死信可查）',
    options: [
      { flags: '--status <status>', description: 'pending|running|waiting_quota|done|failed|dead|cancelled' },
      { flags: '--stage <stage>', description: 'source_detail|tanji_match|tanji_detail|unlock|platform_profile|platform_jobs|customs' },
      { flags: '--company <id>', description: '按公司过滤' },
      { flags: '--limit <n>', description: '条数', default: 50 },
      { flags: '--cursor <cursor>', description: '游标' },
      jsonOpt,
    ],
    rest: { method: 'GET', path: '/v1/jobs' },
  },
  {
    path: 'job show <id>',
    group: 'job',
    description: '任务详情（attempts/lastError/lease）',
    args: [{ name: 'id', description: '任务 ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/jobs/:id' },
  },
  {
    path: 'job retry <id>',
    group: 'job',
    description: '重试失败/死信任务',
    args: [{ name: 'id', description: '任务 ID', required: true }],
    options: [jsonOpt],
    rest: { method: 'POST', path: '/v1/jobs/:id/retry' },
  },

  /* ----------------------------- admin ----------------------------- */
  {
    path: 'admin backup',
    group: 'admin',
    description: 'SQLite 在线备份到数据目录 backups/',
    options: [jsonOpt],
    rest: { method: 'POST', path: '/v1/admin/backup' },
  },
  {
    path: 'admin archive',
    group: 'admin',
    description: '原始快照冷归档（brotli + manifest；只归档不删除）',
    options: [
      { flags: '--after-days <n>', description: '归档阈值天数（缺省配置 90）' },
      { flags: '--dry-run', description: '只统计不写文件' },
      jsonOpt,
    ],
    rest: { method: 'POST', path: '/v1/admin/archive' },
  },
  {
    path: 'admin manifests',
    group: 'admin',
    description: '归档清单列表（按月份）',
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/admin/archive/manifests' },
  },
  {
    path: 'admin verify',
    group: 'admin',
    description: '校验归档文件 sha256',
    options: [{ flags: '--month <yyyy-mm>', description: '只校验某月' }, jsonOpt],
    rest: { method: 'GET', path: '/v1/admin/verify' },
  },
  {
    path: 'admin restore',
    group: 'admin',
    description: '按月份恢复归档元数据/文件到 hot 库（幂等）',
    options: [
      { flags: '--month <yyyy-mm>', description: '恢复某月（缺省全部）' },
      { flags: '--dry-run', description: '只统计不写库' },
      jsonOpt,
    ],
    rest: { method: 'POST', path: '/v1/admin/restore' },
  },
  {
    path: 'admin db-stats',
    group: 'admin',
    description: 'DB 体积/表行数/归档与备份统计',
    options: [jsonOpt],
    rest: { method: 'GET', path: '/v1/admin/db-stats' },
  },
];

export const CLI_COMMANDS_BY_PATH: Record<string, CliCommandMeta> = Object.fromEntries(
  CLI_COMMANDS.map((c) => [c.path, c]),
);
