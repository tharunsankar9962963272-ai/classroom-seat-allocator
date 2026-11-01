-- Classroom Seat Allocator — database schema
-- Run this once in the Supabase SQL Editor. It is idempotent.

create extension if not exists pgcrypto;

create table if not exists public.allocations (
  id                    uuid primary key default gen_random_uuid(),
  students              integer     not null check (students >= 0),
  seats_per_row         integer     not null check (seats_per_row > 0),
  rows_required         integer     not null check (rows_required >= 0),
  empty_seats_last_row  integer     not null check (empty_seats_last_row >= 0),
  created_at            timestamptz not null default now()
);

create index if not exists allocations_created_at_idx
  on public.allocations (created_at desc);

alter table public.allocations enable row level security;

drop policy if exists "allocations are readable by everyone" on public.allocations;
create policy "allocations are readable by everyone"
  on public.allocations
  for select
  to anon, authenticated
  using (true);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'allocations'
  ) then
    alter publication supabase_realtime add table public.allocations;
  end if;
end
$$;

alter table public.allocations replica identity full;