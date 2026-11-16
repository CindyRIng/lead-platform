# 上游接口与迷你流水线验证（2026-11-16）

> 只读探索脚本，**不是生产代码**。用于开发前验证五个上游 client + fuma-platform 的接口契约与关键流水线。

## 内容

| 文件 | 说明 |
|---|---|
| `pipeline-smoke.mjs` | 迷你流水线：健康检查 → Boss/智联/Ali/Mic 采集 → 探迹匹配（含英文抬头）→ fuma 海关查询 → 画像组装 |
| `report.json` | 最近一次运行的步骤矩阵、候选公司、海关聚合结果 |
| `data/raw/*.json` | 原始响应（招聘人姓名已打码；**不包含** tanji unlock/联系人明文落盘） |

## 运行

前置：五个上游 client 与 fuma-platform 已启动；Boss/智联登录态有效。

```bash
node pipeline-smoke.mjs
```

- Token 从本机配置读取，不写入仓库：`~/boss-client/.env`、`~/zhilian-client/.env`、`~/ali-client/.env`、`~/.tanji-client/config.json`、`~/.fuma-platform/config.json`。
- **不调用** `POST /v1/companies/{id}/unlock`，不消耗探迹额度。
- fuma 海关查询使用 `acct_01` 账号权限（只读）。

## 结果摘要（2026-11-16）

- 50 步 / 0 失败 / 约 22s；5 家候选全部探迹匹配成功；Ali/Mic 3 家海关有数据（样本命中 45/20/40 条）。
- 详细结论与问题清单见 [docs/09-上游接口与流水线验证报告.md](../../docs/09-上游接口与流水线验证报告.md)。
