-- Muy Business - Supabase Cloud schema
-- Paste semua isi file ini ke Supabase SQL Editor lalu Run.
-- Project: muy business | Project ID: ljcznjgivdgalkpdrbpy
-- Keamanan: username/password tidak disimpan di frontend. Yang disimpan DB hanya HASH SHA-256.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.clients (
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
  archived_at timestamptz,
  constraint clients_package_check check (package = 'muy-business'),
  constraint clients_status_check check (status in ('draft','active','paused','archived'))
);

create table if not exists public.tenant_kb (
  slug text primary key references public.clients(slug) on delete cascade,
  content text not null default '',
  updated_at timestamptz default now()
);

create table if not exists public.dashboard_auth (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

create table if not exists public.dashboard_sessions (
  token text primary key,
  role text not null,
  slug text references public.clients(slug) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '12 hours')
);

create table if not exists public.client_runtime_stats (
  slug text primary key references public.clients(slug) on delete cascade,
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

create table if not exists public.client_whatsapp_pairing (
  slug text primary key references public.clients(slug) on delete cascade,
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

create table if not exists public.client_dashboard_snapshots (
  slug text primary key references public.clients(slug) on delete cascade,
  client jsonb not null default '{}'::jsonb,
  pairing jsonb not null default '{}'::jsonb,
  identity jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  diagnostics jsonb not null default '{}'::jsonb,
  kb_score int default 0,
  updated_at timestamptz default now()
);

create table if not exists public.client_conversations (
  slug text references public.clients(slug) on delete cascade,
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

create table if not exists public.dashboard_audit_log (
  id bigserial primary key,
  slug text references public.clients(slug) on delete set null,
  actor_role text,
  action text not null,
  detail jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table public.dashboard_auth add column if not exists updated_at timestamptz default now();
alter table public.dashboard_sessions add column if not exists expires_at timestamptz default (now() + interval '12 hours');

create index if not exists idx_clients_status on public.clients(status);
create index if not exists idx_clients_updated_at on public.clients(updated_at desc);
create index if not exists idx_dashboard_sessions_slug on public.dashboard_sessions(slug);
create index if not exists idx_dashboard_sessions_expires on public.dashboard_sessions(expires_at);
create index if not exists idx_runtime_updated_at on public.client_runtime_stats(updated_at desc);
create index if not exists idx_pairing_status on public.client_whatsapp_pairing(status);
create index if not exists idx_conversations_slug_updated on public.client_conversations(slug, updated_at desc);
create index if not exists idx_conversations_unreplied on public.client_conversations(slug, unreplied desc);
create index if not exists idx_audit_slug_created on public.dashboard_audit_log(slug, created_at desc);
create index if not exists idx_audit_created on public.dashboard_audit_log(created_at desc);

-- updated_at triggers
drop trigger if exists trg_clients_updated_at on public.clients;
create trigger trg_clients_updated_at before update on public.clients for each row execute function public.set_updated_at();
drop trigger if exists trg_tenant_kb_updated_at on public.tenant_kb;
create trigger trg_tenant_kb_updated_at before update on public.tenant_kb for each row execute function public.set_updated_at();
drop trigger if exists trg_auth_updated_at on public.dashboard_auth;
create trigger trg_auth_updated_at before update on public.dashboard_auth for each row execute function public.set_updated_at();
drop trigger if exists trg_runtime_updated_at on public.client_runtime_stats;
create trigger trg_runtime_updated_at before update on public.client_runtime_stats for each row execute function public.set_updated_at();
drop trigger if exists trg_pairing_updated_at on public.client_whatsapp_pairing;
create trigger trg_pairing_updated_at before update on public.client_whatsapp_pairing for each row execute function public.set_updated_at();
drop trigger if exists trg_snapshots_updated_at on public.client_dashboard_snapshots;
create trigger trg_snapshots_updated_at before update on public.client_dashboard_snapshots for each row execute function public.set_updated_at();
drop trigger if exists trg_conversations_updated_at on public.client_conversations;
create trigger trg_conversations_updated_at before update on public.client_conversations for each row execute function public.set_updated_at();

-- RLS aktif semua. Tidak ada akses anon/public ke data dashboard.
alter table public.clients enable row level security;
alter table public.tenant_kb enable row level security;
alter table public.dashboard_auth enable row level security;
alter table public.dashboard_sessions enable row level security;
alter table public.client_runtime_stats enable row level security;
alter table public.client_whatsapp_pairing enable row level security;
alter table public.client_dashboard_snapshots enable row level security;
alter table public.client_conversations enable row level security;
alter table public.dashboard_audit_log enable row level security;

drop policy if exists "dashboard backend only clients" on public.clients;
drop policy if exists "dashboard backend only tenant_kb" on public.tenant_kb;
drop policy if exists "dashboard backend only dashboard_auth" on public.dashboard_auth;
drop policy if exists "dashboard backend only dashboard_sessions" on public.dashboard_sessions;
drop policy if exists "dashboard backend only runtime" on public.client_runtime_stats;
drop policy if exists "dashboard backend only pairing" on public.client_whatsapp_pairing;
drop policy if exists "dashboard backend only snapshots" on public.client_dashboard_snapshots;
drop policy if exists "dashboard backend only conversations" on public.client_conversations;
drop policy if exists "dashboard backend only audit" on public.dashboard_audit_log;

create policy "dashboard backend only clients" on public.clients for all to service_role using (true) with check (true);
create policy "dashboard backend only tenant_kb" on public.tenant_kb for all to service_role using (true) with check (true);
create policy "dashboard backend only dashboard_auth" on public.dashboard_auth for all to service_role using (true) with check (true);
create policy "dashboard backend only dashboard_sessions" on public.dashboard_sessions for all to service_role using (true) with check (true);
create policy "dashboard backend only runtime" on public.client_runtime_stats for all to service_role using (true) with check (true);
create policy "dashboard backend only pairing" on public.client_whatsapp_pairing for all to service_role using (true) with check (true);
create policy "dashboard backend only snapshots" on public.client_dashboard_snapshots for all to service_role using (true) with check (true);
create policy "dashboard backend only conversations" on public.client_conversations for all to service_role using (true) with check (true);
create policy "dashboard backend only audit" on public.dashboard_audit_log for all to service_role using (true) with check (true);


-- Kunci akses REST API publik: anon/authenticated tidak diberi akses langsung ke tabel dashboard.
revoke all on table public.clients from anon, authenticated;
revoke all on table public.tenant_kb from anon, authenticated;
revoke all on table public.dashboard_auth from anon, authenticated;
revoke all on table public.dashboard_sessions from anon, authenticated;
revoke all on table public.client_runtime_stats from anon, authenticated;
revoke all on table public.client_whatsapp_pairing from anon, authenticated;
revoke all on table public.client_dashboard_snapshots from anon, authenticated;
revoke all on table public.client_conversations from anon, authenticated;
revoke all on table public.dashboard_audit_log from anon, authenticated;
revoke all on sequence public.dashboard_audit_log_id_seq from anon, authenticated;

-- Service role tetap bisa dipakai kalau backend nanti memakai Supabase service API.
grant all on table public.clients to service_role;
grant all on table public.tenant_kb to service_role;
grant all on table public.dashboard_auth to service_role;
grant all on table public.dashboard_sessions to service_role;
grant all on table public.client_runtime_stats to service_role;
grant all on table public.client_whatsapp_pairing to service_role;
grant all on table public.client_dashboard_snapshots to service_role;
grant all on table public.client_conversations to service_role;
grant all on table public.dashboard_audit_log to service_role;
grant usage, select on sequence public.dashboard_audit_log_id_seq to service_role;

-- Initial admin disimpan sebagai HASH di DB, bukan di frontend.
-- Login awal: username admin, password admin12345. Ganti dari menu Settings setelah login.
insert into public.dashboard_auth(key, value)
values ('adminUsernameHash', to_jsonb(encode(digest('admin', 'sha256'), 'hex')))
on conflict (key) do nothing;

insert into public.dashboard_auth(key, value)
values ('adminPasswordHash', to_jsonb(encode(digest('admin12345', 'sha256'), 'hex')))
on conflict (key) do nothing;

-- Tidak ada seed client demo. Client dibuat dari dashboard admin agar data produksi tetap bersih.
