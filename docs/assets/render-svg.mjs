#!/usr/bin/env node
/**
 * LeadPlatform 文档示意图渲染器（自包含 SVG + PNG）
 * - 输入：本脚本内的手工排版定义（可控、紧凑，适合 README/文档）
 * - 输出：docs/assets/*.svg 与 2x PNG（Chrome headless 截屏，白底）
 * - 语义源：同目录 *.mmd（GitHub 可直接渲染的 Mermaid 源，供在线维护）
 * 用法：node docs/assets/render-svg.mjs [name ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ASSETS = path.dirname(new URL(import.meta.url).pathname);
const TMP = '/tmp/docgen/svg';
fs.mkdirSync(TMP, { recursive: true });
const CHROME = 'google-chrome';

const FONT = "'Noto Sans CJK SC','Noto Sans CJK','Source Han Sans SC',sans-serif";
const K = {
  up: { fill: '#eef3fb', stroke: '#5b7fb4' },
  core: { fill: '#eaf6ef', stroke: '#3f8f63' },
  store: { fill: '#fdf3e3', stroke: '#b8832f' },
  io: { fill: '#f3ecfa', stroke: '#7b5ea7' },
  down: { fill: '#fbeceb', stroke: '#b45b52' },
  warn: { fill: '#fff4e0', stroke: '#c08a2e' },
  bad: { fill: '#fbeceb', stroke: '#b45b52' },
  ok: { fill: '#eaf6ef', stroke: '#3f8f63' },
  flat: { fill: '#ffffff', stroke: '#9fb0c6' },
  cfg: { fill: '#f3ecfa', stroke: '#7b5ea7' },
  step: { fill: '#eef3fb', stroke: '#5b7fb4' },
  out: { fill: '#fbeceb', stroke: '#b45b52' },
  st: { fill: '#eef3fb', stroke: '#5b7fb4' },
};
const TXT = '#16324f';
const LINE = '#5a6b82';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function textLines(cx, cy, title, sub, opts = {}) {
  const t = opts.titleSize || 15.5;
  const s = opts.subSize || 12.5;
  const lh = s + 5;
  const blockH = t + 6 + sub.length * lh;
  let y = cy - blockH / 2 + t;
  let out = `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${t}" font-weight="700" fill="${TXT}">${esc(title)}</text>`;
  y += 6 + s;
  for (const line of sub) {
    out += `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${s}" fill="${TXT}" opacity="0.82">${esc(line)}</text>`;
    y += lh;
  }
  return out;
}

function box(x, y, w, h, title, sub = [], kind = 'core', opts = {}) {
  const c = K[kind] || K.core;
  const r = opts.r ?? 10;
  const dash = opts.dash ? ' stroke-dasharray="7 5"' : '';
  const sw = opts.sw ?? 1.6;
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="${sw}"${dash}/>`;
  out += textLines(x + w / 2, y + h / 2, title, sub, opts);
  return out;
}

function group(x, y, w, h, label, opts = {}) {
  const dash = opts.dash === false ? '' : ' stroke-dasharray="8 6"';
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${opts.fill || '#fbfcfe'}" stroke="${opts.stroke || '#b9c6d8'}" stroke-width="1.4"${dash}/>`;
  out += `<text x="${x + 14}" y="${y + 22}" font-family="${FONT}" font-size="13.5" font-weight="700" fill="${opts.labelColor || '#5a6b82'}">${esc(label)}</text>`;
  return out;
}

function arrow(x1, y1, x2, y2, opts = {}) {
  const dash = opts.dash ? ' stroke-dasharray="7 5"' : '';
  const color = opts.color || LINE;
  let out = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${opts.sw || 1.7}"${dash} marker-end="url(#ah)"/>`;
  out += label((x1 + x2) / 2, (y1 + y2) / 2, opts.label);
  return out;
}

function poly(points, opts = {}) {
  const p = points.map(([x, y]) => `${x},${y}`).join(' ');
  const dash = opts.dash ? ' stroke-dasharray="7 5"' : '';
  let out = `<polyline points="${p}" fill="none" stroke="${opts.color || LINE}" stroke-width="${opts.sw || 1.7}"${dash} marker-end="url(#ah)"/>`;
  if (opts.label) {
    const mid = points[Math.floor(points.length / 2)];
    out += label(mid[0], mid[1], opts.label, opts.labelDx, opts.labelDy);
  }
  return out;
}

function label(cx, cy, text, dx = 0, dy = -8) {
  if (!text) return '';
  const w = text.length * 12.3 + 16;
  return `<g><rect x="${cx + dx - w / 2}" y="${cy + dy - 13}" width="${w}" height="20" rx="5" fill="#ffffff" opacity="0.94"/><text x="${cx + dx}" y="${cy + dy + 2}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#3c5470">${esc(text)}</text></g>`;
}

function title(t, sub) {
  let out = `<text x="42" y="40" font-family="${FONT}" font-size="23" font-weight="800" fill="${TXT}">${esc(t)}</text>`;
  if (sub) out += `<text x="42" y="63" font-family="${FONT}" font-size="13" fill="#5a6b82">${esc(sub)}</text>`;
  return out;
}

function legend(x, y, items) {
  let out = '';
  items.forEach((it, i) => {
    const bx = x + i * 196;
    out += `<rect x="${bx}" y="${y}" width="16" height="16" rx="4" fill="${K[it[0]].fill}" stroke="${K[it[0]].stroke}"/>`;
    out += `<text x="${bx + 24}" y="${y + 13}" font-family="${FONT}" font-size="12.5" fill="#4b5f78">${esc(it[1])}</text>`;
  });
  return out;
}

function svgDoc(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
  <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="${LINE}"/>
  </marker>
  <marker id="ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#5b7fb4"/>
  </marker>
</defs>
<rect width="100%" height="100%" fill="#ffffff"/>
${body}
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* 1. 架构总览                                                         */
/* ------------------------------------------------------------------ */
function architecture() {
  const W = 1640, H = 1120;
  let b = title('LeadPlatform 架构总览', '单机常驻 · 上游只读编排 · SQLite 唯一事实源 · REST / CLI / MCP / Webhook / SSE');
  b += legend(58, 1006, [['up', '上游客户端'], ['core', '核心编排 / Worker'], ['store', '存储与归档'], ['io', '对外入口 / 事件'], ['down', '下游消费者']]);

  // 上游
  const ups = [
    ['boss-client :8790', 'Boss 直聘 · 招聘线索'],
    ['zhilian-client :8791', '智联招聘 · 招聘线索'],
    ['ali-client :8792', '阿里国际站 · 供应商'],
    ['mic-client :8899', '中国制造网 · 工厂'],
    ['tanji-client :8787', '探迹 · 匹配 / 工商 / 解锁'],
    ['fuma-platform :17890', '海关提单 · 只读'],
  ];
  b += group(40, 118, 1560, 104, '① 上游：本机 REST 客户端（loopback，登录态/浏览器由各 client 持有）');
  const uw = 238, ug = 22, ux0 = 58, uy = 146;
  ups.forEach((u, i) => {
    b += box(ux0 + i * (uw + ug), uy, uw, 60, u[0], [u[1]], 'up');
  });

  // 上游 -> 采集编排
  b += arrow(555, 210, 555, 258, { label: '四源检索 / 翻页 / 详情（REST + 按来源令牌桶、串行）' });

  // 采集编排
  b += group(40, 258, 1560, 130, '② 采集编排（Run 内）');
  b += box(88, 292, 360, 72, 'Scheduler', ['cron 02:00 Asia/Shanghai + 手动触发', '单 Goal 不重叠 · 单轮最长 6h'], 'core');
  b += box(468, 292, 320, 72, 'Run Orchestrator', ['拆解「平台 × 城市 × 关键词」', '流式解析：发现即入库'], 'core');
  b += box(808, 292, 340, 72, 'Source Adapters ×4', ['重试 / 超时 / 错误归一', '区域映射 + 来源健康预检'], 'core');
  b += box(1168, 292, 392, 72, 'stream → 快照 + 公司初建', ['raw_blobs（brotli+sha256）', 'pipeline_jobs 立即入队'], 'store');
  b += arrow(448, 328, 468, 328);
  b += arrow(788, 328, 808, 328);
  b += arrow(1148, 328, 1168, 328);

  // worker 层
  b += group(40, 418, 1560, 150, '③ 补全与后台 Worker（与采集解耦，全天涓流；额度/限频为硬约束）');
  const ws = [
    ['Enrichment Worker', ['tanji 匹配（USCC → 名称）', '工商详情补全 · 不耗额度'], 'core'],
    ['Unlock Worker', ['FIFO + 优先级 + 额度预检', '解锁 1 家 = 1 额度点 · 台账'], 'core'],
    ['Refresh Worker', ['新公司即时抓全 4 平台', '招聘每周 / 店铺每月刷新'], 'core'],
    ['Customs Worker', ['Ali/Mic 英文抬头 → fuma', '名称过滤 + 角色分类 + 置信度'], 'core'],
    ['Quota Poller', ['每 600s 观测探迹额度', '恢复后唤醒 waiting_quota'], 'core'],
  ];
  const ww = 288, wg = 14, wx0 = 58, wy = 452;
  ws.forEach((w, i) => { b += box(wx0 + i * (ww + wg), wy, ww, 92, w[0], w[1], w[2]); });
  b += poly([[960, 364], [960, 410]], { label: '每发现一家立即入队', labelDy: -6 });
  b += poly([[720, 384], [720, 400]], {});
  // 上游 tanji / fuma 到 worker 的调用（标注在框内，避免交叉线）
  b += `<text x="1310" y="565" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#5a6b82">↕ 调用 tanji-client :8787 与 fuma-platform :17890（仅 REST，无浏览器）</text>`;
  b += arrow(1404, 258, 1404, 244, { dash: true, label: '上游刷新' });

  // 存储层
  b += group(40, 608, 1560, 150, '④ 存储（SQLite WAL 单写者 · 唯一事实源 · 历史数据永久保留）');
  b += box(88, 642, 460, 96, 'lead.db（SQLite WAL）', ['goals / runs / companies / contacts / jobs', 'platform_profiles / customs / events …（21 张表）'], 'store');
  b += box(568, 642, 460, 96, 'raw_blobs + raw_snapshots', ['brotli 压缩 ≈10x + sha256 内容去重', 'append-only · 可回溯 / 重放'], 'store');
  b += box(1048, 642, 512, 96, 'archive/YYYY-MM（90 天后冷归档）', ['brotli 文件 + manifest（sha256）· 不删除', 'lead admin archive / verify / restore'], 'store');
  b += arrow(548, 690, 568, 690);
  b += arrow(1028, 690, 1048, 690);
  b += poly([[720, 568], [720, 642]], { label: '阶段结果落库' });

  // 查询 / 事件
  b += group(40, 788, 1560, 118, '⑤ 对外入口与事件出口（CLI / MCP 默认代理 REST；/docs 自包含）');
  const io = [
    ['REST /v1', ['Fastify · Bearer · envelope'], 'io'],
    ['CLI：lead', ['goal / run / company / changes …'], 'io'],
    ['MCP：stdio', ['22 个 lead_* 工具 · 代理 REST'], 'io'],
    ['/docs · /openapi.json', ['/mcp-tools.json · 自包含 HTML'], 'io'],
    ['Event Dispatcher', ['change_events → Webhook / SSE'], 'io'],
  ];
  const iw = 288, ig = 14, ix0 = 58, iy = 820;
  io.forEach((t, i) => { b += box(ix0 + i * (iw + ig), iy, iw, 72, t[0], t[1], t[2]); });
  b += poly([[1240, 758], [1240, 788]], { label: 'seq 游标' });
  b += poly([[340, 758], [340, 788]], {});

  // 下游
  b += group(40, 936, 1560, 56, '');
  const down = ['Webhook 订阅方（HMAC-SHA256 签名）', 'SSE 客户端（Last-Event-ID 续传）', 'Agent / 脚本 / CRM（REST + 游标）'];
  down.forEach((d, i) => { b += box(58 + i * 512, 946, 490, 36, d, [], 'down', { titleSize: 13, r: 8 }); });
  b += arrow(1412, 892, 1412, 938);
  b += arrow(340, 892, 340, 938, {});
  return svgDoc(W, H, b);
}

/* ------------------------------------------------------------------ */
/* 2. 数据流向                                                         */
/* ------------------------------------------------------------------ */
function dataflow() {
  const W = 1500, H = 1090;
  let b = title('LeadPlatform 数据流向', 'Goal → Run → 采集 → 补全 → 主档 → 解锁 / 刷新 / 海关 → 变更事件 → 下游');
  b += legend(58, 1030, [['cfg', '配置与调度'], ['step', '处理步骤'], ['store', '持久化'], ['out', '对外出口']]);

  const rowY = [96, 214, 336, 458, 580, 702, 824, 946];
  // Row1
  b += box(88, rowY[0], 300, 76, '① Goal', ['省 → 地级市枚举', '平台 × 关键词 × 上限 × 频率'], 'io');
  b += box(418, rowY[0], 300, 76, '② Run', ['cron 02:00 / 手动触发', '单 Goal 不重叠 · 最长 6h'], 'core');
  b += box(748, rowY[0], 300, 76, '③ source_queries', ['平台 × 城市 × 关键词', '进度 / 页数 / 错误'], 'core');
  b += box(1078, rowY[0], 320, 76, '④ 四源采集', ['令牌桶限频 · 流式解析', '登录失效 → 跳过该来源'], 'core');
  b += arrow(388, 134, 418, 134);
  b += arrow(718, 134, 748, 134);
  b += arrow(1048, 134, 1078, 134);

  // Row2
  b += box(88, rowY[1], 360, 88, '⑤ 原始快照（不可变）', ['raw_blobs：brotli + sha256 去重', 'raw_snapshots：append-only 元数据'], 'store');
  b += box(560, rowY[1], 380, 88, '⑥ 公司初建 / 去重', ['USCC → 归一化名 + 省市', '→ tanji_company_id 归并'], 'core');
  b += poly([[1220, 172], [1220, 190], [270, 190], [270, 214]], { label: '先落快照，再入流水线' });
  b += poly([[1220, 172], [1268, 172], [1268, 190], [750, 190], [750, 214]], {});

  // Row3
  b += box(430, rowY[2], 320, 84, '⑦ pipeline_jobs', ['source_detail → tanji_match', '→ tanji_detail（租约 + 重试）'], 'core');
  b += box(800, rowY[2], 330, 84, '⑧ 探迹补全', ['匹配（USCC / 名称 / 英文抬头）', '工商字段 · 不消耗额度'], 'core');
  b += arrow(750, 258, 750, 336);
  b += arrow(750, 378, 800, 378);
  b += poly([[270, 302], [270, 320], [560, 320], [560, 336]], { dash: true, label: '原始载荷可回溯' });

  // Row4
  b += box(430, rowY[3], 320, 84, '⑨ companies 主档', ['当前态 + match_meta', 'company_sources 来源证据'], 'store');
  b += poly([[965, 420], [965, 440], [590, 440], [590, 458]], { label: '写主档' });
  b += arrow(750, 378, 800, 378);

  // Row5
  b += box(88, rowY[4], 320, 88, '⑩ 解锁队列', ['FIFO + P0–P3 优先级', '额度预检 · 1 家 = 1 点'], 'core');
  b += box(430, rowY[4], 320, 88, '⑪ 平台档案刷新', ['新公司即时；招聘周 / 店铺月', '岗位 active / closed 生命周期'], 'core');
  b += box(772, rowY[4], 330, 88, '⑫ 海关画像（Ali/Mic）', ['英文抬头 → fuma flag 1/2', '名称过滤 + 角色分类 + 置信度'], 'core');
  b += poly([[590, 542], [590, 566], [248, 566], [248, 580]], { label: '入队' });
  b += poly([[590, 542], [590, 580]], {});
  b += poly([[590, 542], [590, 566], [937, 566], [937, 580]], {});

  // Row6 stores
  b += box(88, rowY[5], 320, 88, 'unlock_ledger + contacts', ['扣点台账（含 alreadyUnlocked）', '联系人明文仅 Bearer 返回'], 'store');
  b += box(430, rowY[5], 320, 88, 'platform_profiles / jobs', ['4 平台最新档案 + 岗位历史', 'next*RefreshAt 可查'], 'store');
  b += box(772, rowY[5], 330, 88, 'customs_profiles', ['totals / 目的国 / HS / 买家', 'sampled=true · confidence'], 'store');
  b += arrow(248, 668, 248, 702);
  b += arrow(590, 668, 590, 702);
  b += arrow(937, 668, 937, 702);

  // Row7 events
  b += box(88, rowY[6], 1280, 82, 'change_events（字段级变更 + 全局 seq 单调递增）', ['company.created / company.updated / contact.unlocked / company.merged', 'platform.profile.updated / platform.jobs.updated / customs.updated'], 'store');
  b += poly([[248, 790], [248, 824]], {});
  b += poly([[590, 790], [590, 824]], {});
  b += poly([[937, 790], [937, 824]], {});

  // Row8 out
  b += box(560, rowY[7], 520, 78, '⑬ 对外：Webhook / SSE / CLI / MCP / REST', ['GET /v1/changes?sinceSeq=N · 断点续传', '订阅方按 seq 去重 · 幂等消费'], 'down');
  b += arrow(728, 906, 728, 946);
  return svgDoc(W, H, b);
}

/* ------------------------------------------------------------------ */
/* 3. 部署拓扑                                                         */
/* ------------------------------------------------------------------ */
function deployment() {
  const W = 1560, H = 1010;
  let b = title('LeadPlatform 部署拓扑', '单机 · systemd --user 常驻 · 仅监听 127.0.0.1 · 数据目录与冷归档');
  b += group(40, 84, 1480, 700, '本机 Linux（NixOS）· systemd --user lead-platform.service（Restart=on-failure · TimeoutStopSec=40）', { dash: true });

  // 上游
  b += group(64, 112, 1432, 126, '上游客户端：独立进程 · 各自管理登录 / 浏览器 / 验证码', { dash: false, fill: '#ffffff' });
  const ups = ['boss :8790', 'zhilian :8791', 'ali :8792', 'mic :8899', 'tanji :8787', 'fuma :17890'];
  ups.forEach((u, i) => { b += box(84 + i * 236, 148, 216, 68, u, ['Bearer REST' + (i === 5 ? '（海关）' : i === 3 ? '（无鉴权）' : '')], 'up', { titleSize: 15, subSize: 12 }); });

  // 平台进程
  b += group(64, 262, 1432, 264, 'LeadPlatform 单进程（127.0.0.1:8793）', { dash: false, fill: '#ffffff', stroke: '#3f8f63' });
  b += box(84, 300, 700, 204, 'REST /v1 · CLI lead · MCP stdio', [
    'Scheduler（cron 02:00 + 手动）',
    'Run Orchestrator + Source Adapters ×4',
    'Enrichment / Unlock / Refresh / Customs Worker',
    'Quota Poller · Event Dispatcher · /docs · /openapi.json',
  ], 'core', { titleSize: 16.5, subSize: 13 });
  b += box(812, 300, 662, 204, '数据目录 ~/.lead-platform/（0700）', [
    'lead.db（SQLite WAL · 21 张表）',
    'logs/lead.log（JSON lines · 10MB×5 轮转）',
    'archive/YYYY-MM/（90 天后冷归档 · manifest sha256）',
    'backups/（每日 + 升级前，保留 7 份）',
  ], 'store', { titleSize: 16.5, subSize: 13 });
  b += arrow(784, 402, 812, 402, { label: '读写' });

  // 连接
  b += arrow(724, 238, 724, 300, { label: 'Bearer REST + 按来源令牌桶（串行）' });

  // 下游
  b += group(64, 556, 1432, 200, '下游消费者（可同机 / 内网 / Agent；不直接写库，只读 + 事件）', { dash: false, fill: '#ffffff', stroke: '#b45b52' });
  b += box(84, 596, 440, 130, 'Agent / 脚本', ['REST /v1 + CLI + MCP', '游标增量：GET /v1/changes'], 'down', { titleSize: 16, subSize: 13 });
  b += box(548, 596, 440, 130, 'Webhook 接收器', ['HMAC-SHA256 验签', '指数退避 8 次 → 死信可重放'], 'down', { titleSize: 16, subSize: 13 });
  b += box(1012, 596, 462, 130, 'SSE 客户端', ['GET /v1/events/stream', 'Last-Event-ID 断点续传'], 'down', { titleSize: 16, subSize: 13 });
  b += arrow(304, 504, 304, 596, { dash: true });
  b += arrow(768, 504, 768, 596, { dash: true });
  b += arrow(1243, 504, 1243, 596, { dash: true });

  // 磁盘与外网
  b += box(64, 812, 700, 64, '建议 ≥500 GB 空闲磁盘', ['历史数据永久保留：快照 ≈5–10 GB/年（压缩后），5 年 50–100 GB'], 'store', { titleSize: 15, subSize: 12.5 });
  b += box(800, 812, 720, 64, '互联网 / 各上游平台', ['由各 client 自行登录与风控；LeadPlatform 不做浏览器自动化、不自动登录'], 'flat', { titleSize: 15, subSize: 12.5 });
  b += `<text x="1484" y="284" text-anchor="end" font-family="${FONT}" font-size="12" fill="#5a6b82">仅监听 loopback · 不暴露 LAN / 公网</text>`;
  b += legend(64, 940, [['up', '上游客户端'], ['core', '平台进程'], ['store', '本地存储'], ['down', '下游消费者'], ['flat', '外部环境']]);
  return svgDoc(W, H, b);
}

/* ------------------------------------------------------------------ */
/* 4. 流水线状态机 + 额度队列                                          */
/* ------------------------------------------------------------------ */
function pipelineState() {
  const W = 1520, H = 980;
  let b = title('流水线状态机与额度队列', '上：公司处理状态；下：解锁任务状态（额度耗尽只会挂起，绝不丢任务、不重复扣点）');
  b += legend(58, 924, [['st', '流转状态'], ['ok', '成功终态'], ['warn', '等待 / 可恢复'], ['bad', '死信']]);

  /* A 公司处理状态 */
  b += group(40, 84, 1440, 356, 'A. 公司处理状态（companies.enrichment_status / unlock_status）');
  const A = [
    ['discovered', ['线索发现']],
    ['source_detailed', ['平台详情', 'USCC 提示']],
    ['tanji_matched', ['探迹匹配成功']],
    ['tanji_enriched', ['工商字段补全']],
    ['unlock pending', ['FIFO + 优先级']],
    ['unlocked', ['联系人入库']],
  ];
  const aw = 196, ag = 28, ax0 = 76, ay = 152;
  A.forEach((st, i) => { b += box(ax0 + i * (aw + ag), ay, aw, 84, st[0], st[1], i >= 3 ? 'ok' : 'st'); });
  for (let i = 0; i < 5; i++) b += arrow(ax0 + i * (aw + ag) + aw, ay + 42, ax0 + (i + 1) * (aw + ag), ay + 42);
  b += box(300, 288, 196, 76, 'unmatched', ['无匹配 · 不耗额度'], 'warn');
  b += box(1030, 288, 196, 76, 'waiting_quota', ['额度耗尽挂起'], 'warn');
  b += poly([[398, 236], [398, 288]], { label: '匹配失败' });
  b += poly([[450, 364], [450, 392], [620, 392], [620, 236]], { dash: true, label: '下一轮 Run 重试', labelDx: 92, labelDy: 18 });
  b += poly([[846, 152], [846, 118], [1294, 118], [1294, 152]], { dash: true, label: '探迹显示已解锁：直接取联系人，不扣额度', labelDx: 90, labelDy: -8 });
  b += arrow(1128, 236, 1128, 288, { label: 'QUOTA_EXHAUSTED' });
  b += poly([[1226, 326], [1262, 326], [1262, 258], [1168, 258], [1168, 236]], { dash: true, label: '额度恢复自动续跑（Quota Poller 唤醒）', labelDx: -118, labelDy: 22 });

  /* B 解锁任务与额度队列 */
  b += group(40, 464, 1440, 440, 'B. 解锁任务与额度队列（pipeline_jobs / unlock_ledger）');
  b += box(76, 528, 260, 92, 'pending', ['FIFO；P0 招聘在招 → P1 付费会员', '→ P2 有海关记录 → P3 其余不自动解锁'], 'st');
  b += box(396, 528, 260, 92, 'running', ['单通道串行 · 租约 60s', '执行前查额度（≤2 分钟旧）'], 'st');
  b += box(716, 528, 300, 92, 'done', ['台账 +1；alreadyUnlocked 记 0', '联系人入库 + contact.unlocked'], 'ok');
  b += box(396, 712, 260, 88, 'waiting_quota', ['不计失败次数', '额度恢复后批量回 pending'], 'warn');
  b += box(716, 712, 260, 88, 'failed', ['指数退避重试', 'attempts < max（3）'], 'warn');
  b += box(1036, 712, 300, 88, 'dead', ['超过重试上限 · 死信', 'POST /v1/jobs/{id}/retry'], 'bad');
  b += arrow(336, 574, 396, 574, { label: '领取' });
  b += arrow(656, 574, 716, 574);
  b += arrow(526, 620, 526, 712, { label: 'QUOTA_EXHAUSTED', labelDx: 60 });
  b += poly([[396, 756], [360, 756], [360, 700], [206, 700], [206, 620]], { dash: true, label: '额度恢复唤醒（保持 FIFO）', labelDy: 18 });
  b += poly([[656, 600], [690, 600], [690, 690], [846, 690], [846, 712]], { label: '其它错误', labelDx: -34, labelDy: -6 });
  b += arrow(976, 756, 1036, 756);
  b += poly([[846, 800], [846, 832], [200, 832], [200, 620]], { dash: true, label: 'attempts < max：退回 FIFO（保持原顺序）', labelDy: -6 });
  b += box(1036, 528, 300, 92, '额度预算（硬约束）', ['日 500 / 月 1500 / 企业月 19500', '结算日 11 号 · 覆盖 ≈9,586 家需 ≈6.4 个月'], 'flat', { titleSize: 14.5, subSize: 12.5 });
  b += `<text x="1036" y="652" font-family="${FONT}" font-size="12" fill="#5a6b82">额度是硬瓶颈：不设每日上限，耗尽挂起、恢复续跑</text>`;
  return svgDoc(W, H, b);
}

/* ------------------------------------------------------------------ */
const builders = {
  'architecture-overview': architecture,
  'data-flow': dataflow,
  'deployment-topology': deployment,
  'pipeline-state': pipelineState,
};

const names = process.argv.slice(2);
const list = names.length ? names : Object.keys(builders);
for (const name of list) {
  const build = builders[name];
  if (!build) { console.error('unknown diagram:', name); continue; }
  const svg = build();
  fs.writeFileSync(path.join(ASSETS, name + '.svg'), svg);
  const dims = svg.match(/width="(\d+)" height="(\d+)"/);
  const W = +dims[1], H = +dims[2];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`;
  const htmlPath = path.join(TMP, name + '.html');
  fs.writeFileSync(htmlPath, html);
  execFileSync(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--window-size=' + W + ',' + H, '--force-device-scale-factor=2',
    '--virtual-time-budget=2500', '--screenshot=' + path.join(ASSETS, name + '.png'),
    'file://' + htmlPath,
  ], { stdio: 'ignore', timeout: 60000 });
  console.log(`[OK] ${name}: ${W}x${H} -> svg + png (${fs.statSync(path.join(ASSETS, name + '.png')).size} bytes)`);
}
