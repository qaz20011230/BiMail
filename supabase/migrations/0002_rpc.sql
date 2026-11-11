-- =============================================================================
-- BiMail migration 0002 — security definer RPC（CONTRACT §4.1）
--
-- 约定：
--   * 返回值与 local 后端 HTTP 契约（docs/CONTRACT.md §3）形状完全一致：
--       {snapshot} / {entries, has_more} / {entry, duplicate} / {}
--   * 业务错误一般 raise exception '<code>'，code ∈ src/lib/errors.ts；
--     PostgREST 会把 message 原样带回，客户端据此映射 BackendErrorCode。
--   * 例外：rebind_seat 的错误以 HTTP 200 + {"error":"<code>"} 返回（其它 RPC 仍用 raise）。
--     原因：PostgreSQL 中 raise 会回滚整个事务，连提前写入的 rebind_attempt 记录也一并
--     回滚，导致「失败也计入限流」永远无法生效。为满足 SPEC §5.6 的每小时 5 次节流，
--     该 RPC 必须正常返回以提交计数；响应体形状与 dev server 完全一致（仅 HTTP 状态
--     不同：dev server 用 4xx，Supabase 用 200）。客户端两种都映射为 BackendErrorCode。
--   * 所有 RPC 都是 security definer + set search_path = public, pg_temp。
--   * 函数默认 EXECUTE 给 PUBLIC，本文件末尾统一 revoke 后再白名单授权。
--
-- 不变量：
--   A2  已寄出留言不可改删；close_and_erase 是唯一删除例外（只删自己 slot）。
--   A3  读路径只返回 id/seq/slot/body/written_on 与 slot/joined_on。
--   I1  accept_invite 单事务 + invite/dyad 行锁原子占座。
--   I5  seat.user_id UNIQUE（RAISE already_seated 由冲突兜底）。
-- =============================================================================

-- ── 内部辅助（不对外授权）────────────────────────────────────────────────────

-- 单条留言的对外 JSON 形状：绝不含 created_at / client_uuid / dyad_id。
create or replace function public.entry_json(e public.entry) returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', e.id,
    'seq', e.seq,
    'slot', e.slot,
    'body', e.body,
    'written_on', e.written_on::text
  )
$$;

-- 墙快照（WallSnapshot）。invite 明文只在 create_wall 响应里出现一次；
-- 服务端只存 token 哈希，因此其余调用一律传 null（CONTRACT §3 + SPEC §5.5）。
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
$$;

-- ── create_wall：dyad(nascent) + seat a + 一次性邀请 ──────────────────────────

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
  if exists (select 1 from public.seat where user_id = v_uid) then
    raise exception 'already_seated';
  end if;
  if recovery_hash is null or length(recovery_hash) <> 32 then
    raise exception 'invalid_hash';
  end if;

  -- 24 字节随机 → 32 字符 base64url（不依赖 pgcrypto：两次 uuid 拼 24 字节）。
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

  -- token 服务端只存 SHA-256；明文仅出现在本次响应。
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

-- ── accept_invite：单事务、行锁、原子占座 b ───────────────────────────────────

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
  if exists (select 1 from public.seat where user_id = v_uid) then
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

-- ── wall_state：无座位 no_seat；invite 恒为 null（只存哈希）─────────────────

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
  if not exists (select 1 from public.seat where user_id = v_uid) then
    raise exception 'no_seat';
  end if;
  return jsonb_build_object('snapshot', public.snapshot_for(v_uid));
end
$$;

-- ── list_entries：无座位返回空页；limit 默认/上限 120；升序返回 ───────────────

create or replace function public.list_entries(before_seq bigint, page_limit integer)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_dyad uuid := public.my_dyad();
  v_limit integer;
  v_entries jsonb;
  v_has_more boolean;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;
  -- 等价 RLS 零行：无座位不报错，返回空页。
  if v_dyad is null then
    return jsonb_build_object('entries', '[]'::jsonb, 'has_more', false);
  end if;

  v_limit := coalesce(page_limit, 120);
  if v_limit < 1 then
    v_limit := 120;
  end if;
  if v_limit > 120 then
    v_limit := 120;
  end if;

  select count(*) into v_count
  from (
    select 1
    from public.entry e
    where e.dyad_id = v_dyad
      and (list_entries.before_seq is null or e.seq < list_entries.before_seq)
    order by e.seq desc
    limit v_limit + 1
  ) t;
  v_has_more := v_count > v_limit;

  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'seq', e.seq,
          'slot', e.slot,
          'body', e.body,
          'written_on', e.written_on::text
        )
        order by e.seq
      ),
      '[]'::jsonb
    )
  into v_entries
  from (
    select e.*
    from public.entry e
    where e.dyad_id = v_dyad
      and (list_entries.before_seq is null or e.seq < list_entries.before_seq)
    order by e.seq desc
    limit v_limit
  ) e;

  return jsonb_build_object('entries', v_entries, 'has_more', v_has_more);
end
$$;

-- ── post_entry：幂等、closed、长度、written_on ±2 日钳制 ──────────────────────

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

  select s.* into v_seat from public.seat s where s.user_id = v_uid;
  if not found then
    raise exception 'no_seat';
  end if;

  -- 幂等重放优先于一切：即使墙已 closed 也返回已存在的那一条（只追加语义）。
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

  -- 写作者本地日期；非法或不在服务端 UTC 日期 ±2 日内 → 取服务端日期。
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
    -- 并发双写同一 client_uuid：返回已落库的那一行。
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

-- ── rebind_seat：恢复钥匙换座；1 小时 5 次限流（失败与通过都计）─────────────
--
-- 错误返回约定见文件头：本 RPC 的错误以 {"error":"<code>"} 正常返回，以便事务提交
-- rebind_attempt 计数（raise 会回滚计数，使节流失效）。调用方必须检查响应体。

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
  -- 失败与通过都计；被限流的调用不再计数（不会延长封禁窗口）。
  insert into public.rebind_attempt (user_id) values (v_uid);

  if exists (select 1 from public.seat s where s.user_id = v_uid) then
    return jsonb_build_object('error', 'already_seated');
  end if;
  if recovery_hash is null or length(recovery_hash) <> 32 then
    return jsonb_build_object('error', 'invalid_hash');
  end if;

  select s.* into v_target
    from public.seat s
    where s.recovery_hash = rebind_seat.recovery_hash
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

  -- 只换 user_id：slot / joined_on 不变，对方无感（A3）。
  update public.seat set user_id = v_uid
    where dyad_id = v_target.dyad_id and slot = v_target.slot;

  return jsonb_build_object('snapshot', public.snapshot_for(v_uid));
end
$$;

-- ── revoke_other_sessions：注销该主体除当前登录凭据外的其他登录凭据 ───────────────────

create or replace function public.revoke_other_sessions()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_session_id uuid;
  v_claims jsonb;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_session_id := nullif(v_claims ->> 'session_id', '')::uuid;
  exception when others then
    v_session_id := null;
  end;
  if v_session_id is null then
    return '{}'::jsonb;
  end if;

  begin
    delete from auth.sessions
      where user_id = v_uid and id <> v_session_id;
  exception when others then
    -- 不同 GoTrue 版本的 auth schema 结构可能不同；客户端主路径走
    -- POST /auth/v1/logout?scope=others（见 src/lib/supabase.ts）。
    null;
  end;

  return '{}'::jsonb;
end
$$;

-- ── close_and_erase：唯一删除例外，墙置 closed；不释放座位 ───────────────────

create or replace function public.close_and_erase()
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_dyad uuid := public.my_dyad();
  v_slot char(1) := public.my_slot();
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;
  if v_dyad is null then
    raise exception 'no_seat';
  end if;

  -- A2 的唯一例外（SPEC §5.7）：硬删除自己 slot 的全部留言。
  delete from public.entry where dyad_id = v_dyad and slot = v_slot;
  update public.dyad set state = 'closed' where id = v_dyad;
  delete from public.invite where dyad_id = v_dyad;

  return '{}'::jsonb;
end
$$;

-- ── 权限：收回全部，再按白名单授权 ───────────────────────────────────────────

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
  end loop;
end
$$;

grant execute on function public.create_wall(bytea) to authenticated;
grant execute on function public.accept_invite(text, bytea) to authenticated;
grant execute on function public.wall_state() to authenticated;
grant execute on function public.list_entries(bigint, integer) to authenticated;
grant execute on function public.post_entry(uuid, text, date) to authenticated;
grant execute on function public.rebind_seat(bytea) to authenticated;
grant execute on function public.revoke_other_sessions() to authenticated;
grant execute on function public.close_and_erase() to authenticated;
-- RLS 策略以 authenticated 身份求值，需要 my_dyad 的 EXECUTE。
grant execute on function public.my_dyad() to authenticated;
