-- Run once against the current Supabase database after cleaning duplicate active raffles.
-- Prevents having more than one active raffle at the same time.

create unique index if not exists raffles_single_active_idx
  on public.raffles (status)
  where status = 'active';
