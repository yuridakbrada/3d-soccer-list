-- 3D Soccer List clan management migration 004
-- Run AFTER community-features-migration.sql.
-- Adds leader invitations, member removal and vice-leader management.

create table if not exists public.clan_invites (
  id uuid primary key default gen_random_uuid(),
  clan_id uuid not null references public.clans(id) on delete cascade,
  invited_user_id uuid not null references public.profiles(id) on delete cascade,
  invited_by uuid not null references public.profiles(id),
  status text not null default 'pending' check(status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(clan_id,invited_user_id)
);
alter table public.clan_invites enable row level security;
drop policy if exists "Players read their clan invites" on public.clan_invites;
create policy "Players read their clan invites" on public.clan_invites for select to authenticated
using (
  invited_user_id=auth.uid() or exists(
    select 1 from public.clan_members m
    where m.clan_id=clan_invites.clan_id and m.user_id=auth.uid()
      and m.member_role in ('leader','vice_leader')
  )
);
grant select on public.clan_invites to authenticated;
revoke insert,update,delete on public.clan_invites from anon,authenticated;

create or replace function public.invite_clan_member(p_clan_id uuid,p_user_id uuid)
returns uuid language plpgsql security definer
set search_path=public,pg_temp
as $$
declare v_id uuid;
begin
  if not exists(select 1 from public.clan_members where clan_id=p_clan_id and user_id=auth.uid() and member_role='leader') then
    raise exception 'Only the clan leader can invite players';
  end if;
  if p_user_id=auth.uid() then raise exception 'You are already in this clan'; end if;
  if exists(select 1 from public.clan_members where user_id=p_user_id) then raise exception 'This player already belongs to a clan'; end if;
  insert into public.clan_invites(clan_id,invited_user_id,invited_by,status)
  values(p_clan_id,p_user_id,auth.uid(),'pending')
  on conflict(clan_id,invited_user_id) do update set invited_by=auth.uid(),status='pending',updated_at=now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.respond_clan_invite(p_invite_id uuid,p_accept boolean)
returns void language plpgsql security definer
set search_path=public,pg_temp
as $$
declare v_invite public.clan_invites%rowtype;
begin
  select * into v_invite from public.clan_invites
  where id=p_invite_id and invited_user_id=auth.uid() and status='pending' for update;
  if not found then raise exception 'Invitation not found or already handled'; end if;
  if p_accept then
    if exists(select 1 from public.clan_members where user_id=auth.uid()) then
      raise exception 'You already belong to a clan';
    end if;
    insert into public.clan_members(clan_id,user_id,member_role)
    values(v_invite.clan_id,auth.uid(),'member');
  end if;
  update public.clan_invites set status=case when p_accept then 'accepted' else 'rejected' end,updated_at=now()
  where id=p_invite_id;
end;
$$;

create or replace function public.remove_clan_member(p_clan_id uuid,p_user_id uuid)
returns void language plpgsql security definer
set search_path=public,pg_temp
as $$
begin
  if not exists(select 1 from public.clan_members where clan_id=p_clan_id and user_id=auth.uid() and member_role='leader') then
    raise exception 'Only the clan leader can remove members';
  end if;
  if p_user_id=auth.uid() then raise exception 'Transfer leadership before leaving the clan'; end if;
  delete from public.clan_members where clan_id=p_clan_id and user_id=p_user_id;
  if not found then raise exception 'Player is not in this clan'; end if;
end;
$$;

create or replace function public.set_clan_vice_leader(p_clan_id uuid,p_user_id uuid)
returns void language plpgsql security definer
set search_path=public,pg_temp
as $$
begin
  if not exists(select 1 from public.clan_members where clan_id=p_clan_id and user_id=auth.uid() and member_role='leader') then
    raise exception 'Only the clan leader can appoint a vice-leader';
  end if;
  if not exists(select 1 from public.clan_members where clan_id=p_clan_id and user_id=p_user_id) then
    raise exception 'Player is not in this clan';
  end if;
  update public.clan_members set member_role='member'
  where clan_id=p_clan_id and member_role='vice_leader';
  update public.clan_members set member_role='vice_leader'
  where clan_id=p_clan_id and user_id=p_user_id;
end;
$$;

revoke all on function public.invite_clan_member(uuid,uuid) from public,anon;
revoke all on function public.respond_clan_invite(uuid,boolean) from public,anon;
revoke all on function public.remove_clan_member(uuid,uuid) from public,anon;
revoke all on function public.set_clan_vice_leader(uuid,uuid) from public,anon;
grant execute on function public.invite_clan_member(uuid,uuid) to authenticated;
grant execute on function public.respond_clan_invite(uuid,boolean) to authenticated;
grant execute on function public.remove_clan_member(uuid,uuid) to authenticated;
grant execute on function public.set_clan_vice_leader(uuid,uuid) to authenticated;
