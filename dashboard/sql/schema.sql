-- Muy Business Dashboard schema baseline
-- Safe to run repeatedly on Supabase/Postgres.

create table if not exists clients (
  slug text primary key,
  name text not null,
  owner_name text default '',
  whatsapp text default '',
  package text default 'muy-business',
  status text default 'draft',
  notes text default '',
  dashboard_token_hash text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  archived_at timestamptz
);

create table if not exists tenant_kb (
  slug text primary key references clients(slug) on delete cascade,
  content text not null default '',
  updated_at timestamptz default now()
);

create table if not exists client_whatsapp_pairing (
  slug text primary key references clients(slug) on delete cascade,
  status text default 'not_ready',
  qr text default '',
  qr_type text default 'text',
  note text default '',
  auth_dir text default '',
  connected_at timestamptz,
  disconnected_at timestamptz,
  refreshed_at timestamptz,
  updated_at timestamptz default now()
);

create table if not exists client_runtime_stats (
  slug text primary key references clients(slug) on delete cascade,
  pairing_status text default 'not_ready',
  paired_number text default '',
  paired_name text default '',
  paired_platform text default '',
  service_status text default '',
  contacts int default 0,
  replied_contacts int default 0,
  inbound_messages int default 0,
  bot_replies int default 0,
  unreplied_messages int default 0,
  reply_rate int default 0,
  active_today int default 0,
  avg_inbound_per_contact int default 0,
  kb_score int default 0,
  last_inbound_at timestamptz,
  last_reply_at timestamptz,
  daily jsonb default '[]'::jsonb,
  diagnostics jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);

create table if not exists client_dashboard_snapshots (
  slug text primary key references clients(slug) on delete cascade,
  client jsonb not null default '{}'::jsonb,
  pairing jsonb not null default '{}'::jsonb,
  identity jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  kb_score int default 0,
  updated_at timestamptz default now()
);

create table if not exists client_conversations (
  slug text references clients(slug) on delete cascade,
  contact text not null,
  session_key text default '',
  inbound int default 0,
  outbound int default 0,
  unreplied int default 0,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_user_text text default '',
  last_bot_text text default '',
  updated_at timestamptz default now(),
  primary key(slug, contact)
);

create table if not exists dashboard_auth (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

create table if not exists dashboard_sessions (
  token text primary key,
  role text not null,
  slug text,
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '12 hours')
);

create table if not exists dashboard_audit_log (
  id bigserial primary key,
  slug text,
  actor_role text,
  action text not null,
  detail jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_tenant_kb_updated_at on tenant_kb(updated_at desc);
create index if not exists idx_pairing_status on client_whatsapp_pairing(status);
create index if not exists idx_runtime_stats_updated_at on client_runtime_stats(updated_at desc);
create index if not exists idx_audit_slug_created_at on dashboard_audit_log(slug, created_at desc);
