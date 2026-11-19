import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGauge } from '../gauge.ts'

test('acquire 는 올리고 release 는 내린다', () => {
  const g = createGauge()
  const r1 = g.acquire()
  const r2 = g.acquire()
  assert.equal(g.value, 2)
  r1()
  assert.equal(g.value, 1)
  r2()
  assert.equal(g.value, 0)
})

test('release 를 여러 번 불러도 한 번만 내린다 (이중 해제로 음수가 되지 않는다)', () => {
  const g = createGauge()
  const other = g.acquire()
  const r = g.acquire()
  r()
  r()
  r()
  assert.equal(g.value, 1)
  other()
  assert.equal(g.value, 0)
})
