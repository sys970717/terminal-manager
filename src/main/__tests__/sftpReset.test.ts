// SFTP 채널 보관소(sftpHolder) 단위 테스트: 끊김→재연결 뒤 상태 초기화. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSftpHolder, type SftpHolder, type SftpLike } from '../sftpHolder.ts'
import { createGauge, type Gauge } from '../gauge.ts'

class FakeSftp implements SftpLike {
  closed = false
  private cbs: (() => void)[] = []
  end(): void {
    if (this.closed) return
    this.closed = true
    this.cbs.forEach((cb) => cb()) // 실제 ssh2 처럼 end 뒤 close 이벤트
  }
  once(_ev: 'close', cb: () => void): void {
    this.cbs.push(cb)
  }
}

interface FakeConn {
  holder: SftpHolder<FakeSftp>
  gauge: Gauge
  opened: FakeSftp[]
  pendingOpens(): number
  finishOpen(): FakeSftp
  setEnded(v: boolean): boolean
}

/** open 콜백을 테스트가 원하는 때 부르게 하는 가짜 연결 */
function fakeConn(): FakeConn {
  const gauge = createGauge()
  const opened: FakeSftp[] = []
  const waiting: ((err: Error | null, s: FakeSftp) => void)[] = []
  let ended = false
  const holder = createSftpHolder<FakeSftp>({
    open: (cb) => waiting.push(cb),
    isEnded: () => ended,
    acquire: () => gauge.acquire(),
    endedError: () => new Error('ended')
  })
  return {
    holder,
    gauge,
    opened,
    pendingOpens: () => waiting.length,
    /** 대기 중인 open 하나를 성공시킨다 */
    finishOpen() {
      const s = new FakeSftp()
      opened.push(s)
      waiting.shift()!(null, s)
      return s
    },
    setEnded: (v: boolean) => (ended = v)
  }
}

test('동시에 여러 번 요청해도 SFTP 채널은 1개만 연다', async () => {
  const c = fakeConn()
  const ps = [c.holder.get(), c.holder.get(), c.holder.get()]
  assert.equal(c.pendingOpens(), 1)
  assert.equal(c.holder.opening, true)
  c.finishOpen()
  const got = await Promise.all(ps)
  assert.equal(got[0], got[1])
  assert.equal(c.holder.opening, false)
  assert.equal(c.gauge.value, 1)
})

test('끊김(reset) 뒤 sftpOpening·home 이 비고, 재연결 후 채널이 1개만 새로 열린다', async () => {
  const c = fakeConn()
  const p1 = c.holder.get()
  c.finishOpen()
  const s1 = await p1
  assert.equal(await c.holder.home(async () => '/srv/a'), '/srv/a')

  c.holder.reset() // conn 의 close/end
  assert.equal(c.holder.opening, false)
  assert.equal(c.holder.hasChannel, false)
  assert.equal(s1.closed, true)
  assert.equal(c.gauge.value, 0, 'gauges.sftp 가 0 으로 돌아온다')

  // 재연결: home 캐시도 새로 구한다
  const p2 = c.holder.get()
  assert.equal(c.pendingOpens(), 1)
  c.finishOpen()
  const s2 = await p2
  assert.notEqual(s1, s2)
  assert.equal(c.opened.length, 2)
  assert.equal(await c.holder.home(async () => '/srv/b'), '/srv/b')
  assert.equal(c.gauge.value, 1)
})

test('열리는 도중 끊기면 대기 중이던 요청은 reject, 늦게 온 채널은 닫혀 핸들이 새지 않는다', async () => {
  const c = fakeConn()
  const p = c.holder.get()
  const rejected = assert.rejects(p, /ended/)
  c.holder.reset()
  await rejected
  assert.equal(c.holder.opening, false)
  const late = c.finishOpen() // reset 뒤에 도착
  assert.equal(late.closed, true)
  assert.equal(c.holder.hasChannel, false)
  assert.equal(c.gauge.value, 0)
  // reset 뒤 새 요청은 새 open 을 연다 (이전 요청이 남긴 opening 에 붙지 않는다)
  void c.holder.get().catch(() => {})
  assert.equal(c.pendingOpens(), 1)
})

test('연결이 끝난 뒤 열린 채널은 쓰지 않고 닫는다 (ended 확인 유지)', async () => {
  const c = fakeConn()
  const p = c.holder.get()
  c.setEnded(true)
  const rejected = assert.rejects(p, /ended/)
  const s = c.finishOpen()
  await rejected
  assert.equal(s.closed, true)
  assert.equal(c.gauge.value, 0)
  assert.equal(c.holder.opening, false)
})

test('채널이 스스로 닫히면(close) 다음 요청이 새 채널을 연다', async () => {
  const c = fakeConn()
  const p = c.holder.get()
  const s1 = c.finishOpen()
  await p
  s1.end()
  assert.equal(c.holder.hasChannel, false)
  assert.equal(c.gauge.value, 0)
  void c.holder.get()
  assert.equal(c.pendingOpens(), 1)
})

test('reset 을 여러 번 불러도 안전하다 (멱등)', async () => {
  const c = fakeConn()
  const p = c.holder.get()
  c.finishOpen()
  await p
  c.holder.reset()
  c.holder.reset()
  assert.equal(c.gauge.value, 0)
  assert.equal(c.holder.hasChannel, false)
})

test('open 이 동기로 던져도 opening 이 남지 않는다', async () => {
  const gauge = createGauge()
  const h = createSftpHolder<FakeSftp>({
    open: () => {
      throw new Error('boom')
    },
    isEnded: () => false,
    acquire: () => gauge.acquire(),
    endedError: () => new Error('ended')
  })
  await assert.rejects(h.get(), /boom/)
  assert.equal(h.opening, false)
})
