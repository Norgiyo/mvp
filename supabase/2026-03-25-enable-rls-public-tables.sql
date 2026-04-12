-- Run once against the current Supabase database.
-- Installs the same auto-RLS protection used in schema.sql for future tables.

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
