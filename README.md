# Muy Business

Dashboard operasional untuk bot Telegram `@businessmuy_bot` dan tenant WhatsApp client.

## Isi Project

- `dashboard/server.js` - backend dashboard Express + PostgreSQL/Supabase.
- `dashboard/public/index.html` - frontend dashboard admin/client.
- `dashboard/package.json` - dependency dashboard.
- `bin/start-openclaw-business.sh` - helper start service.
- `tools/muy-db-proxy.js` - helper/proxy database.
- `supabase-schema.sql` - SQL lengkap untuk Supabase Cloud SQL Editor.

## Setup Supabase Cloud

1. Buat project Supabase Cloud.
2. Buka SQL Editor.
3. Paste semua isi `supabase-schema.sql`.
4. Run.
5. Ambil database connection string PostgreSQL dari Supabase.
6. Set env backend:

```bash
export MUY_DATABASE_URL="postgresql://..."
export MUY_DASHBOARD_PORT=18880
```

## Login Awal Dashboard

- Username: `admin`
- Password: `admin12345`

Setelah login, langsung ganti dari menu Settings.
Username dan password admin/client tidak disimpan di frontend. Database menyimpan hash dan session token.

## Catatan Keamanan

Jangan commit file `.env`, credential OpenClaw, session WhatsApp, token, database dump pribadi, atau file runtime.
