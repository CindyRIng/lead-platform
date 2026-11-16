# 河北四源覆盖实测（2026-11-16）

> 只读探索脚本，**不是生产代码**。真实调用 Boss/智联/Ali/Mic 四个上游 client 采集河北线索，并做去重估算。
> 结果报告：[docs/12-河北四源覆盖实测报告.md](../../docs/12-河北四源覆盖实测报告.md)

## 结果摘要

| 源 | 唯一公司 |
|---|---|
| Mic（省+11 市关键词全量并集，client 已完成） | **5,008** |
| Ali（129 种子 + 两轮行业×城市扩展） | **2,961** |
| Boss（11 市 × 10 关键词第 1 页） | **1,188** |
| 智联（同上） | **1,261** |
| Boss ∪ 智联 | **2,375**（重叠 74） |
| Ali ∪ Mic | **7,510**（重叠 459） |
| 招聘 ↔ Ali/Mic 重叠（tanji 抽样 160 家） | 6/160 = 3.75% → **≈299** |
| **四源合计（估算）** | **≈9,586**（区间 9,352–9,821） |

## 目录

| 文件 | 说明 |
|---|---|
| `crawl-jobs.mjs` | Boss/智联河北采集（11 市 × 10 关键词；`CRAWL_PAGES`/`CRAWL_SLEEP_MS` 可调） |
| `dedupe-report.mjs` | 同语言去重 + 跨语言重叠（优先采用 tanji 抽样口径） |
| `sample-crossmatch.mjs` | 跨语言重叠抽样：Ali/Mic 英文名 → tanji 匹配 → 是否在招聘名单 |
| `data/ali-hebei-sweep.json` | Ali 河北 1,799 家（`hebeiFull`，含城市/来源） |
| `data/ali-expansion.json` | Ali 扩展状态（county/matrix 断点续跑，1,896 账号） |
| `data/ali-final-union.json` | Ali 最终并集 **2,961** 家 |
| `data/ali-matrix-round1.csv` | Ali 行业×城市矩阵增量 219 行（其中 171 家不在扩展名单） |
| `data/mic-union.ndjson` | Mic 河北 5,008 家并集 |
| `out/boss-companies.jsonl` / `zhilian-companies.jsonl` | 招聘两源公司清单 |
| `out/*-summary.json` | 各源查询统计 |
| `out/dedupe-report.json` | 去重汇总（含 tanji 抽样口径与区间） |
| `out/crossmatch-sample.json` | 跨语言抽样明细（160 家） |

## 复现

```bash
# 前置：四个上游 client + tanji 已运行
cd exploration/2026-11-16-coverage-crawl

# 1) 招聘两源（约 19–22 分钟/源；建议分开跑，避免风控）
CRAWL_PAGES=1 CRAWL_PAGE_SIZE=20 CRAWL_SLEEP_MS=5000 node crawl-jobs.mjs boss
CRAWL_PAGES=3 CRAWL_SLEEP_MS=2000 node crawl-jobs.mjs zhilian

# 2) Ali：扩展种子 + 名称启发式（client 自带 perf 脚本；结果写 /tmp/hebei-sweep-*.json）
cd ~/ali-client && node scripts/perf-hebei.mjs --extended --name-first --verify-sample 60

# 3) Mic：client 已完成全量枚举；产物 /tmp/hebei-enum2/union.ndjson（已复制到 data/mic-union.ndjson）

# 4) 去重 + 跨语言抽样
cd ~/lead-platform/exploration/2026-11-16-coverage-crawl
ALI_JSON=/tmp/hebei-sweep-<ts>.json MIC_NDJSON=data/mic-union.ndjson \
  node dedupe-report.mjs
ALI_JSON=/tmp/hebei-sweep-<ts>.json MIC_NDJSON=data/mic-union.ndjson \
  node sample-crossmatch.mjs 80     # 约 10 分钟（tanji 20/min）
```

## 注意

- 仅只读调用；**未调用 tanji unlock**，探迹额度消耗 0。
- 招聘两源只取了第 1 页（`pages=1`），不是全量；深翻页会增加数量。
- Ali 无省级全量目录；1,970 是“种子可发现量”。
- 跨语言重叠是**抽样估计**（160 家，95% CI 0.8%–6.7%），非精确全量匹配。
- 原始响应中的招聘人姓名等 PII 未落盘（只存公司/岗位聚合字段）。
