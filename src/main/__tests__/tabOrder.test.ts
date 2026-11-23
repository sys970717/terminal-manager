// 탭 순서 변경(드래그, "첫 칸으로") 순수 함수 단위 테스트. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropIndexAt, moveTab } from '../../renderer/src/tabOrder.ts'

const mk = (...keys: number[]): { key: number }[] => keys.map((key) => ({ key }))
const keys = (a: { key: number }[]): number[] => a.map((x) => x.key)

test('moveTab: 뒤쪽 탭을 첫 칸으로', () => {
  assert.deepEqual(keys(moveTab(mk(1, 2, 3, 4), 3, 0)), [3, 1, 2, 4])
})

test('moveTab: 앞쪽 탭을 뒤로 (삽입 위치는 원래 배열 기준)', () => {
  assert.deepEqual(keys(moveTab(mk(1, 2, 3, 4), 1, 3)), [2, 3, 1, 4])
  assert.deepEqual(keys(moveTab(mk(1, 2, 3, 4), 1, 4)), [2, 3, 4, 1])
})

test('moveTab: 제자리/없는 key/범위 밖 값은 같은 배열을 돌려준다', () => {
  const a = mk(1, 2, 3)
  assert.equal(moveTab(a, 2, 1), a)
  assert.equal(moveTab(a, 2, 2), a)
  assert.equal(moveTab(a, 99, 0), a)
  assert.deepEqual(keys(moveTab(a, 1, 99)), [2, 3, 1])
  assert.deepEqual(keys(moveTab(a, 3, -5)), [3, 1, 2])
})

test('moveTab: 원본 배열을 바꾸지 않는다', () => {
  const a = mk(1, 2, 3)
  moveTab(a, 3, 0)
  assert.deepEqual(keys(a), [1, 2, 3])
})

test('dropIndexAt: 탭 중앙선 기준 삽입 위치', () => {
  const centers = [50, 150, 250]
  assert.equal(dropIndexAt(centers, 10), 0)
  assert.equal(dropIndexAt(centers, 100), 1)
  assert.equal(dropIndexAt(centers, 200), 2)
  assert.equal(dropIndexAt(centers, 999), 3)
  assert.equal(dropIndexAt([], 5), 0)
})
