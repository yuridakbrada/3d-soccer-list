-- 3D Soccer List match challenges and privacy settings (migration 006)
-- Run AFTER match-review-migration.sql.

alter table public.profiles
  add column if not exists match_policy text not null default 'everyone'
  check (match_policy in ('nobody','friends','everyone'));

create table if not exists public.match_requests (
  id uuid primary key default gen_random_uuid(),
  challenger_id uuid not null references public.profiles(id) on delete cascade,
  challenged_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected','cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (challenger_id <> challenged_id)
);
create index if not exists match_requests_challenged_status_idx
  on public.match_requests(challenged_id,status,created_at desc);
create index if not exists match_requests_challenger_status_idx
  on public.match_requests(challenger_id,status,created_at desc);
create unique index if not exists match_requests_one_pending_pair_idx
  on public.match_requests(least(challenger_id,challenged_id),greatest(challenger_id,challenged_id))
  where status='pending';

alter table public.match_requests enable row level security;
drop policy if exists "Players read their own match requests" on public.match_requests;
create policy "Players read their own match requests"
on public.match_requests for select to authenticated
using (auth.uid()=challenger_id or auth.uid()=challenged_id);

create or replace function public.create_match_request(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy text;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_user_id=auth.uid() then raise exception 'You cannot challenge yourself'; end if;

  select match_policy into v_policy
  from public.profiles where id=p_user_id;
  if not found then raise exception 'Player not found'; end if;

  if v_policy='nobody' then
    raise exception 'This player is not accepting match challenges';
  elsif v_policy='friends' and not public.are_friends(auth.uid(),p_user_id) then
    raise exception 'This player only accepts challenges from friends';
  end if;

  if exists (
    select 1 from public.match_requests
    where status='pending'
      and ((challenger_id=auth.uid() and challenged_id=p_user_id)
        or (challenger_id=p_user_id and challenged_id=auth.uid()))
  ) then
    raise exception 'There is already a pending match request between you';
  end if;

  insert into public.match_requests(challenger_id,challenged_id)
  values(auth.uid(),p_user_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.respond_match_request(p_request_id uuid,p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.match_requests
  set status=case when p_accept then 'accepted' else 'rejected' end,
      responded_at=now()
  where id=p_request_id and challenged_id=auth.uid() and status='pending';
  if not found then
    raise exception 'Match request not found or already handled';
  end if;
end;
$$;

grant select on public.match_requests to authenticated;
revoke insert,update,delete on public.match_requests from anon,authenticated;
revoke all on function public.create_match_request(uuid) from public,anon;
revoke all on function public.respond_match_request(uuid,boolean) from public,anon;
grant execute on function public.create_match_request(uuid) to authenticated;
grant execute on function public.respond_match_request(uuid,boolean) to authenticated;

grant update (match_policy) on public.profiles to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.match_requests;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
