// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
/**
 * 살아 있는 자원 개수 게이지 (dev 진단용 카운터).
 * acquire() 가 돌려주는 release 는 몇 번을 불러도 한 번만 감산한다 → 이중 해제로 값이 음수가 되지 않는다.
 * electron 을 import 하지 않는 순수 모듈 (node:test 로 직접 검증).
 */
export interface Gauge {
  readonly value: number
  /** 개수를 1 올리고, 멱등 release 함수를 돌려준다 */
  acquire(): () => void
}

export function createGauge(): Gauge {
  let n = 0
  return {
    get value() {
      return n
    },
    acquire() {
      n++
      let released = false
      return () => {
        if (released) return
        released = true
        n--
      }
    }
  }
}
