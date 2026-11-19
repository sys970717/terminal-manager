import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTermRegistry } from '../termRegistry.ts'

const mk = (): { kills: number; kill(): void } => ({
  kills: 0,
  kill() {
    this.kills++
  }
})

test('kill 은 레지스트리에서 지우고 backend.kill 을 한 번만 부른다 (멱등)', () => {
  const reg = createTermRegistry<ReturnType<typeof mk>, object>()
  const b = mk()
  reg.add(1, {}, b)
  reg.kill(1)
  reg.kill(1)
  assert.equal(b.kills, 1)
  assert.equal(reg.size, 0)
  assert.equal(reg.ownerSize, 0)
})

test('remove 는 kill 없이 Map 만 비운다 (백엔드가 스스로 종료한 경우)', () => {
  const reg = createTermRegistry<ReturnType<typeof mk>, object>()
  const b = mk()
  reg.add(1, {}, b)
  assert.equal(reg.remove(1), true)
  assert.equal(reg.remove(1), false)
  reg.kill(1) // 이미 없으니 아무 일도 없다
  assert.equal(b.kills, 0)
  assert.equal(reg.size, 0)
  assert.equal(reg.ownerSize, 0)
})

test('killOwner 는 그 소유자의 터미널만 정리한다', () => {
  const reg = createTermRegistry<ReturnType<typeof mk>, object>()
  const w1 = {}
  const w2 = {}
  const [a, b, c] = [mk(), mk(), mk()]
  reg.add(1, w1, a)
  reg.add(2, w1, b)
  reg.add(3, w2, c)
  reg.killOwner(w1)
  assert.deepEqual([a.kills, b.kills, c.kills], [1, 1, 0])
  assert.equal(reg.size, 1)
  assert.equal(reg.ownerSize, 1)
})

test('backend.kill 이 던져도 Map 은 비워지고 killAll 이 끝까지 돈다', () => {
  const reg = createTermRegistry<{ kill(): void }, object>()
  let ok = 0
  reg.add(
    1,
    {},
    {
      kill() {
        throw new Error('이미 종료됨')
      }
    }
  )
  reg.add(2, {}, { kill: () => ok++ })
  reg.killAll()
  assert.equal(ok, 1)
  assert.equal(reg.size, 0)
  assert.equal(reg.ownerSize, 0)
})
