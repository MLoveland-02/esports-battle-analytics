# Esports Battle Analytics

FIFA esports analytics dashboard backed by Supabase.

## Structure

```
.
├── scraper/     Node.js scraper scripts
├── dashboard/   plain HTML/CSS/JS frontend
├── sql/         SQL migration files
├── .env         Supabase credentials (gitignored)
└── .env.example template for .env
```

## Setup

1. Clone the repo and install scraper deps:
   ```
   cd scraper && npm install
   ```
2. Copy `.env.example` to `.env` and fill in your Supabase URL and anon key.
3. Apply the schema to your Supabase project (see below).

## Database

Schema lives in [`sql/schema.sql`](sql/schema.sql). Tables:

- `tournaments` — tournament metadata
- `players` — player roster
- `matches` — individual match results
- `player_stats` — per-player aggregates
- `h2h_stats` — head-to-head aggregates between two players
- `scrape_log` — scraper run history

### Applying the schema

The anon key cannot run DDL. Pick one:

**Supabase SQL Editor (easiest):** open the project dashboard → SQL Editor → paste contents of `sql/schema.sql` → Run.

**Supabase CLI:**
```
supabase login
supabase link --project-ref mdvocpljvyhcrthoqysm
supabase db push
```

**psql:**
```
psql "postgresql://postgres:[PASSWORD]@db.mdvocpljvyhcrthoqysm.supabase.co:5432/postgres" -f sql/schema.sql
```

## Frontend

Open `dashboard/index.html` in a browser, or serve with any static server. The dashboard auto-refreshes every 5 minutes; sections render against Supabase directly using the anon key embedded in the file.

## Scheduled scraping (GitHub Actions)

`.github/workflows/scrape.yml` runs the scraper every 5 minutes. Before pushing, add two secrets to your GitHub repo:

1. Open the repo on GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Add each of the following:

   | Name                | Value                                                          |
   | ------------------- | -------------------------------------------------------------- |
   | `SUPABASE_URL`      | `https://<project-ref>.supabase.co`                            |
   | `SUPABASE_ANON_KEY` | the anon public key from Supabase → Settings → API             |

3. Push the workflow. You can also trigger it manually from the **Actions** tab → *scrape* → **Run workflow**.

Notes:

- GitHub's scheduled cron is best-effort and runs are commonly delayed under load — `*/5 * * * *` should be read as "approximately every 5 minutes."
- Scheduled workflows on a repo with no recent commits get auto-disabled after ~60 days of inactivity. Push any commit to re-arm.
- For a server-side scraper you'd normally use the `service_role` key. We use the anon key here because RLS is disabled on the data tables; flip to `service_role` (and re-enable RLS) for a hardened setup.
