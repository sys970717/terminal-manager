// detach 핸드셰이크(windows.ts) 단위 테스트: 성공 / 15초 초과 / 창 닫힘 / 다른 창 신호 무시. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDetachManager,
  registerWindowHandlers,
  DETACH_TIMEOUT_MS,
  MAX_PENDING_DETACH,
  type DetachDeps,
  type DetachManager,
  type DetachWindow,
  type IpcLike
} from '../windows.ts'

type FakeWin = DetachWindow & { closedCalls: number; fireClosed(): void }

interface Setup {
  mgr: DetachManager
  wins: FakeWin[]
  timers: Map<number, { fn: () => void; ms: number }>
  deps: DetachDeps
}

function setup(): Setup {
  let nextWin = 100
  let nextTok = 1
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextTimer = 1
  const wins: FakeWin[] = []
  const deps = {
    openWindow: (): FakeWin => {
      const id = nextWin++
      let destroyed = false
      let cb: (() => void) | null = null
      const w: FakeWin = {
        id,
        webContentsId: id + 1000,
        closedCalls: 0,
        isDestroyed: () => destroyed,
        close() {
          w.closedCalls++
          destroyed = true
        },
        onClosed(f: () => void) {
          cb = f
        },
        fireClosed() {
          destroyed = true
          cb?.()
        }
      }
      wins.push(w)
      return w
    },
    isSshSession: (id: string) => id.startsWith('ssh-'),
    newToken: () => `tok-${nextTok++}`,
    setTimer: (fn: () => void, ms: number) => {
      const h = nextTimer++
      timers.set(h, { fn, ms })
      return h
    },
    clearTimer: (h: unknown) => void timers.delete(h as number)
  }
  const mgr = createDetachManager(deps)
  return { mgr, wins, timers, deps }
}

test('성공: main 이 셸 열림을 관측하면 {ok:true, windowId}, 타이머·토큰이 비워진다', async () => {
  const s = setup()
  const p = s.mgr.detach('ssh-1')
  const init = s.mgr.getInit(s.wins[0].webContentsId)
  assert.equal(init.detach?.sessionId, 'ssh-1')
  assert.equal(s.mgr.pendingCount, 1)
  assert.equal(s.timers.size, 1)
  assert.equal([...s.timers.values()][0].ms, DETACH_TIMEOUT_MS)
  s.mgr.shellOpened(s.wins[0].webContentsId)
  assert.deepEqual(await p, { ok: true, windowId: s.wins[0].id })
  assert.equal(s.mgr.pendingCount, 0)
  assert.equal(s.timers.size, 0)
  assert.equal(s.wins[0].closedCalls, 0, '성공하면 새 창을 닫지 않는다')
  assert.deepEqual(s.mgr.getInit(s.wins[0].webContentsId), {}, '토큰은 한 번만 쓴다')
})

test('15초 초과: {ok:false, timeout} 이고 새 창을 닫는다', async () => {
  const s = setup()
  const p = s.mgr.detach('ssh-1')
  const [t] = [...s.timers.values()]
  t.fn() // 타이머 만료
  assert.deepEqual(await p, { ok: false, reason: 'timeout' })
  assert.equal(s.wins[0].closedCalls, 1)
  assert.equal(s.mgr.pendingCount, 0)
  assert.equal(s.timers.size, 0)
})

test('준비 전에 새 창이 닫히면 {ok:false, failed} 이고 타이머를 해제한다', async () => {
  const s = setup()
  const p = s.mgr.detach('ssh-1')
  s.wins[0].fireClosed()
  assert.deepEqual(await p, { ok: false, reason: 'failed' })
  assert.equal(s.mgr.pendingCount, 0)
  assert.equal(s.timers.size, 0)
  assert.equal(s.wins[0].closedCalls, 0, '이미 닫힌 창은 다시 닫지 않는다')
})

test('renderer 가 보낸 detachReady 는 성공으로 치지 않는다 (connectSsh 응답은 termId 발급일 뿐이다)', async () => {
  const s = setup()
  const p = s.mgr.detach('ssh-1')
  const wc = s.wins[0].webContentsId
  s.mgr.ready(wc, s.mgr.getInit(wc).detach!.token) // 연결 전에 먼저 도착한 신호
  assert.equal(s.mgr.pendingCount, 1, '아직 대기 중')
  assert.equal(s.timers.size, 1)
  ;[...s.timers.values()][0].fn() // SSH 가 끝내 연결되지 않아 15초 초과
  assert.deepEqual(await p, { ok: false, reason: 'timeout' })
  assert.equal(s.wins[0].closedCalls, 1, '실패하면 새 창을 닫는다')
})

test('SSH 연결 오류(shellFailed)면 15초를 기다리지 않고 실패, 새 창을 닫고 타이머를 해제한다', async () => {
  const s = setup()
  const p = s.mgr.detach('ssh-1')
  s.mgr.shellFailed(s.wins[0].webContentsId)
  assert.deepEqual(await p, { ok: false, reason: 'failed' })
  assert.equal(s.wins[0].closedCalls, 1)
  assert.equal(s.mgr.pendingCount, 0)
  assert.equal(s.timers.size, 0)
})

test('다른 창의 셸 열림/실패 신호는 무시한다', async () => {
  const s = setup()
  const p = s.mgr.detach('ssh-1')
  s.mgr.shellOpened(9999)
  s.mgr.shellFailed(9999)
  assert.equal(s.mgr.pendingCount, 1)
  s.mgr.shellOpened(s.wins[0].webContentsId)
  assert.equal((await p).ok, true)
  // 성공 뒤의 늦은 신호는 아무 일도 없다
  s.mgr.shellFailed(s.wins[0].webContentsId)
  s.mgr.shellOpened(s.wins[0].webContentsId)
})

test('다른 창이 보낸 ready 나 잘못된 토큰은 무시한다', async () => {
  const s = setup()
  const p = s.mgr.detach('ssh-1')
  const token = s.mgr.getInit(s.wins[0].webContentsId).detach!.token
  s.mgr.ready(9999, token) // 토큰 소유자가 아닌 webContents
  s.mgr.ready(s.wins[0].webContentsId, 'tok-wrong')
  s.mgr.ready(s.wins[0].webContentsId, 123)
  assert.equal(s.mgr.pendingCount, 1)
  assert.deepEqual(s.mgr.getInit(9999), {}, '다른 창은 detach 정보를 받지 못한다')
  s.wins[0].fireClosed()
  assert.equal((await p).ok, false)
})

test('성공 뒤에 늦게 온 창 닫힘은 결과를 바꾸지 않는다 (한 번만 응답)', async () => {
  const s = setup()
  const p = s.mgr.detach('ssh-1')
  s.mgr.shellOpened(s.wins[0].webContentsId)
  s.wins[0].fireClosed()
  assert.equal((await p).ok, true)
  assert.equal(s.mgr.pendingCount, 0)
})

test('SSH 세션이 아니거나 문자열이 아니면 not-ssh, 창을 만들지 않는다', async () => {
  const s = setup()
  for (const bad of [undefined, null, 5, '', {}, 'local-1', 'x'.repeat(300)])
    assert.deepEqual(await s.mgr.detach(bad), { ok: false, reason: 'not-ssh' })
  assert.equal(s.wins.length, 0)
  assert.equal(s.timers.size, 0)
})

test('창 생성이 던지면 failed 이고 대기 항목을 남기지 않는다', async () => {
  const s = setup()
  const mgr = createDetachManager({
    ...s.deps,
    openWindow: () => {
      throw new Error('boom')
    }
  })
  assert.deepEqual(await mgr.detach('ssh-1'), { ok: false, reason: 'failed' })
  assert.equal(mgr.pendingCount, 0)
})

test(`동시 대기는 ${MAX_PENDING_DETACH}개까지, 초과는 failed`, async () => {
  const s = setup()
  const ps = Array.from({ length: MAX_PENDING_DETACH }, () => s.mgr.detach('ssh-1'))
  assert.deepEqual(await s.mgr.detach('ssh-1'), { ok: false, reason: 'failed' })
  assert.equal(s.wins.length, MAX_PENDING_DETACH)
  s.wins.forEach((w) => w.fireClosed())
  await Promise.all(ps)
  assert.equal(s.mgr.pendingCount, 0)
  assert.equal(s.timers.size, 0)
})

test('5회 열고 닫아도 타이머·대기 토큰이 남지 않는다 (성공·시간초과·닫힘 섞어서)', async () => {
  const s = setup()
  for (let i = 0; i < 5; i++) {
    const p = s.mgr.detach('ssh-1')
    const w = s.wins[i]
    if (i % 3 === 0) s.mgr.shellOpened(w.webContentsId)
    else if (i % 3 === 1) [...s.timers.values()][0].fn()
    else w.fireClosed()
    await p
    assert.equal(s.mgr.pendingCount, 0)
    assert.equal(s.timers.size, 0)
  }
})

test('핸들러는 한 번만 등록한다 (두 번 불러도 같은 매니저, 채널 중복 등록 없음)', () => {
  const s = setup()
  const channels: string[] = []
  const ipc: IpcLike = {
    handle: (ch) => void channels.push('h:' + ch),
    on: (ch) => void channels.push('o:' + ch)
  }
  const a = registerWindowHandlers(ipc, s.deps)
  const b = registerWindowHandlers(ipc, s.deps)
  assert.equal(a, b)
  assert.deepEqual(channels, ['h:win:detachSsh', 'h:win:getInit', 'o:win:detachReady'])
})

test('소스 연결: ssh.ts 는 셸을 연 뒤 emit.ready 를, terms.ts 는 이를 notifyShellOpened/Failed 로 잇는다', async () => {
  const { readFileSync } = await import('node:fs')
  const ssh = readFileSync(new URL('../ssh.ts', import.meta.url), 'utf8')
  const terms = readFileSync(new URL('../terms.ts', import.meta.url), 'utf8')
  const shellCb = ssh.slice(ssh.indexOf('conn.shell('))
  assert.ok(
    shellCb.indexOf('stream = ch') < shellCb.indexOf('emit.ready?.()'),
    'stream 확보 뒤에 ready'
  )
  assert.match(terms, /notifyShellOpened\(owner\.id\)/)
  assert.match(terms, /notifyShellFailed\(owner\.id\)/)
})
