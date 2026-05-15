import express from 'express';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import QRCode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from 'baileys';

const execFileP = promisify(execFile);
const { Pool } = pg;
const app = express();
const PORT = Number(process.env.MUY_DASHBOARD_PORT || 18880);
const ROOT = process.env.OPENCLAW_BUSINESS_HOME || path.join(process.env.HOME, 'openclaw-business');
const TENANTS = path.join(ROOT, '.openclaw', 'workspace', 'tenants');
const LEGACY_CLIENTS = path.join(ROOT, 'clients.json');
const AUTH = path.join(ROOT, 'dashboard-auth.json');
const OPENCLAW_CONFIG = path.join(ROOT, '.openclaw', 'openclaw.json');
const WA_CREDS = path.join(ROOT, '.openclaw', 'credentials', 'whatsapp');
const SINGLE_PACKAGE = 'muy-business';
const DATABASE_URL = process.env.MUY_DATABASE_URL;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('supabase.com') || DATABASE_URL.includes('pooler.supabase.com')
    ? { rejectUnauthorized: false }
    : undefined
}) : null;
const waSockets = new Map();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'dashboard', 'public')));

function safeSlug(input) { return String(input || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64); }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function token() { return crypto.randomBytes(24).toString('base64url'); }
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data, null, 2)); }
function tenantFile(slug) { return path.join(TENANTS, slug, 'README.md'); }
function bearer(req) { return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); }
function sanitizeClient(c) { if (!c) return c; const { dashboard_token_hash, dashboardTokenHash, ...rest } = c; return { slug: rest.slug, name: rest.name, ownerName: rest.ownerName ?? rest.owner_name ?? '', whatsapp: rest.whatsapp ?? '', package: SINGLE_PACKAGE, status: rest.status ?? 'draft', notes: rest.notes ?? '', createdAt: rest.createdAt ?? rest.created_at, updatedAt: rest.updatedAt ?? rest.updated_at, archivedAt: rest.archivedAt ?? rest.archived_at }; }

function normalizePhone(v) { const d = String(v || '').replace(/[^0-9]/g, ''); return d ? '+' + d : ''; }
function jidToPhone(v) { const id = String(v || '').split('@')[0].split(':')[0]; return normalizePhone(id); }
function textFromContent(content) { return (content || []).map(x => x?.text || '').filter(Boolean).join('\n').trim(); }
function safeDate(ts) { const n = Number(ts); return Number.isFinite(n) ? new Date(n).toISOString() : (ts || null); }
async function readWhatsappIdentity(slug) {
  const credsFile = path.join(WA_CREDS, slug, 'creds.json');
  const creds = await readJson(credsFile, null);
  const me = creds?.me || null;
  return { paired: !!me, name: me?.name || '', number: jidToPhone(me?.id), jid: me?.id || '', lid: me?.lid || '', platform: creds?.platform || '', authDir: path.join(WA_CREDS, slug) };
}
async function sessionStore() { return readJson(path.join(ROOT, '.openclaw', 'agents', 'main', 'sessions', 'sessions.json'), {}); }
async function readJsonl(file) { try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function contextSender(text) {
  const m = String(text || '').match(/"sender_id"\s*:\s*"([^"]+)"/);
  return m ? normalizePhone(m[1]) || m[1] : '';
}
async function tenantStats(slug) {
  const store = await sessionStore();
  const rows = [];
  for (const [key, entry] of Object.entries(store)) {
    const origin = entry.origin || {}; const delivery = entry.deliveryContext || {};
    if (origin.accountId !== slug && delivery.accountId !== slug && entry.lastAccountId !== slug) continue;
    const events = await readJsonl(entry.sessionFile);
    let contact = normalizePhone(origin.from || delivery.to || entry.lastTo || '');
    let inbound = 0, outbound = 0, lastInbound = null, lastOutbound = null, lastUserText = '', lastBotText = '';
    for (const ev of events) {
      if (ev.type === 'custom_message' && ev.customType === 'openclaw.runtime-context') contact = contextSender(ev.content) || contact;
      if (ev.type !== 'message') continue;
      const role = ev.message?.role;
      const text = textFromContent(ev.message?.content);
      if (role === 'user') { if (!/^\[OpenClaw heartbeat poll\]/i.test(text)) { inbound++; lastInbound = ev.timestamp || safeDate(ev.message?.timestamp); lastUserText = text.slice(0, 180); } }
      if (role === 'assistant') { const clean = text.replace(/^<final>|<\/final>$/g,'').trim(); if (clean && clean !== 'HEARTBEAT_OK' && clean !== 'NO_REPLY') { outbound++; lastOutbound = ev.timestamp || safeDate(ev.message?.timestamp); lastBotText = clean.slice(0, 180); } }
    }
    rows.push({ sessionKey:key, contact: contact || '-', inbound, outbound, replied: outbound > 0, unreplied: Math.max(0, inbound - outbound), lastInbound, lastOutbound, lastUserText, lastBotText });
  }
  const uniqueContacts = new Set(rows.map(r => r.contact).filter(x => x && x !== '-'));
  const repliedContacts = new Set(rows.filter(r => r.replied).map(r => r.contact).filter(x => x && x !== '-'));
  const dayMap = new Map();
  for (const r of rows) {
    const key = (r.lastInbound || new Date().toISOString()).slice(0,10);
    const cur = dayMap.get(key) || { date:key, inbound:0, replies:0, contacts:0 };
    cur.inbound += r.inbound; cur.replies += r.outbound; cur.contacts += r.contact && r.contact !== '-' ? 1 : 0;
    dayMap.set(key, cur);
  }
  const inboundMessages = rows.reduce((a,r)=>a+r.inbound,0);
  const botReplies = rows.reduce((a,r)=>a+r.outbound,0);
  const unrepliedMessages = rows.reduce((a,r)=>a+r.unreplied,0);
  const sortedRows = rows.sort((a,b)=>String(b.lastInbound||'').localeCompare(String(a.lastInbound||'')));
  const conversations = sortedRows.slice(0,50);
  const unrepliedConversations = sortedRows.filter(r => r.unreplied > 0).slice(0,25);
  const topContacts = [...rows].sort((a,b)=>(b.inbound+b.outbound)-(a.inbound+a.outbound)).slice(0,10);
  const now = Date.now();
  const activeToday = rows.filter(r => r.lastInbound && (now - Date.parse(r.lastInbound)) < 86400000).length;
  const lastInboundAt = sortedRows.find(r => r.lastInbound)?.lastInbound || null;
  const lastReplyAt = [...rows].sort((a,b)=>String(b.lastOutbound||'').localeCompare(String(a.lastOutbound||''))).find(r => r.lastOutbound)?.lastOutbound || null;
  return { contacts: uniqueContacts.size, repliedContacts: repliedContacts.size, inboundMessages, botReplies, unrepliedMessages, replyRate: inboundMessages ? Math.min(100, Math.round((botReplies/inboundMessages)*100)) : 0, activeToday, lastInboundAt, lastReplyAt, avgInboundPerContact: uniqueContacts.size ? Math.round(inboundMessages/uniqueContacts.size) : 0, daily: Array.from(dayMap.values()).sort((a,b)=>a.date.localeCompare(b.date)).slice(-14), topContacts, unrepliedConversations, conversations };
}
async function whatsappDiagnostics(slug) {
  let recent = '';
  try { recent = (await execFileP('journalctl', ['--user','-u','openclaw-business.service','-n','220','--no-pager'], { timeout: 8000 })).stdout; } catch {}
  const lines = recent.split('\n').filter(x => x.includes('[whatsapp]') || x.includes(`whatsapp:${slug}`) || x.includes(`[${slug}]`)).slice(-40);
  const inbound = lines.filter(x => x.includes('Inbound message')).length;
  const provider = lines.reverse().find(x => x.includes(`[whatsapp] [${slug}] starting provider`)) || '';
  return { service: await serviceState('openclaw-business.service'), inboundRecent: inbound, providerLine: provider, recent: lines.reverse().slice(-12).join('\n') };
}
async function updateWhatsappAccount(slug, enabled) {
  const cfg = await readJson(OPENCLAW_CONFIG, {});
  cfg.plugins = cfg.plugins || {}; cfg.plugins.entries = cfg.plugins.entries || {}; cfg.plugins.entries.whatsapp = { enabled: true };
  cfg.channels = cfg.channels || {}; cfg.channels.whatsapp = cfg.channels.whatsapp || {};
  cfg.channels.whatsapp.enabled = true; cfg.channels.whatsapp.dmPolicy = cfg.channels.whatsapp.dmPolicy || 'open';
  cfg.channels.whatsapp.accounts = cfg.channels.whatsapp.accounts || {};
  if (enabled) { const linked = await readWhatsappIdentity(slug); cfg.channels.whatsapp.selfChatMode = true; cfg.channels.whatsapp.accounts[slug] = { authDir: path.join(WA_CREDS, slug), dmPolicy: 'open', selfChatMode: true, allowFrom: linked.number ? ['*', linked.number] : ['*'] }; }
  else delete cfg.channels.whatsapp.accounts[slug];
  await writeJson(OPENCLAW_CONFIG, cfg);
  return path.join(WA_CREDS, slug);
}
async function restartBusinessGateway() { try { await execFileP('systemctl', ['--user','restart','openclaw-business.service'], { timeout:15000 }); } catch {} }
async function upsertPairingDb(slug, data={}) {
  try {
    await query(`insert into client_whatsapp_pairing(slug,status,qr,qr_type,note,auth_dir,connected_at,disconnected_at,refreshed_at,updated_at)
      values($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,now())
      on conflict(slug) do update set status=coalesce(excluded.status,client_whatsapp_pairing.status), qr=coalesce(excluded.qr,client_whatsapp_pairing.qr), qr_type=coalesce(excluded.qr_type,client_whatsapp_pairing.qr_type), note=coalesce(excluded.note,client_whatsapp_pairing.note), auth_dir=coalesce(excluded.auth_dir,client_whatsapp_pairing.auth_dir), connected_at=coalesce(excluded.connected_at,client_whatsapp_pairing.connected_at), disconnected_at=coalesce(excluded.disconnected_at,client_whatsapp_pairing.disconnected_at), refreshed_at=coalesce(excluded.refreshed_at,client_whatsapp_pairing.refreshed_at), updated_at=now()`,
      [slug,data.status??null,data.qr??null,data.qrType??data.qr_type??null,data.note??null,data.authDir??data.auth_dir??null,data.connectedAt??null,data.disconnectedAt??null,data.refreshedAt??null]);
  } catch {}
}
async function pairingDb(slug) { try { const r=await query(`select * from client_whatsapp_pairing where slug=$1`, [slug]); return r.rows[0]||null; } catch { return null; } }
async function saveDashboardSnapshot(slug, data) {
  try { await query(`insert into client_dashboard_snapshots(slug,client,pairing,identity,stats,diagnostics,kb_score,updated_at) values($1,$2,$3,$4,$5,$6,$7,now()) on conflict(slug) do update set client=excluded.client,pairing=excluded.pairing,identity=excluded.identity,stats=excluded.stats,diagnostics=excluded.diagnostics,kb_score=excluded.kb_score,updated_at=now()`, [slug,JSON.stringify(data.client||{}),JSON.stringify(data.pairing||{}),JSON.stringify(data.identity||{}),JSON.stringify(data.stats||{}),JSON.stringify(data.diagnostics||{}),data.kbScore||0]); } catch {}
}
async function tenantPairing(slug) {
  const dir = path.join(TENANTS, slug); const authDir = path.join(WA_CREDS, slug);
  const db = await pairingDb(slug);
  let qr = db?.qr || ''; let qrType = db?.qr_type || 'text';
  if (!qr) {
    const qrFiles = ['qr.png','qr.svg','qr.txt','pairing.txt'];
    for (const f of qrFiles) { try { const file = path.join(dir, f); if (!fss.existsSync(file)) continue; if (f.endsWith('.png')) { qr = 'data:image/png;base64,' + await fs.readFile(file, 'base64'); qrType = 'image'; } else { qr = await fs.readFile(file, 'utf8'); qrType = f.endsWith('.svg') ? 'svg' : 'text'; } break; } catch {} }
  }
  const credsConnected = fss.existsSync(path.join(authDir, 'creds.json'));
  const markerConnected = fss.existsSync(path.join(dir, 'whatsapp-connected'));
  const connected = credsConnected || markerConnected || db?.status === 'connected';
  const status = connected ? 'connected' : (qr ? 'scan_required' : 'not_ready');
  const note = connected ? 'WhatsApp sudah memiliki sesi tertaut. Jika belum membalas, restart service bot.' : (qr ? 'Scan QR dari WhatsApp perangkat client.' : 'Klik Refresh QR untuk membuat QR pairing WhatsApp.');
  const result = { slug, status, qr: connected ? '' : qr, qrType, updatedAt: new Date().toISOString(), authDir, note };
  await upsertPairingDb(slug, { ...result, qr: result.qr, connectedAt: connected ? new Date().toISOString() : null });
  return result;
}
async function startWhatsappPairing(slug) {
  const dir = path.join(TENANTS, slug); await fs.mkdir(dir, { recursive:true });
  const authDir = await updateWhatsappAccount(slug, false); await fs.mkdir(authDir, { recursive:true });
  try { waSockets.get(slug)?.end?.(); } catch {}
  waSockets.delete(slug);
  await fs.rm(path.join(dir, 'qr.txt'), { force:true });
  await fs.rm(path.join(dir, 'qr.png'), { force:true });
  await fs.rm(path.join(dir, 'qr.svg'), { force:true });
  await fs.rm(path.join(dir, 'pairing.txt'), { force:true });
  await fs.rm(path.join(dir, 'whatsapp-connected'), { force:true });
  await fs.rm(authDir, { recursive:true, force:true });
  await fs.mkdir(authDir, { recursive:true });
  await restartBusinessGateway();
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: Browsers.macOS('Chrome') });
  waSockets.set(slug, sock);
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      await fs.writeFile(path.join(dir, 'qr.txt'), u.qr);
      await fs.writeFile(path.join(dir, 'qr.png'), (await QRCode.toDataURL(u.qr)).replace(/^data:image\/png;base64,/, ''), 'base64');
      await fs.rm(path.join(dir, 'whatsapp-connected'), { force:true });
      await upsertPairingDb(slug, { status:'scan_required', qr:'data:image/png;base64,' + (await fs.readFile(path.join(dir, 'qr.png'), 'base64')), qrType:'image', note:'Scan QR dari WhatsApp perangkat client.', authDir, refreshedAt:new Date().toISOString() });
    }
    if (u.connection === 'open') { await fs.writeFile(path.join(dir, 'whatsapp-connected'), new Date().toISOString()); await fs.rm(path.join(dir, 'qr.txt'), { force:true }); await fs.rm(path.join(dir, 'qr.png'), { force:true }); await updateWhatsappAccount(slug, true); try { sock.end(); } catch {} waSockets.delete(slug); await upsertPairingDb(slug, { status:'connected', qr:'', qrType:'text', note:'WhatsApp sudah terhubung.', authDir, connectedAt:new Date().toISOString() }); await restartBusinessGateway(); }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { await fs.rm(authDir, { recursive:true, force:true }); await fs.rm(path.join(dir, 'whatsapp-connected'), { force:true }); }
      else if (fss.existsSync(path.join(authDir, 'creds.json'))) { await fs.writeFile(path.join(dir, 'whatsapp-connected'), new Date().toISOString()); await fs.rm(path.join(dir, 'qr.txt'), { force:true }); await fs.rm(path.join(dir, 'qr.png'), { force:true }); await updateWhatsappAccount(slug, true); try { sock.end(); } catch {} waSockets.delete(slug); await upsertPairingDb(slug, { status:'connected', qr:'', qrType:'text', note:'WhatsApp sudah terhubung.', authDir, connectedAt:new Date().toISOString() }); await restartBusinessGateway(); }
    }
  });
  await new Promise(r => setTimeout(r, 2500));
  return tenantPairing(slug);
}

async function serviceState(name) { try { return (await execFileP('systemctl', ['--user', 'is-active', name], { timeout: 5000 })).stdout.trim(); } catch (e) { return (e.stdout || e.stderr || 'inactive').trim(); } }
async function telegramBotState() { let active = await serviceState('openclaw-business.service'); let bot = '@businessmuy_bot'; let recent = ''; try { recent = (await execFileP('journalctl', ['--user','-u','openclaw-business.service','-n','80','--no-pager'], { timeout: 8000 })).stdout; } catch {} return { service: active, bot, connected: /starting provider \(@businessmuy_bot\)|sendMessage ok|telegram/i.test(recent), detail: recent.split('\n').filter(x=>x.includes('@businessmuy_bot')||x.includes('[telegram]')).slice(-5).join('\n') }; }

async function query(sql, params=[]) { if (!pool) throw new Error('Database belum dikonfigurasi'); return pool.query(sql, params); }

async function initDb() {
  await fs.mkdir(TENANTS, { recursive: true });
  if (!pool) throw new Error('MUY_DATABASE_URL belum diset');
  await query(`create table if not exists clients (
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
  )`);
  await query(`create table if not exists tenant_kb (
    slug text primary key references clients(slug) on delete cascade,
    content text not null default '',
    updated_at timestamptz default now()
  )`);
  await query(`create table if not exists dashboard_auth (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz default now()
  )`);
  await query(`alter table dashboard_auth add column if not exists updated_at timestamptz default now()`);
  await query(`create table if not exists dashboard_sessions (
    token text primary key,
    role text not null,
    slug text,
    created_at timestamptz default now(),
    expires_at timestamptz default (now() + interval '12 hours')
  )`);
  await query(`alter table dashboard_sessions add column if not exists expires_at timestamptz default (now() + interval '12 hours')`);
  await query(`create table if not exists client_runtime_stats (
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
  )`);
  await query(`create table if not exists client_whatsapp_pairing (
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
  )`);
  await query(`create table if not exists client_dashboard_snapshots (
    slug text primary key references clients(slug) on delete cascade,
    client jsonb not null default '{}'::jsonb,
    pairing jsonb not null default '{}'::jsonb,
    identity jsonb not null default '{}'::jsonb,
    stats jsonb not null default '{}'::jsonb,
    diagnostics jsonb not null default '{}'::jsonb,
    kb_score int default 0,
    updated_at timestamptz default now()
  )`);
  await query(`create table if not exists client_conversations (
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
  )`);
  await query(`create table if not exists dashboard_audit_log (
    id bigserial primary key,
    slug text,
    actor_role text,
    action text not null,
    detail jsonb default '{}'::jsonb,
    created_at timestamptz default now()
  )`);
  await query(`update clients set package='muy-business' where package is distinct from 'muy-business'`);
  const legacy = await readJson(AUTH, null);
  const defaultAdminUsername = process.env.MUY_DASHBOARD_ADMIN_USERNAME || legacy?.adminUsername || 'admin';
  const defaultAdminPasswordHash = legacy?.adminPasswordHash || sha(process.env.MUY_DASHBOARD_ADMIN_PASSWORD || 'admin12345');
  await query(`insert into dashboard_auth(key,value) values('adminUsernameHash',$1) on conflict (key) do nothing`, [JSON.stringify(sha(defaultAdminUsername))]);
  await query(`insert into dashboard_auth(key,value) values('adminPasswordHash',$1) on conflict (key) do nothing`, [JSON.stringify(defaultAdminPasswordHash)]);
  if (process.env.MUY_MIGRATE_LEGACY_CLIENTS === '1') await migrateLegacyClients();
  await backfillSupabaseRuntime();
}


function kbQualityScore(kb) { const lower = String(kb||'').toLowerCase(); const req = ['produk','harga','cara order','pembayaran','jam operasional','refund','faq','handoff']; const hit = req.filter(x=>lower.includes(x)).length; return Math.min(100, Math.round((hit/req.length)*80 + Math.min(20, String(kb||'').replace(/\s/g,'').length/180))); }
async function auditLog(slug, role, action, detail={}) { try { await query(`insert into dashboard_audit_log(slug,actor_role,action,detail) values($1,$2,$3,$4)`, [slug||null, role||null, action, JSON.stringify(detail||{})]); } catch {} }
async function syncClientRuntime(slug, payload) {
  const kb = payload.kb || ''; const kbScore = payload.kbScore ?? kbQualityScore(kb);
  const p = payload.pairing || {}; const id = payload.identity || {}; const st = payload.stats || {}; const dg = payload.diagnostics || {};
  await query(`insert into client_runtime_stats(slug,pairing_status,paired_number,paired_name,paired_platform,service_status,contacts,replied_contacts,inbound_messages,bot_replies,unreplied_messages,reply_rate,active_today,avg_inbound_per_contact,kb_score,last_inbound_at,last_reply_at,daily,diagnostics,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz,$18::jsonb,$19::jsonb,now())
    on conflict(slug) do update set pairing_status=excluded.pairing_status, paired_number=excluded.paired_number, paired_name=excluded.paired_name, paired_platform=excluded.paired_platform, service_status=excluded.service_status, contacts=excluded.contacts, replied_contacts=excluded.replied_contacts, inbound_messages=excluded.inbound_messages, bot_replies=excluded.bot_replies, unreplied_messages=excluded.unreplied_messages, reply_rate=excluded.reply_rate, active_today=excluded.active_today, avg_inbound_per_contact=excluded.avg_inbound_per_contact, kb_score=excluded.kb_score, last_inbound_at=excluded.last_inbound_at, last_reply_at=excluded.last_reply_at, daily=excluded.daily, diagnostics=excluded.diagnostics, updated_at=now()`,
    [slug,p.status||'not_ready',id.number||'',id.name||'',id.platform||'',dg.service||'',st.contacts||0,st.repliedContacts||0,st.inboundMessages||0,st.botReplies||0,st.unrepliedMessages||0,st.replyRate||0,st.activeToday||0,st.avgInboundPerContact||0,kbScore,st.lastInboundAt||null,st.lastReplyAt||null,JSON.stringify(st.daily||[]),JSON.stringify(dg||{})]);
  for (const c of st.conversations || []) {
    await query(`insert into client_conversations(slug,contact,session_key,inbound,outbound,unreplied,last_inbound_at,last_outbound_at,last_user_text,last_bot_text,updated_at)
      values($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10,now())
      on conflict(slug,contact) do update set session_key=excluded.session_key,inbound=excluded.inbound,outbound=excluded.outbound,unreplied=excluded.unreplied,last_inbound_at=excluded.last_inbound_at,last_outbound_at=excluded.last_outbound_at,last_user_text=excluded.last_user_text,last_bot_text=excluded.last_bot_text,updated_at=now()`,
      [slug,c.contact||'-',c.sessionKey||'',c.inbound||0,c.outbound||0,c.unreplied||0,c.lastInbound||null,c.lastOutbound||null,c.lastUserText||'',c.lastBotText||'']);
  }
  return kbScore;
}
async function buildClientDashboard(slug) {
  const c=await query(`select * from clients where slug=$1`, [slug]); if(!c.rowCount) return null;
  let kb=''; try { const k=await query(`select content from tenant_kb where slug=$1`, [slug]); kb=k.rows[0]?.content||''; } catch {}
  const [pairing, identity, stats, diagnostics] = await Promise.all([tenantPairing(slug), readWhatsappIdentity(slug), tenantStats(slug), whatsappDiagnostics(slug)]);
  const kbScore = await syncClientRuntime(slug, { pairing, identity, stats, diagnostics, kb });
  const data = { ok:true, client:sanitizeClient(c.rows[0]), pairing, identity, stats, diagnostics, kbScore };
  await saveDashboardSnapshot(slug, data);
  return data;
}
function emptyKnowledgeBase() { return ''; }
function isReservedNonProductionClient(slug, name='') {
  const s = String(slug || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  return !s || /(demo|dummy|sample|contoh|test|audit|fake|lorem)/i.test(s) || /(demo|dummy|sample|contoh|test|audit|fake|lorem)/i.test(n);
}
async function backfillSupabaseRuntime() {
  const rows = await query(`select slug from clients order by created_at desc`);
  for (const row of rows.rows) {
    const slug = row.slug;
    const authDir = path.join(WA_CREDS, slug);
    const existing = await pairingDb(slug);
    if (!existing) await upsertPairingDb(slug, { status:'not_ready', qr:'', qrType:'text', note:'Menunggu pairing WhatsApp.', authDir });
    try { const data = await buildClientDashboard(slug); if (data) await saveDashboardSnapshot(slug, data); } catch {}
  }
}
async function migrateLegacyClients() {
  const legacy = await readJson(LEGACY_CLIENTS, { clients: [] });
  for (const c of legacy.clients || []) {
    const slug = safeSlug(c.slug);
    const name = String(c.name || '');
    if (isReservedNonProductionClient(slug, name)) continue;
    await query(`insert into clients(slug,name,owner_name,whatsapp,package,status,notes,dashboard_token_hash,created_at,updated_at,archived_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz,now()),coalesce($10::timestamptz,now()),$11::timestamptz)
      on conflict(slug) do update set name=excluded.name, owner_name=excluded.owner_name, whatsapp=excluded.whatsapp, package=excluded.package, status=excluded.status, notes=excluded.notes, dashboard_token_hash=coalesce(clients.dashboard_token_hash, excluded.dashboard_token_hash), updated_at=now(), archived_at=excluded.archived_at`,
      [slug,c.name,c.ownerName||c.owner_name||'',c.whatsapp||'','muy-business',c.status||'draft',c.notes||'',c.dashboardTokenHash||c.dashboard_token_hash||null,c.createdAt||c.created_at,c.updatedAt||c.updated_at,c.archivedAt||c.archived_at||null]);
    let content = '';
    try { content = await fs.readFile(tenantFile(slug), 'utf8'); } catch { content = emptyKnowledgeBase(); }
    await query(`insert into tenant_kb(slug,content) values($1,$2) on conflict(slug) do update set content=case when tenant_kb.content='' then excluded.content else tenant_kb.content end`, [slug, content]);
  }
}

async function requireAdmin(req, res, next) { try { const t = bearer(req); await query(`delete from dashboard_sessions where expires_at is not null and expires_at < now()`); const r = await query(`select role from dashboard_sessions where token=$1 and (expires_at is null or expires_at > now())`, [t]); if (!r.rowCount || r.rows[0].role !== 'admin') return res.status(401).json({ error: 'Unauthorized' }); next(); } catch(e) { res.status(500).json({ error: e.message }); } }
async function requireClient(req, res, next) { try { const t = bearer(req); await query(`delete from dashboard_sessions where expires_at is not null and expires_at < now()`); const r = await query(`select role, slug from dashboard_sessions where token=$1 and (expires_at is null or expires_at > now())`, [t]); if (!r.rowCount || !['admin','client'].includes(r.rows[0].role)) return res.status(401).json({ error: 'Unauthorized' }); req.authSession = r.rows[0]; next(); } catch(e) { res.status(500).json({ error: e.message }); } }

app.post('/api/auth/admin/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const r = await query(`select key, value from dashboard_auth where key in ('adminUsernameHash','adminPasswordHash')`);
  const auth = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  if (sha(username) !== auth.adminUsernameHash || sha(password) !== auth.adminPasswordHash) return res.status(401).json({ error: 'Username atau password salah' });
  const t = token(); await query(`insert into dashboard_sessions(token, role, expires_at) values($1,'admin', now() + interval '12 hours')`, [t]);
  res.json({ ok: true, token: t, role: 'admin' });
});
app.post('/api/auth/admin/password', requireAdmin, async (req, res) => {
  const current = String(req.body?.currentPassword || ''); const next = String(req.body?.newPassword || '');
  const username = String(req.body?.username || '').trim();
  if (next.length < 10) return res.status(400).json({ error: 'Password baru minimal 10 karakter' });
  const r = await query(`select value from dashboard_auth where key='adminPasswordHash'`);
  if (sha(current) !== r.rows[0]?.value) return res.status(401).json({ error: 'Password lama salah' });
  if (username) await query(`insert into dashboard_auth(key,value,updated_at) values('adminUsernameHash',$1,now()) on conflict(key) do update set value=excluded.value, updated_at=now()`, [JSON.stringify(sha(username))]);
  await query(`insert into dashboard_auth(key,value,updated_at) values('adminPasswordHash',$1,now()) on conflict(key) do update set value=excluded.value, updated_at=now()`, [JSON.stringify(sha(next))]);
  await query(`delete from dashboard_sessions`);
  res.json({ ok: true });
});
app.post('/api/auth/client/login', async (req, res) => {
  const slug = safeSlug(req.body?.slug); const pass = String(req.body?.password || '');
  const r = await query(`select slug, dashboard_token_hash from clients where slug=$1`, [slug]);
  if (!r.rowCount || !r.rows[0].dashboard_token_hash || r.rows[0].dashboard_token_hash !== sha(pass)) return res.status(401).json({ error: 'Login client salah' });
  const t = token(); await query(`insert into dashboard_sessions(token,role,slug,expires_at) values($1,'client',$2, now() + interval '12 hours')`, [t, slug]);
  res.json({ ok: true, token: t, role: 'client', slug });
});

app.get('/api/bot/status', requireClient, async (_req,res)=>res.json(await telegramBotState()));
app.get('/api/status', requireAdmin, async (_req, res) => {
  let service = await serviceState('openclaw-business.service');
  const r = await query(`select count(*)::int total, count(*) filter(where status='active')::int active from clients`);
  const db = await query(`select current_database() db, inet_server_addr()::text addr, inet_server_port() port`);
  res.json({ ok: true, service, db: 'supabase-postgres', supabase: db.rows[0], root: ROOT, clients: r.rows[0].total, activeClients: r.rows[0].active });
});
app.get('/api/clients', requireAdmin, async (_req, res) => { const r = await query(`select * from clients order by created_at desc`); res.json({ clients: r.rows.map(sanitizeClient) }); });
app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
  const service = await serviceState('openclaw-business.service');
  const rows = await query(`select * from clients order by created_at desc`);
  const items = [];
  for (const row of rows.rows) {
    const client = sanitizeClient(row); const slug = client.slug;
    let kb = ''; try { const k = await query(`select content from tenant_kb where slug=$1`, [slug]); kb = k.rows[0]?.content || ''; } catch {}
    const [pairing, identity, stats, diagnostics] = await Promise.all([tenantPairing(slug), readWhatsappIdentity(slug), tenantStats(slug), whatsappDiagnostics(slug)]);
    const kbScore = await syncClientRuntime(slug, { pairing, identity, stats, diagnostics, kb });
    items.push({ client, pairing, identity, stats, diagnostics, kbScore });
  }
  const total = items.length, active = items.filter(x=>x.client.status==='active').length, connected = items.filter(x=>x.pairing.status==='connected'||x.identity.paired).length;
  const inboundMessages = items.reduce((a,x)=>a+(x.stats.inboundMessages||0),0); const botReplies = items.reduce((a,x)=>a+(x.stats.botReplies||0),0); const unrepliedMessages = items.reduce((a,x)=>a+(x.stats.unrepliedMessages||0),0);
  const contacts = items.reduce((a,x)=>a+(x.stats.contacts||0),0); const repliedContacts = items.reduce((a,x)=>a+(x.stats.repliedContacts||0),0);
  const dailyMap = new Map(); for (const item of items) for (const d of item.stats.daily||[]) { const cur=dailyMap.get(d.date)||{date:d.date,inbound:0,replies:0,contacts:0}; cur.inbound+=d.inbound||0; cur.replies+=d.replies||0; cur.contacts+=d.contacts||0; dailyMap.set(d.date,cur); }
  await auditLog(null, 'admin', 'admin.dashboard.view', { clients: total, inboundMessages, botReplies });
  res.json({ ok:true, service, summary:{ total, active, connected, disconnected: total-connected, contacts, repliedContacts, inboundMessages, botReplies, unrepliedMessages, replyRate: inboundMessages?Math.min(100,Math.round(botReplies/inboundMessages*100)):0, avgKbScore: total?Math.round(items.reduce((a,x)=>a+x.kbScore,0)/total):0 }, daily:Array.from(dailyMap.values()).sort((a,b)=>a.date.localeCompare(b.date)).slice(-14), clients:items });
});
app.post('/api/clients', requireAdmin, async (req, res) => {
  const b = req.body || {}; const slug = safeSlug(b.slug || b.name); if (!slug) return res.status(400).json({ error: 'Nama/slug client wajib diisi' });
  if (isReservedNonProductionClient(slug, b.name || slug)) return res.status(400).json({ error: 'Nama/slug ini ditolak karena terlihat seperti data non-produksi. Pakai data bisnis asli.' });
  const clientPassword = b.clientPassword || crypto.randomBytes(5).toString('hex');
  try {
    const r = await query(`insert into clients(slug,name,owner_name,whatsapp,package,status,notes,dashboard_token_hash) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [slug,b.name||slug,b.ownerName||'',b.whatsapp||'','muy-business',b.status||'draft',b.notes||'',sha(clientPassword)]);
    const content = emptyKnowledgeBase();
    await query(`insert into tenant_kb(slug,content) values($1,$2)`, [slug, content]);
    await fs.mkdir(path.join(TENANTS, slug), { recursive: true }); await fs.writeFile(tenantFile(slug), content);
    await upsertPairingDb(slug, { status:'not_ready', qr:'', qrType:'text', note:'Client baru dibuat. WhatsApp belum pairing.', authDir:path.join(WA_CREDS, slug) });
    await auditLog(slug, 'admin', 'client.create', { name:b.name||slug });
    res.json({ ok: true, client: sanitizeClient(r.rows[0]), clientPassword });
  } catch(e) { if (String(e.code)==='23505') return res.status(409).json({ error: 'Client sudah ada' }); throw e; }
});
app.patch('/api/clients/:slug', requireAdmin, async (req, res) => {
  const slug = safeSlug(req.params.slug); const b = req.body || {}; const old = await query(`select * from clients where slug=$1`, [slug]); if (!old.rowCount) return res.status(404).json({ error: 'Client tidak ditemukan' });
  if (isReservedNonProductionClient(slug, b.name || old.rows[0].name)) return res.status(400).json({ error: 'Nama/slug ini ditolak karena terlihat seperti data non-produksi. Pakai data bisnis asli.' });
  const c = old.rows[0]; const passHash = b.clientPassword ? sha(b.clientPassword) : c.dashboard_token_hash;
  const r = await query(`update clients set name=$2, owner_name=$3, whatsapp=$4, package=$5, status=$6, notes=$7, dashboard_token_hash=$8, updated_at=now() where slug=$1 returning *`, [slug,b.name??c.name,b.ownerName??c.owner_name,b.whatsapp??c.whatsapp,'muy-business',b.status??c.status,b.notes??c.notes,passHash]);
  await auditLog(slug, 'admin', 'client.update');
  res.json({ ok: true, client: sanitizeClient(r.rows[0]) });
});
app.delete('/api/clients/:slug', requireAdmin, async (req, res) => { const slug=safeSlug(req.params.slug); const r=await query(`update clients set status='archived', archived_at=now(), updated_at=now() where slug=$1 returning *`, [slug]); if(!r.rowCount) return res.status(404).json({ error:'Client tidak ditemukan' }); await auditLog(slug, 'admin', 'client.archive'); res.json({ ok:true, client:sanitizeClient(r.rows[0]) }); });
app.get('/api/clients/:slug/kb', requireClient, async (req, res) => { const slug=safeSlug(req.params.slug); if(req.authSession.role==='client' && req.authSession.slug!==slug) return res.status(403).json({ error:'Forbidden' }); const r=await query(`select content from tenant_kb where slug=$1`, [slug]); if(!r.rowCount) return res.status(404).json({ error:'Knowledge base tidak ditemukan' }); res.json({ slug, content:r.rows[0].content }); });
app.put('/api/clients/:slug/kb', requireClient, async (req, res) => { const slug=safeSlug(req.params.slug); if(req.authSession.role==='client' && req.authSession.slug!==slug) return res.status(403).json({ error:'Forbidden' }); const content=String(req.body?.content||''); await query(`insert into tenant_kb(slug,content,updated_at) values($1,$2,now()) on conflict(slug) do update set content=excluded.content, updated_at=now()`, [slug,content]); await fs.mkdir(path.join(TENANTS, slug), { recursive:true }); await fs.writeFile(tenantFile(slug), content); await auditLog(slug, req.authSession.role, 'knowledge.save', { chars: content.length }); res.json({ ok:true }); });
app.get('/api/client/me', requireClient, async (req, res) => { const slug=req.authSession.role==='admin'?safeSlug(req.query.slug):req.authSession.slug; const r=await query(`select * from clients where slug=$1`, [slug]); if(!r.rowCount) return res.status(404).json({ error:'Client tidak ditemukan' }); res.json({ client:sanitizeClient(r.rows[0]) }); });
app.get('/api/clients/:slug/pairing', requireClient, async (req,res)=>{ const slug=safeSlug(req.params.slug); if(req.authSession.role==='client' && req.authSession.slug!==slug) return res.status(403).json({ error:'Forbidden' }); res.json(await tenantPairing(slug)); });
app.get('/api/clients/:slug/dashboard', requireClient, async (req,res)=>{ const slug=safeSlug(req.params.slug); if(req.authSession.role==='client' && req.authSession.slug!==slug) return res.status(403).json({ error:'Forbidden' }); const data=await buildClientDashboard(slug); if(!data) return res.status(404).json({ error:'Client tidak ditemukan' }); await auditLog(slug, req.authSession.role, 'dashboard.view'); res.json(data); });
app.post('/api/clients/:slug/pairing/:action', requireClient, async (req,res)=>{ const slug=safeSlug(req.params.slug); if(req.authSession.role==='client' && req.authSession.slug!==slug) return res.status(403).json({ error:'Forbidden' }); const action=req.params.action; await fs.mkdir(path.join(TENANTS, slug), { recursive:true }); if(action==='disconnect'){ try { waSockets.get(slug)?.end?.(); } catch {} waSockets.delete(slug); await updateWhatsappAccount(slug, false); await fs.rm(path.join(TENANTS, slug, 'whatsapp-connected'), { force:true }); await fs.rm(path.join(TENANTS, slug, 'qr.txt'), { force:true }); await fs.rm(path.join(TENANTS, slug, 'qr.png'), { force:true }); await fs.rm(path.join(WA_CREDS, slug), { recursive:true, force:true }); await upsertPairingDb(slug, { status:'not_ready', qr:'', qrType:'text', note:'WhatsApp diputuskan dari dashboard.', authDir:path.join(WA_CREDS, slug), disconnectedAt:new Date().toISOString() }); await auditLog(slug, req.authSession.role, 'whatsapp.disconnect'); await restartBusinessGateway(); return res.json({ ok:true, pairing: await tenantPairing(slug) }); } if(action==='refresh'){ const pairing=await startWhatsappPairing(slug); await auditLog(slug, req.authSession.role, 'whatsapp.refresh_qr'); return res.json({ ok:true, pairing }); } return res.status(400).json({ error:'Action invalid' }); });
app.post('/api/service/:action', requireAdmin, async (req, res) => { const action=req.params.action; if(!['restart','start','stop'].includes(action)) return res.status(400).json({ error:'Action invalid' }); try { await execFileP('systemctl',['--user',action,'openclaw-business.service'],{timeout:15000}); res.json({ ok:true }); } catch(e) { res.status(500).json({ error:(e.stderr||e.message||String(e)).slice(0,1000) }); } });

initDb().then(() => app.listen(PORT, '127.0.0.1', () => console.log(`Muy Business Dashboard (Supabase/Postgres): http://127.0.0.1:${PORT}`))).catch(err => { console.error('Dashboard DB init failed:', err); process.exit(1); });
