-- 3D Soccer List initial schema
-- Run this in Supabase SQL Editor for a NEW dedicated project.
-- Never expose the service_role key in browser code.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null,
  bio text not null default '' check (char_length(bio) <= 240),
  avatar_url text,
  banner_url text,
  points integer not null default 0 check (points between 0 and 5000),
  division text not null default 'Beginner',
  wins integer not null default 0,
  losses integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.match_submissions (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid not null references public.profiles(id) on delete cascade,
  opponent_username text not null,
  submitter_score integer not null check (submitter_score between 0 and 99),
  opponent_score integer not null check (opponent_score between 0 and 99),
  evidence_url text not null,
  notes text check (char_length(notes) <= 500),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewer_id uuid references auth.users(id),
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check (submitter_score <> opponent_score)
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.match_submissions(id),
  player_id uuid not null references public.profiles(id),
  opponent_username text not null,
  player_score integer not null,
  opponent_score integer not null,
  points_change integer not null,
  result text not null check (result in ('win','loss')),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql
as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

-- Create a profile automatically after signup. The username comes from signup metadata.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare requested_username text;
begin
  requested_username := lower(coalesce(new.raw_user_meta_data->>'username', 'player_' || substr(new.id::text, 1, 8)));
  if requested_username !~ '^[a-z0-9_]{3,24}$' then
    requested_username := 'player_' || substr(new.id::text, 1, 8);
  end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, requested_username, requested_username);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.admins enable row level security;
alter table public.match_submissions enable row level security;
alter table public.matches enable row level security;

-- Public profile/ranking reads. Users may only edit cosmetic fields on their own profile.
drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable" on public.profiles for select using (true);
drop policy if exists "Users update own cosmetic profile" on public.profiles;
create policy "Users update own cosmetic profile" on public.profiles for update
using (auth.uid() = id) with check (auth.uid() = id);

-- No browser user can insert/update/delete admin membership.
drop policy if exists "Admins can read admin list" on public.admins;
create policy "Admins can read admin list" on public.admins for select using (public.is_admin());

-- A player may create and read their own submissions. Only admins may review them.
drop policy if exists "Players create own submissions" on public.match_submissions;
create policy "Players create own submissions" on public.match_submissions for insert
with check (auth.uid() = submitted_by);
drop policy if exists "Players read own submissions" on public.match_submissions;
create policy "Players read own submissions" on public.match_submissions for select
using (auth.uid() = submitted_by or public.is_admin());
drop policy if exists "Admins review submissions" on public.match_submissions;
create policy "Admins review submissions" on public.match_submissions for update
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Matches are publicly readable" on public.matches;
create policy "Matches are publicly readable" on public.matches for select using (true);
-- No public insert/update/delete policy for matches or score fields on profiles.

create or replace view public.public_ranking as
select id, username, display_name, points, division, wins, losses, avatar_url
from public.profiles;

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.public_ranking, public.matches to anon, authenticated;
grant update (display_name, bio, avatar_url, banner_url) on public.profiles to authenticated;
grant select, insert on public.match_submissions to authenticated;
grant update on public.match_submissions to authenticated;
grant select on public.admins to authenticated;

-- IMPORTANT NEXT STEPS:
-- 1. Add your own auth user id to public.admins from the Supabase SQL Editor:
--    insert into public.admins (user_id) values ('YOUR-AUTH-USER-UUID');
-- 2. Build a trusted server-side approval function (Supabase Edge Function/RPC).
--    It must validate opponent division and calculate points server-side before changing
--    profiles and inserting a match. Do not approve matches by editing the browser UI.
-- 3. Confirm your exact 4v4 participant/result verification rules before enabling scoring.


-- SECURITY HARDENING
-- Players may submit only match details. They cannot set review status or reviewer fields.
revoke insert, update on public.match_submissions from authenticated;
grant insert (submitted_by, opponent_username, submitter_score, opponent_score, evidence_url, notes)
  on public.match_submissions to authenticated;
grant update (status, reviewer_id, review_note, reviewed_at)
  on public.match_submissions to authenticated;
-- The update grant is still protected by the "Admins review submissions" RLS policy.
-- Players cannot create matches or directly change points.
revoke insert, update, delete on public.matches from anon, authenticated;
revoke update on public.profiles from anon, authenticated;
grant update (display_name, bio, avatar_url, banner_url) on public.profiles to authenticated;
