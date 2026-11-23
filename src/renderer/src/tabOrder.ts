// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// 탭 순서 바꾸기 순수 함수 (React 에 의존하지 않아 단위 테스트가 쉽다)

/**
 * key 탭을 "삽입 위치" before 앞으로 옮긴다. before 는 원래 배열 기준 인덱스(0..length).
 * 제자리(자기 앞/뒤)로 놓거나 key 가 없으면 같은 배열을 그대로 돌려줘 리렌더를 막는다.
 */
export function moveTab<T extends { key: number }>(tabs: T[], key: number, before: number): T[] {
  const from = tabs.findIndex((x) => x.key === key)
  if (from < 0) return tabs
  const to = Math.max(0, Math.min(tabs.length, before))
  if (to === from || to === from + 1) return tabs
  const next = tabs.slice()
  const [item] = next.splice(from, 1)
  next.splice(to > from ? to - 1 : to, 0, item)
  return next
}

/** 드롭 x 좌표가 어느 탭의 앞(삽입 위치)인지 계산한다. 탭 중앙선보다 왼쪽이면 그 탭 앞 */
export function dropIndexAt(centers: number[], clientX: number): number {
  const i = centers.findIndex((c) => clientX < c)
  return i < 0 ? centers.length : i
}
