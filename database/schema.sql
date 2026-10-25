-- Еда на неделю: общая семейная база данных для Supabase
-- Запустите этот файл в Supabase Dashboard -> SQL Editor.
-- После запуска выполните отдельную команду из DATABASE.md, чтобы задать семейный код.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.family_access (
  id integer primary key check (id = 1),
  code_hash text not null
);

create table if not exists public.app_state (
  id text primary key check (id = 'family'),
  state jsonb not null default '{"checked":[],"votes":{},"menu":null,"groceries":null,"notificationTimes":["08:30"]}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.family_notification_log (
  slot text primary key,
  created_at timestamptz not null default now()
);

alter table public.family_access enable row level security;
alter table public.app_state enable row level security;
alter table public.family_notification_log enable row level security;

revoke all on table public.family_access from anon, authenticated;
revoke all on table public.app_state from anon, authenticated;
revoke all on table public.family_notification_log from anon, authenticated;

create or replace function public.get_family_state(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (
    select 1 from public.family_access
    where id = 1
      and code_hash = encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex')
  ) then
    raise exception 'Неверный семейный код';
  end if;

  return coalesce(
    (select state from public.app_state where id = 'family'),
    '{"checked":[],"votes":{},"menu":null,"groceries":null,"notificationTimes":["08:30"]}'::jsonb
  );
end;
$$;

create or replace function public.save_family_state(p_code text, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (
    select 1 from public.family_access
    where id = 1
      and code_hash = encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex')
  ) then
    raise exception 'Неверный семейный код';
  end if;

  insert into public.app_state (id, state, updated_at)
  values (
    'family',
    jsonb_build_object(
      'checked', case when jsonb_typeof(p_state->'checked') = 'array' then p_state->'checked' else '[]'::jsonb end,
      'votes', case when jsonb_typeof(p_state->'votes') = 'object' then p_state->'votes' else '{}'::jsonb end,
      'menu', case when jsonb_typeof(p_state->'menu') = 'array' then p_state->'menu' else 'null'::jsonb end,
      'groceries', case when jsonb_typeof(p_state->'groceries') = 'array' then p_state->'groceries' else 'null'::jsonb end,
      'notificationTimes', case when jsonb_typeof(p_state->'notificationTimes') = 'array' then p_state->'notificationTimes' else '["08:30"]'::jsonb end
    ),
    now()
  )
  on conflict (id) do update
    set state = excluded.state, updated_at = now();

  return (select state from public.app_state where id = 'family');
end;
$$;

revoke all on function public.get_family_state(text) from public;
revoke all on function public.save_family_state(text, jsonb) from public;
grant execute on function public.get_family_state(text) to anon, authenticated;
grant execute on function public.save_family_state(text, jsonb) to anon, authenticated;


-- Atomic one-time claim for each family reminder slot, to avoid duplicate Telegram messages.
create or replace function public.claim_family_notification(p_code text, p_slot text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  inserted_rows integer;
begin
  if not exists (
    select 1 from public.family_access
    where id = 1
      and code_hash = encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex')
  ) then
    raise exception 'Неверный семейный код';
  end if;

  insert into public.family_notification_log (slot)
  values (p_slot)
  on conflict (slot) do nothing;

  get diagnostics inserted_rows = row_count;
  return inserted_rows = 1;
end;
$$;

revoke all on function public.claim_family_notification(text, text) from public;
grant execute on function public.claim_family_notification(text, text) to anon, authenticated;

create or replace function public.release_family_notification(p_code text, p_slot text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (
    select 1 from public.family_access
    where id = 1
      and code_hash = encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex')
  ) then
    raise exception 'Неверный семейный код';
  end if;
  delete from public.family_notification_log where slot = p_slot;
end;
$$;

revoke all on function public.release_family_notification(text, text) from public;
grant execute on function public.release_family_notification(text, text) to anon, authenticated;
