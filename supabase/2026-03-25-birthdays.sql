alter table if exists users
  add column if not exists birthday_md text;

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

create table if not exists birthday_gifts (
  birthday_user_id bigint not null references users (telegram_id) on delete cascade,
  giver_user_id bigint not null references users (telegram_id) on delete cascade,
  birthday_date date not null,
  created_at timestamptz not null default now(),
  primary key (birthday_user_id, giver_user_id, birthday_date)
);

create index if not exists birthday_gifts_giver_date_idx
  on birthday_gifts (giver_user_id, birthday_date desc);

alter table if exists birthday_gifts enable row level security;
alter table if exists birthday_gifts force row level security;
drop policy if exists deny_all on birthday_gifts;
create policy deny_all on birthday_gifts
for all to anon, authenticated using (false) with check (false);
