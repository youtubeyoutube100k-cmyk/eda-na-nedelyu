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
  state jsonb not null default '{"checked":[],"votes":{}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.family_access enable row level security;
alter table public.app_state enable row level security;

revoke all on table public.family_access from anon, authenticated;
revoke all on table public.app_state from anon, authenticated;

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
    '{"checked":[],"votes":{}}'::jsonb
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
      'checked', coalesce(p_state->'checked', '[]'::jsonb),
      'votes', coalesce(p_state->'votes', '{}'::jsonb)
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
