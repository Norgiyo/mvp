-- Run once against the current Supabase database.
-- Updates raffle entries so each user can participate up to 10 times per raffle.

do $$
begin
  if to_regclass('public.raffle_entries') is null then
    return;
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.raffle_entries'::regclass
      and conname = 'raffle_entries_raffle_id_user_id_key'
  ) then
    alter table public.raffle_entries
      drop constraint raffle_entries_raffle_id_user_id_key;
  end if;
end $$;

create index if not exists raffle_entries_raffle_user_idx
  on public.raffle_entries (raffle_id, user_id);
