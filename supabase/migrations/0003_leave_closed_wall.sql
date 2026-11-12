-- =============================================================================
-- BiMail migration 0003 — 已关闭的墙可以离开（释放座位）
--
-- 背景：`close_and_erase` 之后座位仍绑定当前匿名身份，主体无法再建新墙
-- （create_wall → already_seated），实测「墙 closed 后找不到开新墙入口」。
-- 本迁移引入 released_at：主体可以在墙 closed 后「离开」旧墙（保留历史 seat 行），
-- 之后允许建立新墙；活跃墙仍严格执行「一人最多一墙」（A1）。
--
-- 语义（与 docs/CONTRACT.md 增补一致）：
--   * seat.released_at timestamptz null：null = 在座（active），非 null = 已离座（历史行）。
--   * 唯一性从「全局 UNIQUE(user_id)」改为「部分唯一索引：active 座位内 user_id 唯一」。
--   * my_dyad() / my_slot() / snapshot_for() 只认 active 座位；snapshot 的 seats 列表
--     仍返回该墙全部历史座位（派生语「两位笔友到齐」不变，不暴露 released 标记）。
--   * create_wall / accept_invite / rebind 的「已在座」判断只看 active 座位；
--     rebind 只匹配 active 座位（已离座的恢复密钥不能再换回旧墙）。
--   * 新 RPC leave_closed_wall()：墙必须 closed；硬删除自己 slot 的全部留言；
--     seat.released_at = now()；返回 {}。无 active 座位 → raise 'no_seat'；
--     墙未 closed → raise 'wall_not_closed'。
--   * close_and_erase 语义不变：仍不释放座位（离开是独立动作）。
--
-- 幂等 / 可对既有生产库执行：本文件可在 0001+0002 已应用的库上重跑；
-- 动态 drop 旧 UNIQUE 约束（按约束定义匹配，不依赖自动命名）。重复执行无副作用。
-- =============================================================================

-- ── 1. seat.released_at ──────────────────────────────────────────────────────

alter table public.seat
  add column if not exists released_at timestamptz;

comment on column public.seat.released_at is
  'null = 在座（active）；非 null = 已离开该墙（历史座位，不可再读写该墙）';

-- ── 2. 去掉旧的全局 UNIQUE(user_id)，改为 active 部分唯一索引 ─────────────────

do $$
declare
  target record;
begin
  for target in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.seat'::regclass
      and c.contype = 'u'
      and c.conkey = array[
        (select a.attnum
         from pg_attribute a
         where a.attrelid = 'public.seat'::regclass
           and a.attname = 'user_id')
      ]::smallint[]
  loop
    execute format('alter table public.seat drop constraint %I', target.conname);
  end loop;
end
$$;

create unique index if not exists seat_active_user_uidx
  on public.seat (user_id)
  where released_at is null;

-- ── 3. 身份辅助函数：只认 active 座位 ────────────────────────────────────────

create or replace function public.my_dyad() returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select dyad_id from public.seat
  where user_id = auth.uid() and released_at is null
$$;

create or replace function public.my_slot() returns char(1)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select slot from public.seat
  where user_id = auth.uid() and released_at is null
$$;

-- ── 4. snapshot_for：只匹配 active 座位；seats 仍返回该墙全部历史座位 ─────────

create or replace function public.snapshot_for(p_user uuid, p_invite jsonb default null)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'dyad_id', s.dyad_id,
    'state', d.state,
    'my_slot', s.slot,
    'seats', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object('slot', st.slot, 'joined_on', st.joined_on::text)
          order by st.slot
        ),
        '[]'::jsonb
      )
      from public.seat st
      where st.dyad_id = s.dyad_id
    ),
    'invite', p_invite
  )
  from public.seat s
  join public.dyad d on d.id = s.dyad_id
  where s.user_id = p_user
    and s.released_at is null
$$;

-- ── 5. create_wall：已在座只看 active 座位 ───────────────────────────────────

create or replace function public.create_wall(recovery_hash bytea)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_dyad_id uuid := gen_random_uuid();
  v_today date := (now() at time zone 'utc')::date;
  v_token text;
  v_expires_on date;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;
  if exists (select 1 from public.seat s where s.user_id = v_uid and s.released_at is null) then
    raise exception 'already_seated';
  end if;
  if recovery_hash is null or length(recovery_hash) <> 32 then
    raise exception 'invalid_hash';
  end if;

  v_token := translate(
    encode(
      decode(
        substr(
          replace(gen_random_uuid()::text, '-', '') ||
          replace(gen_random_uuid()::text, '-', ''),
          1,
          48
        ),
        'hex'
      ),
      'base64'
    ),
    '+/', '-_'
  );
  v_expires_on := v_today + 7;

  begin
    insert into public.dyad (id, state) values (v_dyad_id, 'nascent');
    insert into public.seat (dyad_id, slot, user_id, recovery_hash, joined_on)
      values (v_dyad_id, 'a', v_uid, recovery_hash, v_today);
  exception when unique_violation then
    raise exception 'already_seated';
  end;

  insert into public.invite (dyad_id, token_hash, expires_on)
    values (v_dyad_id, sha256(convert_to(v_token, 'UTF8')), v_expires_on);

  return jsonb_build_object(
    'snapshot',
    public.snapshot_for(
      v_uid,
      jsonb_build_object('token', v_token, 'expires_on', v_expires_on::text)
    )
  );
end
$$;

-- ── 6. accept_invite：已在座只看 active 座位 ─────────────────────────────────

create or replace function public.accept_invite(token text, recovery_hash bytea)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_invite public.invite%rowtype;
  v_state text;
  v_seat_count integer;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;
  if exists (select 1 from public.seat s where s.user_id = v_uid and s.released_at is null) then
    raise exception 'already_seated';
  end if;
  if recovery_hash is null or length(recovery_hash) <> 32 then
    raise exception 'invalid_hash';
  end if;
  if token is null then
    raise exception 'invite_unknown';
  end if;

  select i.* into v_invite
    from public.invite i
    where i.token_hash = sha256(convert_to(token, 'UTF8'))
    for update;
  if not found then
    raise exception 'invite_unknown';
  end if;
  if v_invite.consumed_at is not null then
    raise exception 'invite_consumed';
  end if;
  if v_invite.expires_on < v_today then
    raise exception 'invite_expired';
  end if;

  select d.state into v_state from public.dyad d where d.id = v_invite.dyad_id for update;
  if v_state is distinct from 'nascent' then
    raise exception 'invite_consumed';
  end if;

  select count(*) into v_seat_count from public.seat s where s.dyad_id = v_invite.dyad_id;
  if v_seat_count >= 2 then
    raise exception 'invite_consumed';
  end if;

  begin
    insert into public.seat (dyad_id, slot, user_id, recovery_hash, joined_on)
      values (v_invite.dyad_id, 'b', v_uid, recovery_hash, v_today);
  exception when unique_violation then
    raise exception 'already_seated';
  end;

  update public.dyad set state = 'open' where id = v_invite.dyad_id;
  update public.invite set consumed_at = now() where dyad_id = v_invite.dyad_id;

  return jsonb_build_object('snapshot', public.snapshot_for(v_uid));
end
$$;

-- ── 7. wall_state：无 active 座位 → no_seat ──────────────────────────────────

create or replace function public.wall_state()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;
  if not exists (select 1 from public.seat s where s.user_id = v_uid and s.released_at is null) then
    raise exception 'no_seat';
  end if;
  return jsonb_build_object('snapshot', public.snapshot_for(v_uid));
end
$$;

-- ── 8. post_entry：座位查找只看 active（历史行会导致多行匹配）────────────────

create or replace function public.post_entry(client_uuid uuid, body text, written_on date)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_seat public.seat%rowtype;
  v_dyad_state text;
  v_entry public.entry%rowtype;
  v_written date;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  select s.* into v_seat
    from public.seat s
    where s.user_id = v_uid and s.released_at is null;
  if not found then
    raise exception 'no_seat';
  end if;

  select e.* into v_entry
    from public.entry e
    where e.dyad_id = v_seat.dyad_id
      and e.client_uuid = post_entry.client_uuid;
  if found then
    return jsonb_build_object('entry', public.entry_json(v_entry), 'duplicate', true);
  end if;

  select d.state into v_dyad_state from public.dyad d where d.id = v_seat.dyad_id;
  if v_dyad_state = 'closed' then
    raise exception 'wall_closed';
  end if;

  if body is null or body !~ '[^[:space:]]' or char_length(body) > 8000 then
    raise exception 'invalid_body';
  end if;

  if written_on is null
     or written_on < v_today - 2
     or written_on > v_today + 2 then
    v_written := v_today;
  else
    v_written := written_on;
  end if;

  begin
    insert into public.entry (dyad_id, slot, body, written_on, client_uuid)
      values (v_seat.dyad_id, v_seat.slot, body, v_written, post_entry.client_uuid)
      returning * into v_entry;
  exception when unique_violation then
    select e.* into v_entry
      from public.entry e
      where e.dyad_id = v_seat.dyad_id
        and e.client_uuid = post_entry.client_uuid;
    if found then
      return jsonb_build_object('entry', public.entry_json(v_entry), 'duplicate', true);
    end if;
    raise;
  end;

  return jsonb_build_object('entry', public.entry_json(v_entry), 'duplicate', false);
end
$$;

-- ── 9. rebind_seat：只看 active 座位；错误仍以 200 + {error} 返回 ────────────

create or replace function public.rebind_seat(recovery_hash bytea)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_attempts integer;
  v_target public.seat%rowtype;
  v_state text;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  select count(*) into v_attempts
    from public.rebind_attempt a
    where a.user_id = v_uid and a.created_at > now() - interval '1 hour';
  if v_attempts >= 5 then
    return jsonb_build_object('error', 'throttled');
  end if;
  insert into public.rebind_attempt (user_id) values (v_uid);

  if exists (select 1 from public.seat s where s.user_id = v_uid and s.released_at is null) then
    return jsonb_build_object('error', 'already_seated');
  end if;
  if recovery_hash is null or length(recovery_hash) <> 32 then
    return jsonb_build_object('error', 'invalid_hash');
  end if;

  -- 已离座的座位不再可换回（恢复密钥只对 active 座位有效）。
  select s.* into v_target
    from public.seat s
    where s.recovery_hash = rebind_seat.recovery_hash
      and s.released_at is null
    order by s.dyad_id
    limit 1
    for update;
  if not found then
    return jsonb_build_object('error', 'invalid_hash');
  end if;

  select d.state into v_state from public.dyad d where d.id = v_target.dyad_id;
  if v_state = 'closed' then
    return jsonb_build_object('error', 'wall_closed');
  end if;

  begin
    update public.seat set user_id = v_uid
      where dyad_id = v_target.dyad_id and slot = v_target.slot;
  exception when unique_violation then
    return jsonb_build_object('error', 'already_seated');
  end;

  return jsonb_build_object('snapshot', public.snapshot_for(v_uid));
end
$$;

-- ── 10. 新 RPC：离开已关闭的墙（释放座位，保留历史行）───────────────────────

create or replace function public.leave_closed_wall()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_seat public.seat%rowtype;
  v_state text;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  select s.* into v_seat
    from public.seat s
    where s.user_id = v_uid and s.released_at is null;
  if not found then
    raise exception 'no_seat';
  end if;

  select d.state into v_state from public.dyad d where d.id = v_seat.dyad_id;
  if v_state is distinct from 'closed' then
    raise exception 'wall_not_closed';
  end if;

  -- 离开即行使销毁权：删除自己 slot 的全部留言（A2 的唯一例外）。
  delete from public.entry
    where dyad_id = v_seat.dyad_id and slot = v_seat.slot;

  -- 保留历史座位行（slot / joined_on 不变），只标记离座时间。
  update public.seat
    set released_at = now()
    where dyad_id = v_seat.dyad_id and slot = v_seat.slot;

  return '{}'::jsonb;
end
$$;

-- ── 11. 授权：新函数只给 authenticated；其余函数 create or replace 保留原授权 ─

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'leave_closed_wall'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
  end loop;
end
$$;

grant execute on function public.leave_closed_wall() to authenticated;

-- RLS 策略在 authenticated 身份下求值；create or replace 已保留授权，此处幂等重申。
grant execute on function public.my_dyad() to authenticated;
