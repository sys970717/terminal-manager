// sendToOwner: 닫힌 owner 에는 send 를 부르지 않는다. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendToOwner } from '../ownerSend.ts'

interface Fake {
  calls: unknown[][]
  isDestroyed(): boolean
  send(...a: unknown[]): void
}
const fake = (destroyed: boolean, throws = false): Fake => {
  const calls: unknown[][] = []
  return {
    calls,
    isDestroyed: () => destroyed,
    send: (...a: unknown[]) => {
      if (throws) throw new Error('Object has been destroyed')
      calls.push(a)
    }
  }
}

test('살아 있는 owner 에는 채널과 인자를 그대로 보낸다', () => {
  const o = fake(false)
  assert.equal(sendToOwner(o, 'term:data', 1, 'x'), true)
  assert.deepEqual(o.calls, [['term:data', 1, 'x']])
})

test('닫힌 owner 에는 send 호출이 0회다', () => {
  const o = fake(true)
  assert.equal(sendToOwner(o, 'term:data', 1, 'x'), false)
  assert.equal(sendToOwner(o, 'term:exit', 1, 0), false)
  assert.equal(o.calls.length, 0)
})

test('확인 직후 창이 닫혀 send 가 던져도 전파하지 않는다', () => {
  assert.equal(sendToOwner(fake(false, true), 'term:data', 1, 'x'), false)
})
