-- 3D Soccer List staff roles (migration 006)
-- Run in Supabase SQL Editor after the existing schema and migrations.
-- Roles are stored on profiles but cannot be changed by ordinary users.

alter table public.profiles
  add column if not exists staff_role text not null default 'player'
  check (staff_role in ('player','owner','admin','moderator'));

-- Register the existing site owner account. This intentionally targets the
-- established username, not a user-supplied UUID.
update public.profiles
set staff_role = 'owner'
where lower(username) = 'yuridakbrada';

-- Keep the legacy admins table compatible with the existing admin UI and
-- grant the owner the same submit-review access.
insert into public.admins(user_id)
select id from public.profiles where lower(username) = 'yuridakbrada'
on conflict (user_id) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and staff_role in ('owner','admin')
  ) or exists (
    select 1 from public.admins where user_id = auth.uid()
  );
$$;

-- Publish staff role to the public leaderboard.
drop view if exists public.public_ranking;
create view public.public_ranking as
select id, username, display_name, points, division, wins, losses, avatar_url, staff_role
from public.profiles;

grant select on public.public_ranking to anon, authenticated;
grant select on public.profiles to anon, authenticated;
revoke update (staff_role) on public.profiles from anon, authenticated;

-- Only trusted database operators should assign or change staff roles.
