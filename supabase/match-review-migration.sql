-- 3D Soccer List match review workflow (migration 005)
-- Run AFTER schema.sql and the community migrations.
-- Approval is performed inside a trusted SECURITY DEFINER function, never in the browser.

-- Remove direct client-side review privileges. Administrators must use the RPC below.
revoke update on public.match_submissions from anon, authenticated;
revoke update (status, reviewer_id, review_note, reviewed_at)
  on public.match_submissions from authenticated;

create or replace function public.review_match_submission(
  p_submission_id uuid,
  p_approve boolean,
  p_review_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.match_submissions%rowtype;
  v_submitter_points integer;
  v_opponent_points integer;
  v_new_points integer;
  v_points_change integer;
  v_submitter_division integer;
  v_opponent_division integer;
  v_result text;
  v_delta integer;
  v_division_name text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.admins where user_id = auth.uid()
  ) then
    raise exception 'Administrator access required';
  end if;

  if p_review_note is not null and char_length(p_review_note) > 500 then
    raise exception 'Review note must be 500 characters or fewer';
  end if;

  select * into v_submission
  from public.match_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Submission not found'; end if;
  if v_submission.status <> 'pending' then
    raise exception 'This submission has already been reviewed';
  end if;

  if p_approve then
    select points into v_submitter_points
    from public.profiles
    where id = v_submission.submitted_by
    for update;

    if not found then raise exception 'Submitting player no longer exists'; end if;

    select points into v_opponent_points
    from public.profiles
    where lower(username) = lower(trim(v_submission.opponent_username));

    if not found then
      raise exception 'Opponent username was not found in the player list';
    end if;
    if lower(trim(v_submission.opponent_username)) = (
      select lower(username) from public.profiles where id = v_submission.submitted_by
    ) then
      raise exception 'A player cannot submit a match against themselves';
    end if;

    v_submitter_division := case
      when v_submitter_points <= 500 then 1
      when v_submitter_points <= 1000 then 2
      when v_submitter_points <= 1500 then 3
      when v_submitter_points <= 2000 then 4
      when v_submitter_points <= 3000 then 5
      when v_submitter_points <= 4000 then 6
      else 7
    end;
    v_opponent_division := case
      when v_opponent_points <= 500 then 1
      when v_opponent_points <= 1000 then 2
      when v_opponent_points <= 1500 then 3
      when v_opponent_points <= 2000 then 4
      when v_opponent_points <= 3000 then 5
      when v_opponent_points <= 4000 then 6
      else 7
    end;

    v_result := case
      when v_submission.submitter_score > v_submission.opponent_score then 'win'
      else 'loss'
    end;

    if v_submitter_division = v_opponent_division then
      v_delta := case when v_result = 'win' then 30 else -30 end;
    elsif v_opponent_division < v_submitter_division then
      v_delta := case when v_result = 'win' then 15 else -45 end;
    else
      v_delta := case when v_result = 'win' then 45 else -15 end;
    end if;

    v_new_points := greatest(0, least(5000, v_submitter_points + v_delta));
    v_points_change := v_new_points - v_submitter_points;
    v_division_name := case
      when v_new_points <= 500 then 'Beginner'
      when v_new_points <= 1000 then 'Intermediate'
      when v_new_points <= 1500 then 'Advanced'
      when v_new_points <= 2000 then 'Professional'
      when v_new_points <= 3000 then 'Legend'
      when v_new_points <= 4000 then 'Master'
      else 'Professor'
    end;

    update public.profiles
    set points = v_new_points,
        division = v_division_name,
        wins = wins + case when v_result = 'win' then 1 else 0 end,
        losses = losses + case when v_result = 'loss' then 1 else 0 end
    where id = v_submission.submitted_by;

    insert into public.matches (
      submission_id, player_id, opponent_username,
      player_score, opponent_score, points_change, result
    ) values (
      v_submission.id, v_submission.submitted_by, lower(trim(v_submission.opponent_username)),
      v_submission.submitter_score, v_submission.opponent_score, v_points_change, v_result
    );

    update public.match_submissions
    set status = 'approved',
        reviewer_id = auth.uid(),
        review_note = nullif(trim(coalesce(p_review_note, '')), ''),
        reviewed_at = now()
    where id = v_submission.id;
  else
    update public.match_submissions
    set status = 'rejected',
        reviewer_id = auth.uid(),
        review_note = nullif(trim(coalesce(p_review_note, '')), ''),
        reviewed_at = now()
    where id = v_submission.id;
  end if;
end;
$$;

revoke all on function public.review_match_submission(uuid, boolean, text) from public, anon;
grant execute on function public.review_match_submission(uuid, boolean, text) to authenticated;
