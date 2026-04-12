create extension if not exists pgcrypto;

create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists users (
  telegram_id bigint primary key,
  username text,
  first_name text,
  birthday_md text,
  special_title text,
  balance integer not null default 0,
  total_earned integer not null default 0,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at
before update on users
for each row execute function set_updated_at();

alter table if exists users
  add column if not exists birthday_md text;

alter table if exists users
  add column if not exists special_title text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_birthday_md_format_chk'
      and conrelid = 'public.users'::regclass
  ) then
    alter table users
      add constraint users_birthday_md_format_chk
      check (
        birthday_md is null
        or birthday_md ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      );
  end if;
end $$;

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references users (telegram_id) on delete cascade,
  type text not null,
  amount integer not null,
  description text not null,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_created_idx
  on transactions (user_id, created_at desc);

create table if not exists ad_claims (
  token text primary key,
  event_id text not null,
  user_id bigint not null references users (telegram_id) on delete cascade,
  ymid text not null unique,
  sdk_zone_id text not null,
  reward_amount integer not null,
  request_var text not null default 'rewarded_ad',
  status text not null default 'pending',
  frontend_resolved_at timestamptz null,
  frontend_failed_at timestamptz null,
  frontend_error text null,
  postback_received_at timestamptz null,
  rewarded_at timestamptz null,
  last_event_type text null,
  last_reward_event_type text null,
  last_estimated_price numeric(12,6) null,
  last_zone_id text null,
  last_sub_zone_id text null,
  last_telegram_id text null,
  last_postback jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists ad_claims_user_idx on ad_claims (user_id, created_at desc);
create index if not exists ad_claims_ymid_idx on ad_claims (ymid);

create table if not exists raffles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  prize_amount integer not null,
  entry_cost integer not null,
  status text not null default 'active',
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists raffles_single_active_idx
  on raffles (status)
  where status = 'active';

create table if not exists raffle_entries (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references raffles (id) on delete cascade,
  user_id bigint not null references users (telegram_id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists raffle_entries_raffle_user_idx
  on raffle_entries (raffle_id, user_id);

create table if not exists public_stats (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

drop trigger if exists public_stats_set_updated_at on public_stats;
create trigger public_stats_set_updated_at
before update on public_stats
for each row execute function set_updated_at();

create table if not exists daily_claims (
  user_id bigint not null references users (telegram_id) on delete cascade,
  claim_date date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, claim_date)
);

create table if not exists drop_claims (
  drop_id text not null,
  user_id bigint not null references users (telegram_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (drop_id, user_id)
);

create table if not exists fraud_logs (
  id uuid primary key default gen_random_uuid(),
  user_id bigint null references users (telegram_id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists birthday_gifts (
  birthday_user_id bigint not null references users (telegram_id) on delete cascade,
  giver_user_id bigint not null references users (telegram_id) on delete cascade,
  birthday_date date not null,
  created_at timestamptz not null default now(),
  primary key (birthday_user_id, giver_user_id, birthday_date)
);

create index if not exists birthday_gifts_giver_date_idx
  on birthday_gifts (giver_user_id, birthday_date desc);

-- ────────────────────────────────────────────────────────────────
-- Row Level Security
-- Every table: RLS enabled + forced + explicit deny-all policy.
-- Backend uses direct postgres connection → bypasses RLS.
-- ────────────────────────────────────────────────────────────────

do $$ declare t text; begin
  foreach t in array array[
    'users','transactions','ad_claims',
    'raffles','raffle_entries','public_stats',
    'daily_claims',
    'drop_claims','fraud_logs',
    'birthday_gifts'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('drop policy if exists deny_all on public.%I', t);
    execute format(
      'create policy deny_all on public.%I '
      'for all to anon, authenticated using (false) with check (false)', t
    );
  end loop;
end $$;

create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name is null or cmd.schema_name <> 'public' then
      continue;
    end if;

    begin
      execute format('alter table if exists %s enable row level security', cmd.object_identity);
      execute format('alter table if exists %s force row level security', cmd.object_identity);
      execute format('drop policy if exists deny_all on %s', cmd.object_identity);
      execute format(
        'create policy deny_all on %s '
        'for all to anon, authenticated using (false) with check (false)',
        cmd.object_identity
      );
    exception
      when others then
        raise log 'rls_auto_enable: failed to secure %', cmd.object_identity;
    end;
  end loop;
end;
$$;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function public.rls_auto_enable();

insert into public_stats (key, value)
values ('fondo', '0')
on conflict (key) do nothing;
