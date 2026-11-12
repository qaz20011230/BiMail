#!/usr/bin/env node
/**
 * Supabase 迁移验收（docs/CONTRACT.md §4.4 / SPEC §9 T1–T7）—— PGlite 内存库。
 *
 * 用 mock 的 auth schema + anon/authenticated 角色执行 supabase/migrations/*.sql，
 * 然后以 authenticated 身份（set role + request.jwt.claims）跑安全与行为断言。
 * 不用真实 Supabase 网络；不占据任何端口。
 */

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', '..', 'supabase', 'migrations')

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const keyHash = (label) => sha256(`bimail-test-key:${label}:${randomUUID()}`)

function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

/** @returns {string} YYYY-MM-DD */
function shiftUtc(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

// —————————————————————————————————————————————————————————————
// mock 环境
// —————————————————————————————————————————————————————————————

const MOCK_AUTH = `
create role anon nologin;
create role authenticated nologin;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text
);
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade
);
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
`

const db = new PGlite()
let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`✔ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`✖ ${name}`)
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error(
      message
        .split('\n')
        .slice(0, 6)
        .map((line) => `    ${line}`)
        .join('\n'),
    )
  }
}

// —————————————————————————————————————————————————————————————
// 身份切换
// —————————————————————————————————————————————————————————————

async function asUser(uid, fn, extraClaims = {}) {
  await db.exec('set role authenticated')
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: uid, ...extraClaims }),
  ])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claims', '', false)`)
  }
}

async function asAnon(fn) {
  await db.exec('set role anon')
  await db.query(`select set_config('request.jwt.claims', '', false)`)
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}

async function newUser() {
  const id = randomUUID()
  await db.query('insert into auth.users (id) values ($1)', [id])
  return id
}

async function scalar(sql, params = []) {
  const result = await db.query(sql, params)
  return result.rows[0] ? Object.values(result.rows[0])[0] : undefined
}

async function rows(sql, params = []) {
  return (await db.query(sql, params)).rows
}

// —————————————————————————————————————————————————————————————
// RPC 调用（以 authenticated 身份）
// —————————————————————————————————————————————————————————————

async function rpcCreateWall(uid, hashHex) {
  return asUser(uid, async () => {
    const result = await db.query('select public.create_wall(decode($1, ' + "'hex'" + ')) as result', [
      hashHex,
    ])
    return result.rows[0].result
  })
}

async function rpcAcceptInvite(uid, token, hashHex) {
  return asUser(uid, async () => {
    const result = await db.query(
      "select public.accept_invite($1::text, decode($2, 'hex')) as result",
      [token, hashHex],
    )
    return result.rows[0].result
  })
}

async function rpcWallState(uid) {
  return asUser(uid, async () => {
    const result = await db.query('select public.wall_state() as result')
    return result.rows[0].result
  })
}

async function rpcListEntries(uid, beforeSeq = null, pageLimit = null) {
  return asUser(uid, async () => {
    const result = await db.query(
      'select public.list_entries($1::bigint, $2::integer) as result',
      [beforeSeq, pageLimit],
    )
    return result.rows[0].result
  })
}

async function rpcPostEntry(uid, clientUuid, body, writtenOn = null) {
  return asUser(uid, async () => {
    const result = await db.query(
      'select public.post_entry($1::uuid, $2::text, $3::date) as result',
      [clientUuid, body, writtenOn],
    )
    return result.rows[0].result
  })
}

async function rpcRebind(uid, hashHex) {
  return asUser(uid, async () => {
    const result = await db.query(
      "select public.rebind_seat(decode($1, 'hex')) as result",
      [hashHex],
    )
    return result.rows[0].result
  })
}

async function rpcRevokeOthers(uid, sessionId = null) {
  const claims = sessionId ? { session_id: sessionId } : {}
  return asUser(
    uid,
    async () => {
      const result = await db.query('select public.revoke_other_sessions() as result')
      return result.rows[0].result
    },
    claims,
  )
}

async function rpcCloseAndErase(uid) {
  return asUser(uid, async () => {
    const result = await db.query('select public.close_and_erase() as result')
    return result.rows[0].result
  })
}

async function rpcLeaveClosedWall(uid) {
  return asUser(uid, async () => {
    const result = await db.query('select public.leave_closed_wall() as result')
    return result.rows[0].result
  })
}

/** 断言调用抛出指定业务错误码（异常文本即错误码）。 */
async function expectCode(fn, expected) {
  let error = null
  try {
    await fn()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `应抛出 ${expected}`)
  assert.equal(String(error.message), expected)
}

/**
 * rebind_seat 的错误以 HTTP 200 + {error} 返回（见 migration 0002 文件头：
 * raise 会回滚 rebind_attempt 计数，导致限流失效）。其余 RPC 仍然是 raise。
 */
async function expectRpcError(fn, expected) {
  const result = await fn()
  assert.ok(
    result && typeof result === 'object' && typeof result.error === 'string',
    `应返回 {error:"${expected}"}，实际 ${JSON.stringify(result)}`,
  )
  assert.equal(result.error, expected)
}

async function expectForbidden(fn, pattern) {
  let error = null
  try {
    await fn()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, '应被拒绝')
  assert.match(String(error.message), pattern)
}

// —————————————————————————————————————————————————————————————
// 场景构造
// —————————————————————————————————————————————————————————————

async function makePair(label) {
  const a = await newUser()
  const b = await newUser()
  const hashA = keyHash(`${label}-a`)
  const hashB = keyHash(`${label}-b`)
  const wall = await rpcCreateWall(a, hashA)
  const inviteToken = wall.snapshot.invite.token
  const accepted = await rpcAcceptInvite(b, inviteToken, hashB)
  return { a, b, hashA, hashB, inviteToken, wall, accepted }
}

// —————————————————————————————————————————————————————————————
// 启动：mock auth + 角色 + 迁移（跑两遍验证幂等）
// —————————————————————————————————————————————————————————————

async function setup() {
  await db.exec(MOCK_AUTH)
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  assert.ok(files.length > 0, 'supabase/migrations/ 下必须有 .sql 文件')
  for (const file of files) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  // 幂等：同一批迁移再跑一遍必须不报错。
  for (const file of files) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  console.log(`migrations applied twice: ${files.join(', ')}`)
}

try {
  await setup()
} catch (error) {
  console.error('迁移执行失败：')
  console.error(error)
  process.exit(1)
}

// —————————————————————————————————————————————————————————————
// 断言
// —————————————————————————————————————————————————————————————

await check('迁移：表与视图齐全，迁移可重复执行', async () => {
  const tables = (await rows(
    "select table_name from information_schema.tables where table_schema = 'public'",
  )).map((row) => row.table_name)
  for (const expected of ['dyad', 'seat', 'entry', 'invite', 'rebind_attempt', 'v_entry', 'v_seat']) {
    assert.ok(tables.includes(expected), `缺少 ${expected}`)
  }
  assert.equal(await scalar("select count(*)::int from pg_roles where rolname = 'anon'"), 1)
  assert.equal(await scalar("select count(*)::int from pg_roles where rolname = 'authenticated'"), 1)

  // 0003：seat.released_at + active 部分唯一索引（旧全局 UNIQUE 已移除）
  const seatColumns = (
    await rows(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'seat' order by ordinal_position",
    )
  ).map((row) => row.column_name)
  assert.ok(seatColumns.includes('released_at'), 'seat 必须有 released_at')
  assert.equal(
    await scalar(
      "select count(*)::int from pg_indexes where schemaname = 'public' and indexname = 'seat_active_user_uidx' and indexdef like '%released_at IS NULL%'",
    ),
    1,
    '必须存在 active 部分唯一索引',
  )
  assert.equal(
    await scalar(
      `select count(*)::int from pg_constraint
       where conrelid = 'public.seat'::regclass and contype = 'u'
         and conkey = array[(select attnum from pg_attribute
                             where attrelid = 'public.seat'::regclass and attname = 'user_id')]::smallint[]`,
    ),
    0,
    '旧的全局 UNIQUE(user_id) 必须已被移除',
  )
})

await check('create_wall：nascent 墙 + seat a + 32 字符邀请 + 7 天过期 + invite 只回显一次', async () => {
  const user = await newUser()
  const hash = keyHash('create-shape')
  const wall = await rpcCreateWall(user, hash)
  assert.deepEqual(Object.keys(wall), ['snapshot'])
  const snapshot = wall.snapshot
  assert.deepEqual(Object.keys(snapshot).sort(), ['dyad_id', 'invite', 'my_slot', 'seats', 'state'])
  assert.equal(snapshot.state, 'nascent')
  assert.equal(snapshot.my_slot, 'a')
  assert.equal(snapshot.seats.length, 1)
  assert.deepEqual(Object.keys(snapshot.seats[0]).sort(), ['joined_on', 'slot'])
  assert.equal(snapshot.seats[0].slot, 'a')
  assert.equal(snapshot.seats[0].joined_on, todayUtc())
  assert.deepEqual(Object.keys(snapshot.invite).sort(), ['expires_on', 'token'])
  assert.match(snapshot.invite.token, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(snapshot.invite.expires_on, shiftUtc(todayUtc(), 7))

  // 服务端只存 token 哈希 → 之后的 wall_state 不再回显明文（已向 Lead 报备）。
  const state = await rpcWallState(user)
  assert.equal(state.snapshot.invite, null)
  assert.equal(state.snapshot.dyad_id, snapshot.dyad_id)

  await expectCode(() => rpcCreateWall(user, keyHash('second')), 'already_seated')
  const fresh = await newUser()
  await expectCode(
    () => asUser(fresh, async () => db.query('select public.create_wall(null::bytea)')),
    'invalid_hash',
  )
  await expectCode(
    () => asUser(fresh, async () => db.query("select public.create_wall(decode('abcdef', 'hex'))")),
    'invalid_hash',
  )
})

await check('accept_invite：占 b、墙 open、seats 按 slot 升序、单次消费', async () => {
  const a = await newUser()
  const b = await newUser()
  const c = await newUser()
  const wall = await rpcCreateWall(a, keyHash('accept-a'))
  const token = wall.snapshot.invite.token
  const accepted = await rpcAcceptInvite(b, token, keyHash('accept-b'))
  assert.equal(accepted.snapshot.state, 'open')
  assert.equal(accepted.snapshot.my_slot, 'b')
  assert.deepEqual(
    accepted.snapshot.seats.map((seat) => seat.slot),
    ['a', 'b'],
  )
  assert.equal(accepted.snapshot.invite, null)

  // T4：二次消费失败
  await expectCode(() => rpcAcceptInvite(c, token, keyHash('accept-c')), 'invite_consumed')
  // 已在座者的错误优先
  await expectCode(() => rpcAcceptInvite(b, token, keyHash('accept-b2')), 'already_seated')
  // 未知 token
  await expectCode(() => rpcAcceptInvite(c, 'A'.repeat(32), keyHash('accept-x')), 'invite_unknown')
  await expectCode(() => rpcAcceptInvite(c, null, keyHash('accept-null')), 'invite_unknown')
  // 恢复哈希必须是 32 字节
  const d = await newUser()
  const wall2 = await rpcCreateWall((await newUser()), keyHash('accept-d-wall'))
  await expectCode(
    () => rpcAcceptInvite(d, wall2.snapshot.invite.token, 'abcdef'),
    'invalid_hash',
  )
})

await check('T4 邀请过期：expires_on 已过 → invite_expired；已消费优先于过期', async () => {
  const a = await newUser()
  const wall = await rpcCreateWall(a, keyHash('expire-a'))
  const token = wall.snapshot.invite.token
  const tokenHash = sha256(token)

  await db.query('update public.invite set expires_on = $1 where token_hash = decode($2, ' + "'hex'" + ')', [
    shiftUtc(todayUtc(), -1),
    tokenHash,
  ])
  const victim = await newUser()
  await expectCode(() => rpcAcceptInvite(victim, token, keyHash('expire-b')), 'invite_expired')

  await db.query(
    "update public.invite set consumed_at = now(), expires_on = $1 where token_hash = decode($2, 'hex')",
    [shiftUtc(todayUtc(), -2), tokenHash],
  )
  await expectCode(() => rpcAcceptInvite(victim, token, keyHash('expire-c')), 'invite_consumed')
})

await check('T1 第三方：v_entry / 基表零行；anon 无权限；RPC 拒绝', async () => {
  const { a } = await makePair('t1')
  await asUser(a, async () => {
    await db.query('select public.post_entry($1::uuid, $2::text, $3::date)', [
      randomUUID(),
      'a 的信',
      todayUtc(),
    ])
  })
  const third = await newUser()

  const viewRows = await asUser(third, async () => rows('select * from public.v_entry'))
  assert.equal(viewRows.length, 0, 'v_entry 应对第三方返回零行')

  const baseRows = await asUser(third, async () =>
    rows('select id, seq, slot, body, written_on from public.entry'),
  )
  assert.equal(baseRows.length, 0, '基表（列级 select）应在 RLS 下返回零行')

  await expectForbidden(async () => asAnon(async () => rows('select * from public.v_entry')), /permission denied/)

  const page = await rpcListEntries(third)
  assert.deepEqual(page, { entries: [], has_more: false })
  await expectCode(
    () =>
      asUser(third, async () =>
        db.query('select public.post_entry($1::uuid, $2::text, $3::date)', [
          randomUUID(),
          'x',
          todayUtc(),
        ]),
      ),
    'no_seat',
  )
  await expectCode(() => rpcWallState(third), 'no_seat')
})

await check('T2 视图字段集：v_entry(id,seq,slot,body,written_on) / v_seat(slot,joined_on)，无敏感列', async () => {
  const entryColumns = (
    await rows(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'v_entry' order by ordinal_position",
    )
  ).map((row) => row.column_name)
  assert.deepEqual(entryColumns, ['id', 'seq', 'slot', 'body', 'written_on'])

  const seatColumns = (
    await rows(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'v_seat' order by ordinal_position",
    )
  ).map((row) => row.column_name)
  assert.deepEqual(seatColumns, ['slot', 'joined_on'])

  const forbidden = await scalar(
    `select count(*)::int from information_schema.columns
     where table_schema = 'public' and table_name in ('v_entry', 'v_seat')
       and column_name in ('created_at', 'client_uuid', 'dyad_id', 'user_id', 'recovery_hash',
                           'read_at', 'online', 'last_seen', 'typing', 'delivered_at')`,
  )
  assert.equal(forbidden, 0, '视图不得包含敏感/过程列')

  const { a } = await makePair('t2')
  await expectForbidden(
    () => asUser(a, async () => rows('select created_at from public.entry')),
    /permission denied/,
  )
  await expectForbidden(
    () => asUser(a, async () => rows('select client_uuid from public.entry')),
    /permission denied/,
  )
  await expectForbidden(
    () => asUser(a, async () => rows('select * from public.entry')),
    /permission denied/,
  )
})

await check('T3 权限：entry 无 select/insert/update/delete 表级权限；视图只读', async () => {
  const privileges = await rows(
    `select
       has_table_privilege('authenticated', 'public.entry', 'SELECT') as entry_select,
       has_table_privilege('authenticated', 'public.entry', 'INSERT') as entry_insert,
       has_table_privilege('authenticated', 'public.entry', 'UPDATE') as entry_update,
       has_table_privilege('authenticated', 'public.entry', 'DELETE') as entry_delete,
       has_table_privilege('authenticated', 'public.seat', 'UPDATE') as seat_update,
       has_table_privilege('authenticated', 'public.v_entry', 'SELECT') as view_select,
       has_table_privilege('anon', 'public.v_entry', 'SELECT') as anon_view_select`,
  )
  const row = privileges[0]
  assert.equal(row.entry_select, false, 'entry 表级 SELECT 必须为假（列级权限见下一条）')
  assert.equal(row.entry_insert, false)
  assert.equal(row.entry_update, false)
  assert.equal(row.entry_delete, false)
  assert.equal(row.seat_update, false)
  assert.equal(row.view_select, true)
  assert.equal(row.anon_view_select, false)

  // security_invoker 视图需要列级 SELECT（已在文件头报备的差异）。
  assert.equal(
    await scalar("select has_any_column_privilege('authenticated', 'public.entry', 'SELECT')"),
    true,
  )

  const { a } = await makePair('t3')
  await expectForbidden(
    () => asUser(a, async () => db.query("update public.entry set body = '篡改'")),
    /permission denied/,
  )
  await expectForbidden(
    () => asUser(a, async () => db.query('delete from public.entry')),
    /permission denied/,
  )
  await expectForbidden(
    () =>
      asUser(a, async () =>
        db.query(
          "insert into public.entry (dyad_id, slot, body, written_on, client_uuid) values (gen_random_uuid(), 'a', 'x', current_date, gen_random_uuid())",
        ),
      ),
    /permission denied/,
  )

  // 白名单函数可执行，内部辅助函数不可执行；anon 不可执行任何 RPC。
  assert.equal(await scalar("select has_function_privilege('authenticated', 'public.create_wall(bytea)', 'EXECUTE')"), true)
  assert.equal(
    await scalar("select has_function_privilege('authenticated', 'public.snapshot_for(uuid,jsonb)', 'EXECUTE')"),
    false,
  )
  assert.equal(
    await scalar("select has_function_privilege('authenticated', 'public.entry_json(entry)', 'EXECUTE')"),
    false,
  )
  assert.equal(await scalar("select has_function_privilege('authenticated', 'public.my_slot()', 'EXECUTE')"), false)
  assert.equal(await scalar("select has_function_privilege('anon', 'public.create_wall(bytea)', 'EXECUTE')"), false)
})

await check('post_entry / list_entries：封缄的信、幂等、字段集、升序', async () => {
  const a = await newUser()
  const wall = await rpcCreateWall(a, keyHash('post-a'))
  const token = wall.snapshot.invite.token
  const b = await newUser()
  await rpcAcceptInvite(b, token, keyHash('post-b'))

  const sealed1 = await rpcPostEntry(a, randomUUID(), '封缄一', shiftUtc(todayUtc(), -1))
  const sealed2 = await rpcPostEntry(a, randomUUID(), '封缄二', todayUtc())
  const reply = await rpcPostEntry(b, randomUUID(), '回信', todayUtc())

  assert.deepEqual(Object.keys(sealed1).sort(), ['duplicate', 'entry'])
  assert.equal(sealed1.duplicate, false)
  assert.deepEqual(Object.keys(sealed1.entry).sort(), ['body', 'id', 'seq', 'slot', 'written_on'])

  const page = await rpcListEntries(b)
  assert.deepEqual(Object.keys(page).sort(), ['entries', 'has_more'])
  assert.deepEqual(
    page.entries.map((entry) => entry.body),
    ['封缄一', '封缄二', '回信'],
  )
  assert.deepEqual(
    page.entries.map((entry) => entry.slot),
    ['a', 'a', 'b'],
  )
  const seqs = page.entries.map((entry) => entry.seq)
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right))
  assert.ok(sealed1.entry.seq < sealed2.entry.seq)
  assert.ok(sealed2.entry.seq < reply.entry.seq)

  // 幂等重放（含 closed 后）
  const clientUuid = randomUUID()
  const first = await rpcPostEntry(a, clientUuid, '只寄一次', todayUtc())
  const replay = await rpcPostEntry(a, clientUuid, '重放文本不得改写', todayUtc())
  assert.equal(replay.duplicate, true)
  assert.equal(replay.entry.id, first.entry.id)
  assert.equal(replay.entry.body, '只寄一次')

  // 响应中不得出现敏感键
  const raw = JSON.stringify([wall, sealed1, page, replay])
  for (const forbidden of ['created_at', 'client_uuid', 'last_seen', 'online', 'typing', 'read_at']) {
    assert.equal(raw.includes(forbidden), false, `响应不得包含 ${forbidden}`)
  }
})

await check('post_entry：written_on ±2 日钳制、body 8000 码点边界与 invalid_body', async () => {
  const user = await newUser()
  await rpcCreateWall(user, keyHash('bounds'))
  const today = todayUtc()

  const keptMinus1 = await rpcPostEntry(user, randomUUID(), 'minus1', shiftUtc(today, -1))
  assert.equal(keptMinus1.entry.written_on, shiftUtc(today, -1))
  const keptMinus2 = await rpcPostEntry(user, randomUUID(), 'minus2', shiftUtc(today, -2))
  assert.equal(keptMinus2.entry.written_on, shiftUtc(today, -2))
  const clampedMinus3 = await rpcPostEntry(user, randomUUID(), 'minus3', shiftUtc(today, -3))
  assert.equal(clampedMinus3.entry.written_on, today)
  const keptPlus2 = await rpcPostEntry(user, randomUUID(), 'plus2', shiftUtc(today, 2))
  assert.equal(keptPlus2.entry.written_on, shiftUtc(today, 2))
  const clampedPlus3 = await rpcPostEntry(user, randomUUID(), 'plus3', shiftUtc(today, 3))
  assert.equal(clampedPlus3.entry.written_on, today)
  const clampedNull = await rpcPostEntry(user, randomUUID(), 'nulldate', null)
  assert.equal(clampedNull.entry.written_on, today)
  const clampedOld = await rpcPostEntry(user, randomUUID(), 'old', '2000-01-01')
  assert.equal(clampedOld.entry.written_on, today)

  const eightThousand = '字'.repeat(8000)
  const ok = await rpcPostEntry(user, randomUUID(), eightThousand, today)
  assert.equal(ok.entry.body, eightThousand)
  assert.equal([...ok.entry.body].length, 8000)

  await expectCode(() => rpcPostEntry(user, randomUUID(), '字'.repeat(8001), today), 'invalid_body')
  for (const blank of ['', ' ', '\n\t\n', '   \n  ']) {
    await expectCode(() => rpcPostEntry(user, randomUUID(), blank, today), 'invalid_body')
  }
  await expectCode(() => rpcPostEntry(user, randomUUID(), null, today), 'invalid_body')
})

await check('close_and_erase：唯一删除例外、墙 closed、不释放座位、重复幂等', async () => {
  const { a, b } = await makePair('close')
  const aFirst = await rpcPostEntry(a, randomUUID(), 'a 的信', todayUtc())
  await rpcPostEntry(b, randomUUID(), 'b 的信', todayUtc())
  const replayInput = { clientUuid: randomUUID(), body: 'a 的信 2' }
  const aSecond = await rpcPostEntry(a, replayInput.clientUuid, replayInput.body, todayUtc())

  const result = await rpcCloseAndErase(b)
  assert.deepEqual(result, {})

  const bState = await rpcWallState(b)
  assert.equal(bState.snapshot.state, 'closed')
  assert.equal(bState.snapshot.seats.length, 2, '座位不得释放（A1）')
  const bPage = await rpcListEntries(b)
  assert.deepEqual(
    bPage.entries.map((entry) => entry.body),
    ['a 的信', 'a 的信 2'],
    '只删除自己 slot 的留言',
  )

  const aState = await rpcWallState(a)
  assert.equal(aState.snapshot.state, 'closed')
  await expectCode(() => rpcPostEntry(a, randomUUID(), 'closed 后不可写', todayUtc()), 'wall_closed')

  // closed 后幂等重放仍命中
  const duplicateAfterClose = await rpcPostEntry(a, replayInput.clientUuid, replayInput.body, todayUtc())
  assert.equal(duplicateAfterClose.duplicate, true)
  assert.equal(duplicateAfterClose.entry.id, aSecond.entry.id)
  assert.equal(aFirst.entry.slot, 'a')

  // 重复销毁幂等
  assert.deepEqual(await rpcCloseAndErase(b), {})
  // 创建者也能销毁；双方文字清空
  assert.deepEqual(await rpcCloseAndErase(a), {})
  const finalPage = await rpcListEntries(a)
  assert.deepEqual(finalPage, { entries: [], has_more: false })
  const finalState = await rpcWallState(b)
  assert.equal(finalState.snapshot.state, 'closed')
  assert.equal(finalState.snapshot.seats.length, 2)
  assert.equal(finalState.snapshot.invite, null)

  // 无座位 → no_seat
  const stranger = await newUser()
  await expectCode(() => rpcCloseAndErase(stranger), 'no_seat')
})

await check('T5 rebind_seat：换 user_id 不改 slot/joined_on，旧 uid 零行；限流与 closed', async () => {
  const { a, b, hashA } = await makePair('rebind')
  const seatBefore = await rows(
    'select slot, joined_on::text as joined_on, dyad_id::text as dyad_id from public.seat where user_id = $1',
    [a],
  )
  await rpcPostEntry(a, randomUUID(), '换座前的信', todayUtc())

  const rescuer = await newUser()
  const rebound = await rpcRebind(rescuer, hashA)
  assert.equal(rebound.snapshot.my_slot, 'a')
  assert.equal(rebound.snapshot.dyad_id, seatBefore[0].dyad_id)

  const seatAfter = await rows(
    'select slot, joined_on::text as joined_on, dyad_id::text as dyad_id from public.seat where user_id = $1',
    [rescuer],
  )
  assert.equal(seatAfter.length, 1)
  assert.equal(seatAfter[0].slot, 'a')
  assert.equal(seatAfter[0].joined_on, seatBefore[0].joined_on, 'joined_on 不得改变')

  // 旧 uid：仍可登录（auth 不变），但读取零行 / no_seat
  const oldViewRows = await asUser(a, async () => rows('select * from public.v_entry'))
  assert.equal(oldViewRows.length, 0)
  const oldPage = await rpcListEntries(a)
  assert.deepEqual(oldPage, { entries: [], has_more: false })
  await expectCode(() => rpcWallState(a), 'no_seat')

  // 新 uid 能读到全部留言
  const newPage = await rpcListEntries(rescuer)
  assert.deepEqual(
    newPage.entries.map((entry) => entry.body),
    ['换座前的信'],
  )
  const newViewRows = await asUser(rescuer, async () => rows('select * from public.v_entry'))
  assert.equal(newViewRows.length, 1)

  // 已在座者不能 rebind；格式错/无匹配 invalid_hash（错误以 {error} 返回，见文件头）
  await expectRpcError(() => rpcRebind(rescuer, hashA), 'already_seated')
  const stranger = await newUser()
  await expectRpcError(() => rpcRebind(stranger, 'abcdef'), 'invalid_hash')
  await expectRpcError(() => rpcRebind(stranger, keyHash('no-match')), 'invalid_hash')

  // 关闭的墙不可换座
  const closer = await newUser()
  const closerHash = keyHash('rebind-closed')
  await rpcCreateWall(closer, closerHash)
  await rpcCloseAndErase(closer)
  const late = await newUser()
  await expectRpcError(() => rpcRebind(late, closerHash), 'wall_closed')

  // 限流：先计数后业务校验；失败与通过都计，1 小时 5 次
  const throttledUser = await newUser()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expectRpcError(() => rpcRebind(throttledUser, keyHash(`throttle-${attempt}`)), 'invalid_hash')
  }
  await expectRpcError(() => rpcRebind(throttledUser, keyHash('throttle-final')), 'throttled')
  assert.equal(await scalar('select count(*)::int from public.rebind_attempt where user_id = $1', [throttledUser]), 5)
  // 另一个调用者不受影响
  const otherUser = await newUser()
  await expectRpcError(() => rpcRebind(otherUser, keyHash('throttle-other')), 'invalid_hash')

  // 对方座位不受影响（b 仍在座）
  const bState = await rpcWallState(b)
  assert.equal(bState.snapshot.seats.length, 2)
})

await check('T6 一人一墙：seat.user_id UNIQUE 阻止跨墙占座；create_wall 二次被拒', async () => {
  const { a, inviteToken } = await makePair('t6')
  // 已在座者接受另一墙邀请 → already_seated
  const otherHost = await newUser()
  const otherWall = await rpcCreateWall(otherHost, keyHash('t6-other'))
  const seated = await newUser()
  await rpcAcceptInvite(seated, otherWall.snapshot.invite.token, keyHash('t6-seated'))
  await expectCode(() => rpcAcceptInvite(seated, inviteToken, keyHash('t6-x')), 'already_seated')

  // 数据库级 UNIQUE(seat.user_id)：直接插入第二个座位被拒
  const otherWall2 = await rpcCreateWall(await newUser(), keyHash('t6-other2'))
  await expectForbidden(
    () =>
      db.query(
        "insert into public.seat (dyad_id, slot, user_id, recovery_hash) values ($1::uuid, 'b', $2::uuid, decode($3, 'hex'))",
        [otherWall2.snapshot.dyad_id, a, keyHash('t6-dup')],
      ),
    /duplicate key|unique constraint/i,
  )
})

await check('T7 外键 ON DELETE RESTRICT：删除匿名主体被 seat 阻止（A4）', async () => {
  const { a } = await makePair('t7')
  await expectForbidden(
    () => db.query('delete from auth.users where id = $1', [a]),
    /foreign key|constraint/i,
  )
  // 无座位的匿名主体可以清理（RESTRICT 只保护在座者）
  const unseated = await newUser()
  await db.query('delete from auth.users where id = $1', [unseated])
  assert.equal(await scalar('select count(*)::int from auth.users where id = $1', [unseated]), 0)
})

await check('revoke_other_sessions：删除该主体除当前 session 外的登录凭据，幂等', async () => {
  const user = await newUser()
  const session1 = randomUUID()
  const session2 = randomUUID()
  const session3 = randomUUID()
  await db.query('insert into auth.sessions (id, user_id) values ($1, $2), ($3, $2), ($4, $2)', [
    session1,
    user,
    session2,
    session3,
  ])

  const result = await rpcRevokeOthers(user, session1)
  assert.deepEqual(result, {})
  const remaining = (await rows('select id from auth.sessions where user_id = $1', [user])).map(
    (row) => row.id,
  )
  assert.deepEqual(remaining, [session1])

  assert.deepEqual(await rpcRevokeOthers(user, session1), {})
  // 没有 session_id claim 时不动任何东西
  await db.query('insert into auth.sessions (id, user_id) values ($1, $2)', [session2, user])
  assert.deepEqual(await rpcRevokeOthers(user, null), {})
  assert.equal(await scalar('select count(*)::int from auth.sessions where user_id = $1', [user]), 2)
})

await check('未认证 / 匿名直接调用 RPC 被拒绝', async () => {
  await expectForbidden(
    () => asAnon(async () => db.query('select public.create_wall(decode($1, ' + "'hex'" + '))', [keyHash('anon')])),
    /permission denied/,
  )
  // authenticated 角色但没有 sub claim → unauthorized
  const noClaims = await newUser()
  await db.exec('set role authenticated')
  try {
    await db.query(`select set_config('request.jwt.claims', '{}', false)`)
    await expectCode(() => db.query('select public.create_wall(decode($1, ' + "'hex'" + '))', [keyHash('noclaim')]), 'unauthorized')
  } finally {
    await db.exec('reset role')
  }
  assert.equal(await scalar("select count(*)::int from public.seat where user_id = $1", [noClaims]), 0)
})

await check('leave_closed_wall：closed 前 wall_not_closed；closed 后释放座位、可建新墙、对方仍可读', async () => {
  const a = await newUser()
  const b = await newUser()
  const hashA = keyHash('leave-a')
  const hashB = keyHash('leave-b')
  const wall = await rpcCreateWall(a, hashA)
  const dyadId = wall.snapshot.dyad_id
  const token = wall.snapshot.invite.token
  await rpcAcceptInvite(b, token, hashB)
  await rpcPostEntry(a, randomUUID(), 'a-entry', todayUtc())
  await rpcPostEntry(b, randomUUID(), 'b-entry', todayUtc())

  // 墙未 closed 时不能离开
  await expectCode(() => rpcLeaveClosedWall(a), 'wall_not_closed')
  const fresh = await newUser()
  await expectCode(() => rpcLeaveClosedWall(fresh), 'no_seat')

  // a 行使销毁权：墙 closed，座位不释放（既有语义不变）
  assert.deepEqual(await rpcCloseAndErase(a), {})
  const afterClose = await rpcWallState(a)
  assert.equal(afterClose.snapshot.state, 'closed')
  assert.equal(afterClose.snapshot.seats.length, 2, 'close_and_erase 仍不释放座位')
  assert.deepEqual(
    (await rpcListEntries(b)).entries.map((entry) => entry.body),
    ['b-entry'],
    'a 的留言被删，b 的保留',
  )

  // a 离开：座位释放（保留历史行），旧 uid 零行 / no_seat
  assert.deepEqual(await rpcLeaveClosedWall(a), {})
  await expectCode(() => rpcWallState(a), 'no_seat')
  assert.deepEqual(await rpcListEntries(a), { entries: [], has_more: false })
  assert.equal((await asUser(a, async () => rows('select * from public.v_entry'))).length, 0)
  await expectCode(() => rpcLeaveClosedWall(a), 'no_seat')

  // a 之后可以建新墙；仍受一人一墙约束
  const newWall = await rpcCreateWall(a, keyHash('leave-new'))
  assert.equal(newWall.snapshot.state, 'nascent')
  await expectCode(() => rpcCreateWall(a, keyHash('leave-again')), 'already_seated')

  // 历史 seat 行保留：slot / joined_on 不变，released_at 非空
  const released = await rows(
    "select slot, joined_on::text as joined_on, released_at is not null as released from public.seat where dyad_id = $1 and slot = 'a'",
    [dyadId],
  )
  assert.equal(released.length, 1)
  assert.equal(released[0].slot, 'a')
  assert.equal(released[0].joined_on, todayUtc())
  assert.equal(released[0].released, true)

  // 对方（仍 active）仍可读 closed 墙；seats 历史列表长度不变
  const bState = await rpcWallState(b)
  assert.equal(bState.snapshot.state, 'closed')
  assert.equal(bState.snapshot.seats.length, 2)
  assert.deepEqual(
    (await rpcListEntries(b)).entries.map((entry) => entry.body),
    ['b-entry'],
  )

  // 已释放座位的恢复密钥不能换回
  const rescuer = await newUser()
  assert.deepEqual(await rpcRebind(rescuer, hashA), { error: 'invalid_hash' })

  // b 也离开：双方都不可读，留言清空，两个历史座位都标记 released
  assert.deepEqual(await rpcLeaveClosedWall(b), {})
  await expectCode(() => rpcWallState(b), 'no_seat')
  assert.deepEqual(await rpcListEntries(b), { entries: [], has_more: false })
  assert.equal(await scalar('select count(*)::int from public.entry where dyad_id = $1', [dyadId]), 0)
  assert.equal(
    await scalar('select count(*)::int from public.seat where dyad_id = $1 and released_at is not null', [dyadId]),
    2,
  )

  // T6：活跃座位仍唯一（a 已在新墙在座，不能插入第二个 active 座位）
  const otherHost = await newUser()
  const otherWall = await rpcCreateWall(otherHost, keyHash('leave-t6'))
  await expectForbidden(
    () =>
      db.query(
        "insert into public.seat (dyad_id, slot, user_id, recovery_hash) values ($1::uuid, 'b', $2::uuid, decode($3, 'hex'))",
        [otherWall.snapshot.dyad_id, a, keyHash('leave-dup')],
      ),
    /duplicate key|unique constraint/i,
  )
  // b 已离座（released 不阻塞新座位）→ 可以接受邀请重新在座
  const bJoins = await rpcAcceptInvite(b, otherWall.snapshot.invite.token, keyHash('leave-b-join'))
  assert.equal(bJoins.snapshot.state, 'open')
  assert.equal(bJoins.snapshot.my_slot, 'b')
})

await check('分页：before_seq + limit 上限 120 + has_more', async () => {
  const user = await newUser()
  await rpcCreateWall(user, keyHash('paging'))
  for (let index = 0; index < 125; index += 1) {
    await rpcPostEntry(user, randomUUID(), `p${index}`, todayUtc())
  }
  const latest = await rpcListEntries(user, null, 1000)
  assert.equal(latest.entries.length, 120)
  assert.equal(latest.has_more, true)
  assert.equal(latest.entries[0].body, 'p5')
  assert.equal(latest.entries[119].body, 'p124')

  const older = await rpcListEntries(user, latest.entries[0].seq, 10)
  assert.equal(older.entries.length, 5)
  assert.equal(older.has_more, false)
  assert.deepEqual(
    older.entries.map((entry) => entry.body),
    ['p0', 'p1', 'p2', 'p3', 'p4'],
  )
  const fallback = await rpcListEntries(user, null, 0)
  assert.equal(fallback.entries.length, 120)
})

// —————————————————————————————————————————————————————————————
// 汇总
// —————————————————————————————————————————————————————————————

console.log('')
if (failures.length === 0) {
  console.log(`SQL 验收通过：${passed} 项全部通过（PGlite）`)
  await db.close()
  process.exit(0)
} else {
  console.error(`SQL 验收失败：${failures.length} 项失败 / ${passed + failures.length} 项`)
  await db.close()
  process.exit(1)
}
