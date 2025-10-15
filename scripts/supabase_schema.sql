-- Supabase schema for migrating JSON reviews to Postgres
-- Create tables
create table if not exists public.reviews (
  id text primary key,
  course_id text not null,
  rating integer null check (rating between 1 and 5),
  author text null,
  text text not null,
  created_at timestamptz not null default now(),
  status text not null default 'published',
  upvotes integer not null default 0,
  downvotes integer not null default 0,
  poster_email text null,
  poster_sid text null
);

create table if not exists public.review_replies (
  id text primary key,
  review_id text not null references public.reviews(id) on delete cascade,
  author text null,
  text text not null,
  created_at timestamptz not null default now(),
  poster_email text null,
  poster_sid text null
);

-- Helpful indexes
create index if not exists idx_reviews_course_created on public.reviews(course_id, created_at desc);
create index if not exists idx_replies_review_created on public.review_replies(review_id, created_at desc);

-- RLS (optional): disable for simplicity unless you plan to expose anon reads/writes
-- alter table public.reviews enable row level security;
-- alter table public.review_replies enable row level security;
-- You can create policies later for anon read-only and service key read/write.
