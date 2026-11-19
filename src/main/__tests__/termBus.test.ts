// termBus(렌더러 term:data 단일 구독) 단위 테스트. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTermBus, type TermBusApi, type TermHandlers } from '../../renderer/src/termBus.ts'

interface Fake {
  api: TermBusApi
  emitData(id: number, d: string): void
  emitExit(id: number, c: number, r?: string): void
  subs(): number
}
function fakeApi(): Fake {
  const data = new Set<(id: number, d: string) => void>()
  const exit = new Set<(id: number, c: number, r?: string) => void>()
  return {
    api: {
      onData: (cb) => {
        data.add(cb)
        return () => data.delete(cb)
      },
      onExit: (cb) => {
        exit.add(cb)
        return () => exit.delete(cb)
      }
    },
    emitData: (id, d) => data.forEach((cb) => cb(id, d)),
    emitExit: (id, c, r) => exit.forEach((cb) => cb(id, c, r)),
    subs: () => data.size + exit.size
  }
}
const handlers = (): { got: string[]; h: TermHandlers } => {
  const got: string[] = []
  return {
    got,
    h: {
      onData: (d) => void got.push('d:' + d),
      onExit: (c, r) => void got.push('x:' + c + (r ? ':' + r : ''))
    }
  }
}

test('슬롯이 10개여도 IPC 구독은 data 1 + exit 1 이고, 모두 닫으면 0 이다', () => {
  const f = fakeApi()
  const bus = createTermBus(f.api)
  const slots = Array.from({ length: 10 }, () => bus.open(handlers().h))
  assert.equal(f.subs(), 2)
  slots.forEach((s) => s.dispose())
  assert.equal(f.subs(), 0)
  assert.deepEqual(bus.stats(), { slots: 0, bound: 0, queued: 0 })
})

test('termId 별로만 분배한다', () => {
  const f = fakeApi()
  const bus = createTermBus(f.api)
  const a = handlers()
  const b = handlers()
  const sa = bus.open(a.h)
  const sb = bus.open(b.h)
  sa.begin()
  sa.bind(1)
  sb.begin()
  sb.bind(2)
  f.emitData(1, 'A')
  f.emitData(2, 'B')
  assert.deepEqual(a.got, ['d:A'])
  assert.deepEqual(b.got, ['d:B'])
})

test('connect 응답보다 먼저 온 이벤트는 bind 때 순서대로 재생한다', () => {
  const f = fakeApi()
  const bus = createTermBus(f.api)
  const a = handlers()
  const s = bus.open(a.h)
  s.begin()
  f.emitData(7, 'x')
  f.emitData(7, 'y')
  f.emitExit(7, 1, 'boom')
  s.bind(7)
  assert.deepEqual(a.got, ['d:x', 'd:y', 'x:1:boom'])
  assert.deepEqual(bus.stats(), { slots: 1, bound: 0, queued: 0 })
})

test('exit 후 Map 에 termId 가 남지 않고, abort/dispose 후 보관분이 비워진다', () => {
  const f = fakeApi()
  const bus = createTermBus(f.api)
  const s = bus.open(handlers().h)
  s.begin()
  s.bind(3)
  f.emitExit(3, 0)
  assert.equal(bus.stats().bound, 0)
  s.begin()
  f.emitData(9, 'orphan')
  assert.equal(bus.stats().queued, 1)
  s.abort()
  assert.equal(bus.stats().queued, 0)
  f.emitData(9, 'late') // 대기 슬롯이 없으면 버린다
  assert.equal(bus.stats().queued, 0)
  s.dispose()
  s.dispose() // 이중 dispose 안전
  assert.equal(f.subs(), 0)
})

test('보관 상한(4MB)을 넘는 이벤트는 버린다', () => {
  const f = fakeApi()
  const bus = createTermBus(f.api)
  const s = bus.open(handlers().h)
  s.begin()
  f.emitData(5, 'a'.repeat(4 * 1024 * 1024))
  f.emitData(5, 'b')
  assert.equal(bus.stats().queued, 1)
  s.dispose()
})
