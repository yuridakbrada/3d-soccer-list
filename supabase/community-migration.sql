-- 3D Soccer List community foundation (migration 002)
-- Run AFTER schema.sql in Supabase SQL Editor.
-- Creates private conversations, groups, clans, clan ranking and livestream links.
-- All privileged membership changes go through SECURITY DEFINER RPCs.

create extension if not exists pgcrypto;

-- ---------- Conversations and messages ----------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  conversation_type text not null check (conversation_type in ('direct','group')),
  title text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((conversation_type = 'direct' and title is null) or
         (conversation_type = 'group' and title is not null and char_length(title) between 1 and 60))
);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  member_role text not null default 'member' check (member_role in ('owner','member')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

create or replace function public.is_conversation_member(p_conversation_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.conversation_participants
    where conversation_id = p_conversation_id and user_id = auth.uid()
  );
$$;

create or replace function public.create_conversation(p_member_ids uuid[], p_title text default null)
returns uuid language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_type text;
  v_members uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select array_agg(distinct u.user_id) into v_members
  from unnest(coalesce(p_member_ids, array[]::uuid[]) || array[auth.uid()]) as u(user_id);
  if cardinality(v_members) < 2 or cardinality(v_members) > 20 then
    raise exception 'A conversation must have 2 to 20 participants';
  end if;
  if exists (select 1 from unnest(v_members) as u(user_id) left join public.profiles p on p.id=u.user_id where p.id is null) then
    raise exception 'One or more players do not exist';
  end if;
  v_type := case when cardinality(v_members)=2 and nullif(trim(p_title),'') is null then 'direct' else 'group' end;
  if v_type='group' and (nullif(trim(p_title),'') is null or char_length(trim(p_title))>60) then
    raise exception 'Group name must contain 1 to 60 characters';
  end if;
  insert into public.conversations(conversation_type,title,created_by)
  values (v_type, case when v_type='group' then trim(p_title) else null end, auth.uid())
  returning id into v_id;
  insert into public.conversation_participants(conversation_id,user_id,member_role)
  select v_id, u.user_id, case when u.user_id=auth.uid() then 'owner' else 'member' end from unnest(v_members) as u(user_id);
  return v_id;
end;
$$;

create or replace function public.add_conversation_participant(p_conversation_id uuid, p_user_id uuid)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.conversation_participants
    where conversation_id=p_conversation_id and user_id=auth.uid() and member_role='owner'
  ) then raise exception 'Only the group owner can add participants'; end if;
  if (select conversation_type from public.conversations where id=p_conversation_id) <> 'group' then
    raise exception 'Participants can only be added to groups';
  end if;
  if (select count(*) from public.conversation_participants where conversation_id=p_conversation_id) >= 20 then
    raise exception 'Group is full';
  end if;
  insert into public.conversation_participants(conversation_id,user_id)
  values (p_conversation_id,p_user_id) on conflict do nothing;
end;
$$;

alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Participants read conversations" on public.conversations;
create policy "Participants read conversations" on public.conversations for select
using (public.is_conversation_member(id));
drop policy if exists "Participants read membership" on public.conversation_participants;
create policy "Participants read membership" on public.conversation_participants for select
using (public.is_conversation_member(conversation_id));
drop policy if exists "Participants read messages" on public.messages;
create policy "Participants read messages" on public.messages for select
using (public.is_conversation_member(conversation_id));
drop policy if exists "Members send messages" on public.messages;
create policy "Members send messages" on public.messages for insert
with check (sender_id=auth.uid() and public.is_conversation_member(conversation_id));

grant select on public.conversations, public.conversation_participants, public.messages to authenticated;
grant insert on public.messages to authenticated;
revoke insert, update, delete on public.conversations, public.conversation_participants from anon, authenticated;
revoke update, delete on public.messages from anon, authenticated;
revoke all on function public.is_conversation_member(uuid) from public, anon;
grant execute on function public.is_conversation_member(uuid) to authenticated;
revoke all on function public.create_conversation(uuid[],text) from public, anon;
revoke all on function public.add_conversation_participant(uuid,uuid) from public, anon;
grant execute on function public.create_conversation(uuid[],text) to authenticated;
grant execute on function public.add_conversation_participant(uuid,uuid) to authenticated;

-- ---------- Clans ----------
create table if not exists public.clans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 32),
  slug text not null unique,
  description text not null default '' check (char_length(description)<=500),
  logo_url text,
  banner_url text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.clan_members (
  clan_id uuid not null references public.clans(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  member_role text not null default 'member' check (member_role in ('leader','vice_leader','member')),
  joined_at timestamptz not null default now(),
  primary key (clan_id,user_id),
  unique (user_id)
);

create or replace function public.enforce_clan_roster()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
declare roster_count integer;
begin
  perform 1 from public.clans where id=new.clan_id for update;
  select count(*) into roster_count from public.clan_members where clan_id=new.clan_id;
  if roster_count >= 4 then raise exception 'A clan can have at most 4 players'; end if;
  if new.member_role in ('leader','vice_leader') and exists (
    select 1 from public.clan_members where clan_id=new.clan_id and member_role=new.member_role
  ) then raise exception 'This clan role is already assigned'; end if;
  return new;
end;
$$;
drop trigger if exists clan_roster_limit on public.clan_members;
create trigger clan_roster_limit before insert on public.clan_members
for each row execute function public.enforce_clan_roster();

create table if not exists public.clan_join_requests (
  id uuid primary key default gen_random_uuid(),
  clan_id uuid not null references public.clans(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  unique (clan_id,user_id)
);

create or replace function public.create_clan(p_name text, p_description text default '')
returns uuid language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_id uuid; v_slug text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.clan_members where user_id=auth.uid()) then
    raise exception 'You already belong to a clan';
  end if;
  if char_length(trim(p_name)) not between 3 and 32 then raise exception 'Clan name must contain 3 to 32 characters'; end if;
  if char_length(coalesce(p_description,''))>500 then raise exception 'Description is too long'; end if;
  v_slug := lower(regexp_replace(trim(p_name),'[^a-zA-Z0-9]+','-','g')) || '-' || substr(gen_random_uuid()::text,1,8);
  insert into public.clans(name,slug,description,created_by)
  values(trim(p_name),v_slug,coalesce(p_description,''),auth.uid()) returning id into v_id;
  insert into public.clan_members(clan_id,user_id,member_role) values(v_id,auth.uid(),'leader');
  return v_id;
end;
$$;

create or replace function public.request_clan_join(p_clan_id uuid)
returns uuid language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists(select 1 from public.clan_members where user_id=auth.uid()) then
    raise exception 'You already belong to a clan';
  end if;
  insert into public.clan_join_requests(clan_id,user_id)
  values(p_clan_id,auth.uid())
  on conflict(clan_id,user_id) do update set status='pending',created_at=now(),reviewed_at=null,reviewed_by=null
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.review_clan_join_request(p_request_id uuid,p_accept boolean)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_request public.clan_join_requests%rowtype;
begin
  select r.* into v_request from public.clan_join_requests r
  join public.clan_members m on m.clan_id=r.clan_id
  where r.id=p_request_id and m.user_id=auth.uid() and m.member_role in ('leader','vice_leader')
  for update of r;
  if not found then raise exception 'Only clan leadership can review requests'; end if;
  if v_request.status <> 'pending' then raise exception 'Request already reviewed'; end if;
  if p_accept then
    if exists(select 1 from public.clan_members where user_id=v_request.user_id) then
      raise exception 'This player already belongs to a clan';
    end if;
    insert into public.clan_members(clan_id,user_id,member_role) values(v_request.clan_id,v_request.user_id,'member');
  end if;
  update public.clan_join_requests set status=case when p_accept then 'accepted' else 'rejected' end,
    reviewed_at=now(),reviewed_by=auth.uid() where id=p_request_id;
end;
$$;

create or replace function public.leave_clan()
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_member public.clan_members%rowtype;
begin
  select * into v_member from public.clan_members where user_id=auth.uid() for update;
  if not found then raise exception 'You are not in a clan'; end if;
  if v_member.member_role='leader' then raise exception 'Leader must transfer leadership before leaving'; end if;
  delete from public.clan_members where clan_id=v_member.clan_id and user_id=auth.uid();
end;
$$;

create or replace function public.transfer_clan_leadership(p_new_leader uuid)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_clan uuid;
begin
  select clan_id into v_clan from public.clan_members
  where user_id=auth.uid() and member_role='leader' for update;
  if not found then raise exception 'Only the leader can transfer leadership'; end if;
  if not exists(select 1 from public.clan_members where clan_id=v_clan and user_id=p_new_leader) then
    raise exception 'New leader must already be a clan member';
  end if;
  update public.clan_members set member_role='member' where clan_id=v_clan and user_id=auth.uid();
  update public.clan_members set member_role='leader' where clan_id=v_clan and user_id=p_new_leader;
end;
$$;

alter table public.clans enable row level security;
alter table public.clan_members enable row level security;
alter table public.clan_join_requests enable row level security;

drop policy if exists "Clans are public" on public.clans;
create policy "Clans are public" on public.clans for select using (true);
drop policy if exists "Clan rosters are public" on public.clan_members;
create policy "Clan rosters are public" on public.clan_members for select using (true);
drop policy if exists "Leadership reads join requests" on public.clan_join_requests;
create policy "Leadership reads join requests" on public.clan_join_requests for select
using (user_id=auth.uid() or exists(
  select 1 from public.clan_members m where m.clan_id=clan_join_requests.clan_id
  and m.user_id=auth.uid() and m.member_role in ('leader','vice_leader')
));

grant select on public.clans, public.clan_members, public.clan_join_requests to anon, authenticated;
revoke insert, update, delete on public.clans, public.clan_members, public.clan_join_requests from anon, authenticated;
revoke all on function public.create_clan(text,text) from public, anon;
revoke all on function public.request_clan_join(uuid) from public, anon;
revoke all on function public.review_clan_join_request(uuid,boolean) from public, anon;
revoke all on function public.leave_clan() from public, anon;
revoke all on function public.transfer_clan_leadership(uuid) from public, anon;
grant execute on function public.create_clan(text,text) to authenticated;
grant execute on function public.request_clan_join(uuid) to authenticated;
grant execute on function public.review_clan_join_request(uuid,boolean) to authenticated;
grant execute on function public.leave_clan() to authenticated;
grant execute on function public.transfer_clan_leadership(uuid) to authenticated;

create or replace view public.clan_ranking as
select c.id,c.name,c.slug,c.description,c.logo_url,c.banner_url,
       count(cm.user_id)::integer as member_count,
       coalesce(sum(p.points),0)::bigint as points
from public.clans c
left join public.clan_members cm on cm.clan_id=c.id
left join public.profiles p on p.id=cm.user_id
group by c.id;
grant select on public.clan_ranking to anon, authenticated;

-- ---------- Player livestream links ----------
create table if not exists public.player_streams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in ('youtube','twitch','kick')),
  url text not null check (
    (platform='youtube' and url ~* '^https?://(www\.)?(youtube\.com|youtu\.be)/') or
    (platform='twitch' and url ~* '^https?://(www\.)?twitch\.tv/') or
    (platform='kick' and url ~* '^https?://(www\.)?kick\.com/')
  ),
  created_at timestamptz not null default now(),
  unique(user_id,platform)
);
alter table public.player_streams enable row level security;
drop policy if exists "Stream links are public" on public.player_streams;
create policy "Stream links are public" on public.player_streams for select using (true);
drop policy if exists "Players manage own stream links" on public.player_streams;
create policy "Players manage own stream links" on public.player_streams for all
using (auth.uid()=user_id) with check (auth.uid()=user_id);
grant select on public.player_streams to anon, authenticated;
grant insert, update, delete on public.player_streams to authenticated;

-- Publish messages for Supabase Realtime. Safe to run more than once.
do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
