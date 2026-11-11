-- =============================================================================
-- BiMail migration 0001 — 表 / 视图 / RLS / 权限（SPEC §5.2 §5.3，CONTRACT §4.1）
--
-- 运行环境：Supabase Postgres（已存在 anon / authenticated 角色与 auth schema）。
-- 本文件不创建扩展与角色；本地验收由 tests/sql/run.mjs 先建 mock auth schema 与角色。
-- 幂等友好：迁移可安全重跑（建表 if not exists / 视图与函数 create or replace /
--   policy 先 drop 再 create / 授权语句可重复执行）。
--
-- 安全不变量（与 SPEC §5.4 对应）：
--   I1  seat 主键 (dyad_id, slot) + slot check('a','b') + 占座 RPC 行锁
--   I2  entry 无 insert/update/delete 权限与策略，写入只经 security definer RPC
--   I3  created_at / client_uuid 不在任何视图；基表只给列级 select（见下方说明）
--   I4  seat.user_id → auth.users ON DELETE RESTRICT（运维删除匿名主体被外键挡住）
--   I5  seat.user_id UNIQUE（一人一墙）
--
-- 说明（与 CONTRACT 字面的差异，已向 Lead 报备）：
--   PostgreSQL 的 security_invoker 视图会以调用者身份检查底层表权限，因此
--   authenticated 必须对基表持有「列级」select 才能读 v_entry / v_seat。
--   我们只授予视图真正需要的列：entry(id,seq,slot,body,written_on)、
--   seat(slot,joined_on)。于是 created_at / client_uuid 在基表层面即不可读，
--   表级 select 权限仍然为假（has_table_privilege = false）。
-- =============================================================================

-- 清空客户端角色的表级权限（视图与列级授权在文件末尾重新给出）。
revoke all on all tables in schema public from anon, authenticated;

-- ── 实体 ─────────────────────────────────────────────────────────────────────

create table if not exists public.dyad (
  id uuid primary key default gen_random_uuid(),
  state text not null default 'nascent'
        check (state in ('nascent', 'open', 'closed')),
  created_at timestamptz not null default now()
);

-- 座位：slot 固定 a/b（I1）；user_id UNIQUE（I5）；ON DELETE RESTRICT（I4）。
-- recovery_hash 只存 SHA-256（客户端计算，服务端不接触明文恢复密钥）。
create table if not exists public.seat (
  dyad_id uuid not null references public.dyad(id) on delete cascade,
  slot char(1) not null check (slot in ('a', 'b')),
  user_id uuid not null unique references auth.users(id) on delete restrict,
  recovery_hash bytea not null check (length(recovery_hash) = 32),
  joined_on date not null default (now() at time zone 'utc')::date,
  primary key (dyad_id, slot)
);

-- 留言：只追加。seq 全局 identity（严格单调）；created_at/client_uuid 仅供排序与幂等。
create table if not exists public.entry (
  id uuid primary key default gen_random_uuid(),
  dyad_id uuid not null references public.dyad(id) on delete cascade,
  slot char(1) not null,
  seq bigint generated always as identity,
  body text not null check (char_length(body) between 1 and 8000),
  written_on date not null,
  client_uuid uuid not null,
  created_at timestamptz not null default now(),  -- 仅排序与审计，永不出库
  unique (dyad_id, client_uuid),                  -- 幂等寄出
  foreign key (dyad_id, slot) references public.seat(dyad_id, slot)
);

create index if not exists entry_dyad_seq_idx on public.entry (dyad_id, seq);

-- 邀请：单次消费、7 天、服务端只存 token 的 SHA-256。
create table if not exists public.invite (
  dyad_id uuid primary key references public.dyad(id) on delete cascade,
  token_hash bytea not null unique,
  expires_on date not null,
  consumed_at timestamptz
);

-- rebind 限流：每小时 5 次（失败与通过都计）。
create table if not exists public.rebind_attempt (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists rebind_attempt_user_time_idx
  on public.rebind_attempt (user_id, created_at desc);

-- ── 唯一读通道（A3 的列级实现）────────────────────────────────────────────────

-- 分秒不出库：v_entry / v_seat 均不含 created_at / client_uuid / dyad_id。
create or replace view public.v_entry with (security_invoker = true) as
  select id, seq, slot, body, written_on from public.entry;

create or replace view public.v_seat with (security_invoker = true) as
  select slot, joined_on from public.seat;

-- ── 身份辅助函数（security definer，只读 seat）────────────────────────────────

create or replace function public.my_dyad() returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$ select dyad_id from public.seat where user_id = auth.uid() $$;

create or replace function public.my_slot() returns char(1)
language sql stable security definer
set search_path = public, pg_temp
as $$ select slot from public.seat where user_id = auth.uid() $$;

-- ── RLS：读自己的墙；无写策略（写入只经 RPC）────────────────────────────────

alter table public.dyad enable row level security;
alter table public.seat enable row level security;
alter table public.entry enable row level security;
alter table public.invite enable row level security;
alter table public.rebind_attempt enable row level security;

drop policy if exists read_own on public.entry;
create policy read_own on public.entry for select
  using (dyad_id = public.my_dyad());

drop policy if exists read_own_seat on public.seat;
create policy read_own_seat on public.seat for select
  using (dyad_id = public.my_dyad());

-- dyad / invite / rebind_attempt：无策略、无权限 —— 完全不可直接读写。

-- ── 权限：只开列级读 + 视图读；写权限全部撤销 ─────────────────────────────────

grant select on public.v_entry, public.v_seat to authenticated;

-- security_invoker 视图必须的底层列级权限（见文件头说明）。
grant select (id, seq, slot, body, written_on) on public.entry to authenticated;
grant select (slot, joined_on) on public.seat to authenticated;

-- 客户端角色不得直接写任何基表（I2）。
revoke insert, update, delete on public.entry from anon, authenticated;
revoke insert, update, delete on public.seat from anon, authenticated;
revoke insert, update, delete on public.dyad from anon, authenticated;
revoke insert, update, delete on public.invite from anon, authenticated;
revoke insert, update, delete on public.rebind_attempt from anon, authenticated;

-- 函数默认对 PUBLIC 开放 EXECUTE：先全部收回，白名单在 0002 末尾统一授予。
revoke all on function public.my_dyad() from public, anon, authenticated;
revoke all on function public.my_slot() from public, anon, authenticated;

-- RLS 策略在 authenticated 身份下求值，需要 my_dyad 的 EXECUTE。
grant execute on function public.my_dyad() to authenticated;
