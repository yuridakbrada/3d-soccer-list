-- 3D Soccer List community features migration 003
-- Run AFTER schema.sql and community-migration.sql.
-- Adds friendship-based DM privacy and public match-history access.

alter table public.profiles
  add column if not exists dm_policy text not null default 'everyone'
  check (dm_policy in ('nobody','friends','everyone'));

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(requester_id, addressee_id),
  check(requester_id <> addressee_id)
);
create index if not exists friend_requests_addressee_status_idx
  on public.friend_requests(addressee_id,status,created_at desc);

alter table public.friend_requests enable row level security;
drop policy if exists "Users read their friend requests" on public.friend_requests;
create policy "Users read their friend requests" on public.friend_requests
for select to authenticated
using (auth.uid()=requester_id or auth.uid()=addressee_id);

create or replace function public.are_friends(p_user_a uuid,p_user_b uuid)
returns boolean language sql stable security definer
set search_path=public,pg_temp
as $$
  select exists(
    select 1 from public.friend_requests
    where status='accepted'
      and ((requester_id=p_user_a and addressee_id=p_user_b)
        or (requester_id=p_user_b and addressee_id=p_user_a))
  );
$$;

create or replace function public.send_friend_request(p_user_id uuid)
returns uuid language plpgsql security definer
set search_path=public,pg_temp
as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_user_id=auth.uid() then raise exception 'You cannot add yourself'; end if;
  if not exists(select 1 from public.profiles where id=p_user_id) then raise exception 'Player not found'; end if;
  if public.are_friends(auth.uid(),p_user_id) then raise exception 'You are already friends'; end if;
  insert into public.friend_requests(requester_id,addressee_id,status)
  values(auth.uid(),p_user_id,'pending')
  on conflict(requester_id,addressee_id)
  do update set status='pending',updated_at=now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.respond_friend_request(p_request_id uuid,p_accept boolean)
returns void language plpgsql security definer
set search_path=public,pg_temp
as $$
begin
  update public.friend_requests
  set status=case when p_accept then 'accepted' else 'rejected' end,updated_at=now()
  where id=p_request_id and addressee_id=auth.uid() and status='pending';
  if not found then raise exception 'Friend request not found or already handled'; end if;
end;
$$;

-- Replace the original conversation creator with a version that enforces DM policy.
create or replace function public.create_conversation(p_member_ids uuid[],p_title text default null)
returns uuid language plpgsql security definer
set search_path=public,pg_temp
as $$
declare
  v_id uuid;
  v_type text;
  v_members uuid[];
  v_other uuid;
  v_policy text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select array_agg(distinct u.user_id) into v_members
  from unnest(coalesce(p_member_ids,array[]::uuid[]) || array[auth.uid()]) as u(user_id);
  if cardinality(v_members)<2 or cardinality(v_members)>20 then
    raise exception 'A conversation must have 2 to 20 participants';
  end if;
  if exists(select 1 from unnest(v_members) as u(user_id)
    left join public.profiles p on p.id=u.user_id where p.id is null) then
    raise exception 'One or more players do not exist';
  end if;
  v_type:=case when cardinality(v_members)=2 and nullif(trim(p_title),'') is null then 'direct' else 'group' end;
  if v_type='group' and (nullif(trim(p_title),'') is null or char_length(trim(p_title))>60) then
    raise exception 'Group name must contain 1 to 60 characters';
  end if;
  if v_type='direct' then
    select u.user_id into v_other from unnest(v_members) as u(user_id) where u.user_id<>auth.uid();
    select dm_policy into v_policy from public.profiles where id=v_other;
    if v_policy='nobody' then raise exception 'This player is not accepting direct messages'; end if;
    if v_policy='friends' and not public.are_friends(auth.uid(),v_other) then
      raise exception 'This player only accepts messages from friends';
    end if;
  end if;
  insert into public.conversations(conversation_type,title,created_by)
  values(v_type,case when v_type='group' then trim(p_title) else null end,auth.uid())
  returning id into v_id;
  insert into public.conversation_participants(conversation_id,user_id,member_role)
  select v_id,u.user_id,case when u.user_id=auth.uid() then 'owner' else 'member' end
  from unnest(v_members) as u(user_id);
  return v_id;
end;
$$;

create or replace view public.public_player_matches as
select id,player_id,opponent_username,player_score,opponent_score,points_change,result,created_at
from public.matches;

grant select on public.public_player_matches to anon,authenticated;
grant select on public.friend_requests to authenticated;
grant update(dm_policy) on public.profiles to authenticated;
revoke update on public.profiles from anon,authenticated;
grant update(display_name,bio,avatar_url,banner_url,dm_policy) on public.profiles to authenticated;

revoke all on function public.are_friends(uuid,uuid) from public,anon;
revoke all on function public.send_friend_request(uuid) from public,anon;
revoke all on function public.respond_friend_request(uuid,boolean) from public,anon;
revoke all on function public.create_conversation(uuid[],text) from public,anon;
grant execute on function public.are_friends(uuid,uuid) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid,boolean) to authenticated;
grant execute on function public.create_conversation(uuid[],text) to authenticated;
