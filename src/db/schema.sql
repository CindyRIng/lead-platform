-- LeadPlatform SQLite schema v1 (frozen)
-- 由 src/db/migrate.ts 在启动时执行；WAL/foreign_keys 由连接层设置。

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region_province TEXT NOT NULL,
  region_province_code TEXT,
  city_codes TEXT NOT NULL DEFAULT '[]',
  platforms TEXT NOT NULL,
  keywords TEXT NOT NULL,
  max_leads_per_run INTEGER,
  daily_lead_limit INTEGER,
  schedule_cron TEXT NOT NULL DEFAULT '0 2 * * *',
  schedule_tz TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  time_window TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  trade_filter TEXT,
  unlock_policy TEXT NOT NULL DEFAULT '{"mode":"priority","order":["recruiting","paid_member","customs","rest"]}',
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_runs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_runs_goal ON goal_runs(goal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_goal_runs_status ON goal_runs(status);

CREATE TABLE IF NOT EXISTS source_queries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES goal_runs(id),
  platform TEXT NOT NULL,
  city_code TEXT NOT NULL,
  platform_region_value TEXT NOT NULL,
  keyword TEXT,
  upstream_query_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  total_pages INTEGER,
  total_count INTEGER,
  last_error TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(run_id, platform, platform_region_value, keyword)
);
CREATE INDEX IF NOT EXISTS idx_source_queries_run ON source_queries(run_id, platform, status);

CREATE TABLE IF NOT EXISTS raw_blobs (
  hash TEXT PRIMARY KEY,
  encoding TEXT NOT NULL DEFAULT 'brotli',
  body BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  platform TEXT,
  run_id TEXT,
  ref_type TEXT,
  ref_id TEXT,
  url TEXT,
  blob_hash TEXT NOT NULL REFERENCES raw_blobs(hash),
  fetched_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archive_path TEXT,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_kind_ref ON raw_snapshots(kind, ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_run ON raw_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_fetched ON raw_snapshots(fetched_at);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_archived ON raw_snapshots(archived);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  uscc TEXT UNIQUE,
  tanji_company_id TEXT UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  english_name TEXT,
  legal_representative TEXT,
  reg_capital TEXT,
  found_time TEXT,
  oper_status TEXT,
  industry TEXT,
  scale TEXT,
  province TEXT,
  city TEXT,
  district TEXT,
  address TEXT,
  business_scope TEXT,
  homepage TEXT,
  phone_count INTEGER,
  email_count INTEGER,
  contact_count INTEGER,
  trade_tags TEXT NOT NULL DEFAULT '[]',
  extra TEXT,
  source_count INTEGER NOT NULL DEFAULT 0,
  enrichment_status TEXT NOT NULL DEFAULT 'discovered',
  unlock_status TEXT NOT NULL DEFAULT 'none',
  match_meta TEXT,
  first_run_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  merged_into TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_norm_name ON companies(normalized_name);
CREATE INDEX IF NOT EXISTS idx_companies_region ON companies(province, city);
CREATE INDEX IF NOT EXISTS idx_companies_enrichment ON companies(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_companies_unlock ON companies(unlock_status);
CREATE INDEX IF NOT EXISTS idx_companies_updated ON companies(updated_at);

CREATE TABLE IF NOT EXISTS company_sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  platform TEXT NOT NULL,
  platform_company_id TEXT NOT NULL,
  source_name TEXT,
  source_url TEXT,
  city_name TEXT,
  evidence TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(platform, platform_company_id)
);
CREATE INDEX IF NOT EXISTS idx_company_sources_company ON company_sources(company_id);

CREATE TABLE IF NOT EXISTS company_contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  tanji_contact_id TEXT,
  name TEXT,
  position TEXT,
  department TEXT,
  region TEXT,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  masked INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  is_key INTEGER NOT NULL DEFAULT 0,
  unlocked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, type, value)
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON company_contacts(company_id);

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  platform TEXT,
  run_id TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs ON pipeline_jobs(company_id, stage, COALESCE(platform, ''));
CREATE INDEX IF NOT EXISTS idx_jobs_status_retry ON pipeline_jobs(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_jobs_stage_fifo ON pipeline_jobs(stage, status, created_at);

CREATE TABLE IF NOT EXISTS unlock_ledger (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  tanji_company_id TEXT,
  result TEXT NOT NULL,
  quota_cost INTEGER NOT NULL DEFAULT 0,
  quota_before INTEGER,
  quota_after INTEGER,
  account_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  error_code TEXT,
  requested_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_unlock_ledger_company ON unlock_ledger(company_id);
CREATE INDEX IF NOT EXISTS idx_unlock_ledger_time ON unlock_ledger(requested_at);

CREATE TABLE IF NOT EXISTS change_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'company',
  entity_id TEXT,
  version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  value_type TEXT,
  source TEXT NOT NULL,
  run_id TEXT,
  actor TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_events_company_version ON change_events(company_id, version);
CREATE INDEX IF NOT EXISTS idx_change_events_company_seq ON change_events(company_id, seq);
CREATE INDEX IF NOT EXISTS idx_change_events_type_seq ON change_events(event_type, seq);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  event_types TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id),
  event_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  response_status INTEGER,
  response_body_head TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quota_observations (
  id TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  daily_limit INTEGER,
  daily_remaining INTEGER,
  monthly_limit INTEGER,
  monthly_remaining INTEGER,
  enterprise_limit INTEGER,
  enterprise_remaining INTEGER,
  settlement_day INTEGER,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_quota_obs_time ON quota_observations(observed_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
  platform TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  logged_in INTEGER,
  expires_at TEXT,
  checked_at TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS regions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  parent_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_regions_parent ON regions(parent_code, level);

CREATE TABLE IF NOT EXISTS region_platform_map (
  region_code TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_value TEXT NOT NULL,
  source TEXT,
  synced_at TEXT,
  PRIMARY KEY(region_code, platform)
);

CREATE TABLE IF NOT EXISTS company_platform_profiles (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  platform TEXT NOT NULL,
  platform_company_id TEXT NOT NULL,
  display_name TEXT,
  source_url TEXT,
  full_name TEXT,
  city_name TEXT,
  address TEXT,
  industry TEXT,
  scale TEXT,
  stage TEXT,
  logo_url TEXT,
  intro TEXT,
  tags TEXT,
  benefits TEXT,
  job_count INTEGER,
  boss_count INTEGER,
  recruiters TEXT,
  store TEXT,
  platform_status TEXT NOT NULL DEFAULT 'active',
  last_fetched_at TEXT NOT NULL,
  last_seen_at TEXT,
  next_jobs_refresh_at TEXT,
  next_store_refresh_at TEXT,
  raw_snapshot_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_platform_profiles_refresh_jobs ON company_platform_profiles(platform, next_jobs_refresh_at);
CREATE INDEX IF NOT EXISTS idx_platform_profiles_refresh_store ON company_platform_profiles(platform, next_store_refresh_at);
CREATE INDEX IF NOT EXISTS idx_platform_profiles_status ON company_platform_profiles(platform_status);

CREATE TABLE IF NOT EXISTS company_platform_jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  platform TEXT NOT NULL,
  platform_company_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  salary_text TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  city_name TEXT,
  district TEXT,
  degree TEXT,
  experience TEXT,
  publish_time TEXT,
  recruiter_name TEXT,
  recruiter_title TEXT,
  job_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  raw TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, platform_company_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_jobs_company ON company_platform_jobs(company_id, platform, status);
CREATE INDEX IF NOT EXISTS idx_platform_jobs_status_seen ON company_platform_jobs(platform, status, last_seen_at);

CREATE TABLE IF NOT EXISTS company_customs_profiles (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  english_name TEXT,
  chinese_name TEXT,
  query_names TEXT NOT NULL DEFAULT '[]',
  upstream_totals TEXT,
  fetched_records INTEGER NOT NULL DEFAULT 0,
  matched_records INTEGER NOT NULL DEFAULT 0,
  exporter_records INTEGER NOT NULL DEFAULT 0,
  importer_records INTEGER NOT NULL DEFAULT 0,
  unmatched_records INTEGER NOT NULL DEFAULT 0,
  date_min TEXT,
  date_max TEXT,
  destinations TEXT,
  origins TEXT,
  hs4 TEXT,
  products TEXT,
  buyers TEXT,
  suppliers TEXT,
  total_weight INTEGER,
  total_count INTEGER,
  amount INTEGER,
  sample_records TEXT,
  confidence TEXT NOT NULL DEFAULT 'none',
  account_id TEXT,
  source TEXT NOT NULL DEFAULT 'fuma',
  cached INTEGER,
  cached_at TEXT,
  expires_at TEXT,
  upstream_version TEXT,
  sampled INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL,
  next_refresh_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customs_refresh ON company_customs_profiles(next_refresh_at);
CREATE INDEX IF NOT EXISTS idx_customs_confidence ON company_customs_profiles(confidence);
