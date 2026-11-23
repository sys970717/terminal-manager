// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
/**
 * SSH 셸이 열릴 때까지 기다리는 문 (순수 로직, electron/ssh2 를 import 하지 않는다).
 * 렌더러는 connectSsh 가 termId 를 돌려주는 즉시 파일 패널을 조회할 수 있는데, 그 시점에는 아직
 * SSH 인증/셸 열기가 끝나지 않았을 수 있다. 이때 "접속 안 됨" 으로 바로 실패시키면 이후 갱신 신호가
 * 없어 패널이 계속 비어 있다. 그래서 조회는 셸이 열릴 때(open)까지 기다리고, 연결이 끝나면(close)
 * 대기 중인 요청을 모두 reject 한다. 이벤트 기반이며 타이머·폴링을 두지 않는다.
 */
export interface ShellGate {
  /** 셸이 열렸다 */
  open(): void
  /** 연결이 끝났다. 대기 중인 요청은 모두 reject, 이후 wait 도 reject */
  close(err: Error): void
  /** 셸이 열려 있으면 바로 resolve, 연결 중이면 open/close 까지 대기 */
  wait(): Promise<void>
  readonly isOpen: boolean
  /** 대기 중인 요청 수 (진단·테스트용) */
  readonly pending: number
}

export function createShellGate(): ShellGate {
  let opened = false
  let closedWith: Error | null = null
  let waiters: { res: () => void; rej: (e: Error) => void }[] = []

  return {
    open() {
      if (opened || closedWith) return
      opened = true
      const list = waiters
      waiters = []
      for (const w of list) w.res()
    },
    close(err) {
      if (closedWith) return
      closedWith = err
      opened = false
      const list = waiters
      waiters = []
      for (const w of list) w.rej(err)
    },
    wait() {
      if (opened) return Promise.resolve()
      if (closedWith) return Promise.reject(closedWith)
      return new Promise<void>((res, rej) => waiters.push({ res, rej }))
    },
    get isOpen() {
      return opened
    },
    get pending() {
      return waiters.length
    }
  }
}
