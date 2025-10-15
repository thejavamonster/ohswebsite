# OHS Website - Reviews DB Migration

This project serves static pages and a small JSON-backed API using Express. Reviews were originally stored in `data/reviews.json`. You can now use a free managed Postgres via Supabase with a clean migration path.

## What changed

- Added `lib/reviewsStore.js`: data access layer that uses Supabase when configured, otherwise falls back to the existing JSON file.
- Added `scripts/supabase_schema.sql`: Postgres schema for `reviews` and `review_replies` tables.
- Added `scripts/migrate_reviews_to_supabase.js`: one-off importer from `data/reviews.json` to Supabase.
- Server routes in `server.js` now call the store abstraction, so no frontend changes are required.

## Set up Supabase (free tier)

1. Create a Supabase project (Region near you). Copy:
   - Project URL (e.g., https://xxxx.supabase.co)
   - Service Role key (Settings → API → Project API keys). Keep this secret.
2. In Supabase SQL Editor, run the SQL in `scripts/supabase_schema.sql` to create tables and indexes.

## Configure environment

Create a `.env` file in the project root:

```
SUPABASE_URL=your-project-url
SUPABASE_SERVICE_KEY=your-service-role-key

# Optional email providers (already used by auth codes)
# RESEND_API_KEY=
# RESEND_FROM=
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM=
```

Notes:
- When `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set, the API reads/writes reviews in Postgres. If they are absent, it continues to use `data/reviews.json`.
- The Service Role key is only for server-side usage. Do NOT expose it to the browser.

## Install dependencies

```
npm install
```

## Migrate existing reviews to Supabase

Run the importer (safe to re-run; it upserts by id):

```
npm run migrate:reviews
```

This will read `data/reviews.json` and upsert into `public.reviews` and `public.review_replies`.

## Verify DB connectivity (optional)

```
npm run db:verify
```

This prints a small summary of counts per course from the DB.

## Run the server

```
npm start
```

If Supabase env vars are set, the API uses Postgres; otherwise it falls back to the JSON file.

## Alternative free options

If you prefer not to use Supabase:
- Neon (serverless Postgres) + `pg` client
- Railway (Postgres)
- Render (Postgres)
- MongoDB Atlas (NoSQL; would require a different data model)

The current implementation targets Supabase Postgres. Switching to a plain Postgres URL would require a small adapter in `lib/reviewsStore.js` using `pg` instead of `@supabase/supabase-js`.
