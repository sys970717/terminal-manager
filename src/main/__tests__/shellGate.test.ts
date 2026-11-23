// 셸 문(shellGate) 단위 테스트: 연결 중 파일 조회가 셸이 열릴 때까지 기다린다. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createShellGate } from '../shellGate.ts'

test('셸이 열리기 전에 들어온 조회는 열릴 때 풀린다 (느린 인증 시나리오)', async () => {
  const g = createShellGate()
  const order: string[] = []
  const w = g.wait().then(() => order.push('resolved'))
  assert.equal(g.pending, 1)
  order.push('before-open')
  g.open()
  await w
  assert.deepEqual(order, ['before-open', 'resolved'])
  assert.equal(g.pending, 0)
  assert.equal(g.isOpen, true)
})

test('이미 열려 있으면 바로 풀린다', async () => {
  const g = createShellGate()
  g.open()
  await g.wait()
  assert.equal(g.pending, 0)
})

test('연결이 끝나면 대기 중인 조회가 모두 reject 되고 대기 목록이 빈다', async () => {
  const g = createShellGate()
  const a = g.wait()
  const b = g.wait()
  g.close(new Error('ended'))
  await assert.rejects(a, /ended/)
  await assert.rejects(b, /ended/)
  assert.equal(g.pending, 0)
  await assert.rejects(g.wait(), /ended/)
})

test('close 이후 open 은 무시되고, close 는 한 번만 적용된다', async () => {
  const g = createShellGate()
  g.close(new Error('first'))
  g.open()
  g.close(new Error('second'))
  assert.equal(g.isOpen, false)
  await assert.rejects(g.wait(), /first/)
})

test('열린 뒤 닫히면 이후 조회는 reject', async () => {
  const g = createShellGate()
  g.open()
  g.close(new Error('gone'))
  assert.equal(g.isOpen, false)
  await assert.rejects(g.wait(), /gone/)
})

test('소스 연결: ssh.ts 의 listDir 는 셸 문을 기다리고, 종료 정리에서 문을 닫는다', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../ssh.ts', import.meta.url), 'utf8')
  assert.match(src, /await waitShell\(t\('ssh\.notConnectedList'\)\)/)
  assert.match(src, /shellGate\.open\(\)/)
  assert.match(src, /shellGate\.close\(/)
})
