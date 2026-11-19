// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// term:data / term:exit 를 앱 전체에서 한 번만 구독하고 termId 별로 나눠 주는 버스.
// 이전에는 TerminalView(탭)마다 onData 를 구독해서, 청크 하나가 탭 수만큼 contextBridge 를 건너왔다.

export interface TermBusApi {
  onData(cb: (id: number, data: string) => void): () => void
  onExit(cb: (id: number, code: number, reason?: string) => void): () => void
}

export interface TermHandlers {
  onData(data: string): void
  onExit(code: number, reason?: string): void
}

/** 탭 하나가 버스에서 차지하는 자리. termId 는 연결 응답이 온 뒤에야 알 수 있어 begin → bind 순서로 쓴다 */
export interface TermSlot {
  /** 연결 요청 직전에 호출. bind/abort 전까지 termId 를 모르는 이벤트를 보관한다 */
  begin(): void
  /** 연결 응답으로 받은 termId 연결. 응답보다 먼저 도착한 이벤트는 도착 순서대로 재생한다 */
  bind(id: number): void
  /** 연결 실패 등으로 bind 없이 대기를 끝낼 때 */
  abort(): void
  /** 슬롯 제거. 마지막 슬롯이 사라지면 IPC 구독도 해제한다 */
  dispose(): void
}

type Queued =
  | { id: number; ev: 'data'; data: string }
  | { id: number; ev: 'exit'; code: number; reason?: string }

/** 응답 대기 중 보관하는 이벤트의 총 글자 수 상한 (응답이 영영 안 오는 경우의 메모리 보호) */
const MAX_QUEUED_CHARS = 4 * 1024 * 1024

export interface TermBus {
  open(handlers: TermHandlers): TermSlot
  /** 진단/테스트용 */
  stats(): { slots: number; bound: number; queued: number }
}

export function createTermBus(api: TermBusApi): TermBus {
  interface SlotState {
    handlers: TermHandlers
    id: number | null
    starting: boolean
  }
  const slots = new Set<SlotState>()
  const byId = new Map<number, SlotState>()
  let queue: Queued[] = []
  let queuedChars = 0
  let unsubs: (() => void)[] = []

  const anyStarting = (): boolean => [...slots].some((s) => s.starting)
  const clearQueue = (): void => {
    queue = []
    queuedChars = 0
  }

  const deliver = (s: SlotState, q: Queued): void => {
    if (q.ev === 'data') s.handlers.onData(q.data)
    else {
      // 프로세스가 끝났으므로 매핑을 먼저 풀어 Map 에 죽은 termId 가 남지 않게 한다
      if (byId.get(q.id) === s) byId.delete(q.id)
      s.id = null
      s.handlers.onExit(q.code, q.reason)
    }
  }

  const dispatch = (q: Queued): void => {
    const s = byId.get(q.id)
    if (s) return deliver(s, q)
    // 주인을 아직 모르는 이벤트: 응답 대기 중인 슬롯이 있을 때만 보관 (없으면 이미 닫힌 termId 의 잔여 이벤트)
    if (!anyStarting()) return
    if (q.ev === 'data') {
      if (queuedChars + q.data.length > MAX_QUEUED_CHARS) return
      queuedChars += q.data.length
    }
    queue.push(q)
  }

  const attach = (): void => {
    unsubs = [
      api.onData((id, data) => dispatch({ id, ev: 'data', data })),
      api.onExit((id, code, reason) => dispatch({ id, ev: 'exit', code, reason }))
    ]
  }
  const detach = (): void => {
    unsubs.forEach((off) => off())
    unsubs = []
    clearQueue()
  }
  /** 대기 중인 슬롯이 없어졌으면 보관분은 더 이상 주인이 없다 */
  const settle = (): void => {
    if (!anyStarting()) clearQueue()
  }

  return {
    open(handlers: TermHandlers): TermSlot {
      const s: SlotState = { handlers, id: null, starting: false }
      if (slots.size === 0) attach()
      slots.add(s)
      return {
        begin() {
          if (s.id !== null && byId.get(s.id) === s) byId.delete(s.id)
          s.id = null
          s.starting = true
        },
        bind(id) {
          if (!slots.has(s)) return
          s.starting = false
          s.id = id
          byId.set(id, s)
          // 재생 중 핸들러가 새 이벤트를 만들 일은 없지만, 순서 보장을 위해 이 id 의 것만 먼저 꺼낸다
          const mine = queue.filter((q) => q.id === id)
          queue = queue.filter((q) => q.id !== id)
          queuedChars = queue.reduce((n, q) => n + (q.ev === 'data' ? q.data.length : 0), 0)
          for (const q of mine) {
            if (s.id !== id) break // 재생 도중 exit 로 풀렸으면 이후 이벤트는 버린다
            deliver(s, q)
          }
          settle()
        },
        abort() {
          s.starting = false
          settle()
        },
        dispose() {
          if (!slots.delete(s)) return
          if (s.id !== null && byId.get(s.id) === s) byId.delete(s.id)
          s.id = null
          s.starting = false
          if (slots.size === 0) detach()
          else settle()
        }
      }
    },
    /** 진단/테스트용 */
    stats: () => ({ slots: slots.size, bound: byId.size, queued: queue.length })
  }
}

let shared: TermBus | undefined
/** 앱 전체에서 공유하는 버스. api 는 첫 호출 때만 쓰인다 (모듈이 window 에 의존하지 않게 인자로 받는다) */
export function termBus(api: TermBusApi): TermBus {
  return (shared ??= createTermBus(api))
}
