// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import type { DetachResult, WindowInit } from '../shared/types'

/**
 * "새 창으로" (SSH 탭 분리) 핸드셰이크. electron 을 import 하지 않는 순수 로직이라 node:test 로 검증한다.
 *  1. renderer → win:detachSsh(sessionId)  : 검증 → 토큰 발급 → 새 창 생성 → 15초 타이머
 *  2. 새 창   → win:getInit               : 자기 detach 정보(sessionId, token)를 읽는다
 *  3. main    : 새 창이 연 SSH 터미널의 셸이 실제로 열리면(ssh.ts 가 emit.ready) shellOpened(wcId) → {ok:true}
 *               SSH 연결이 오류로 끝나면 shellFailed(wcId) → 바로 {ok:false}. 시간 초과/창 닫힘도 실패 (새 창은 닫는다)
 *  4. 새 창   → win:detachReady(token)     : 호환용 신호. renderer 의 connectSsh 응답은 termId 발급일 뿐 연결 성공이 아니므로
 *               이 신호만으로는 성공 처리하지 않고 무시한다 (성공 판정은 main 이 직접 관측한 셸 열림만 쓴다)
 * 정책은 "다시 연결"이다. 세션 ID 와 토큰만 오가고 비밀번호·키는 renderer 로 가지 않는다.
 * 대기 타이머와 토큰은 성공·실패·창 닫힘 어느 경우에든 해제한다.
 */
export const DETACH_TIMEOUT_MS = 15_000
/** 동시에 대기할 수 있는 detach 수 (연타·악용 방어) */
export const MAX_PENDING_DETACH = 4

export interface DetachWindow {
  readonly id: number
  readonly webContentsId: number
  isDestroyed(): boolean
  close(): void
  /** 창이 닫혔을 때 한 번 부른다 */
  onClosed(cb: () => void): void
}

export interface DetachDeps {
  /** 새 창을 만든다 (던지면 'failed') */
  openWindow(): DetachWindow
  /** 저장된 SSH 세션인가 (로컬 PTY 탭은 sessionId 가 없거나 세션이 아니다) */
  isSshSession(sessionId: string): boolean
  newToken(): string
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  timeoutMs?: number
}

interface Pending {
  win: DetachWindow
  sessionId: string
  timer: unknown
  settle: (r: DetachResult) => void
}

export interface DetachManager {
  detach(sessionId: unknown): Promise<DetachResult>
  /** 새 창이 시작할 때 읽는다. 대기 중인 detach 가 없으면 빈 객체 */
  getInit(webContentsId: number): WindowInit
  /** 새 창이 보낸 호환용 신호. 성공 판정에 쓰지 않는다 (renderer 의 '연결됨'은 termId 발급일 뿐이라 신뢰하지 않는다) */
  ready(webContentsId: number, token: unknown): void
  /** main 이 직접 관측: 그 창의 SSH 셸이 열렸다 → 성공 */
  shellOpened(webContentsId: number): void
  /** main 이 직접 관측: 그 창의 SSH 연결이 오류로 끝났다 → 15초를 기다리지 않고 실패 */
  shellFailed(webContentsId: number): void
  readonly pendingCount: number
}

export function createDetachManager(deps: DetachDeps): DetachManager {
  const pending = new Map<string, Pending>() // token → 대기 정보
  const timeoutMs = deps.timeoutMs ?? DETACH_TIMEOUT_MS

  const detach = (sessionId: unknown): Promise<DetachResult> => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200)
      return Promise.resolve({ ok: false, reason: 'not-ssh' })
    if (!deps.isSshSession(sessionId)) return Promise.resolve({ ok: false, reason: 'not-ssh' })
    if (pending.size >= MAX_PENDING_DETACH) return Promise.resolve({ ok: false, reason: 'failed' })

    let win: DetachWindow
    try {
      win = deps.openWindow()
    } catch {
      return Promise.resolve({ ok: false, reason: 'failed' })
    }
    const token = deps.newToken()

    return new Promise<DetachResult>((resolve) => {
      let done = false
      const settle = (r: DetachResult): void => {
        if (done) return
        done = true
        deps.clearTimer(entry.timer)
        pending.delete(token)
        if (!r.ok && !win.isDestroyed()) {
          try {
            win.close() // 실패하면 새 창은 닫는다 (원래 탭은 renderer 가 유지)
          } catch {
            // 이미 닫힘
          }
        }
        resolve(r)
      }
      const entry: Pending = {
        win,
        sessionId,
        timer: deps.setTimer(() => settle({ ok: false, reason: 'timeout' }), timeoutMs),
        settle
      }
      pending.set(token, entry)
      // 준비되기 전에 사용자가 새 창을 닫음. 준비 후의 창 닫힘은 settle 이 이미 끝났으므로 무시된다
      win.onClosed(() => settle({ ok: false, reason: 'failed' }))
    })
  }

  return {
    detach,
    getInit(wcId) {
      for (const [token, p] of pending)
        if (p.win.webContentsId === wcId) return { detach: { sessionId: p.sessionId, token } }
      return {}
    },
    ready(wcId, token) {
      // 아무것도 확정하지 않는다 (성공은 shellOpened 만). 토큰·소유자 불일치도 그냥 무시
      void wcId
      void token
    },
    shellOpened(wcId) {
      for (const p of [...pending.values()])
        if (p.win.webContentsId === wcId) p.settle({ ok: true, windowId: p.win.id })
    },
    shellFailed(wcId) {
      for (const p of [...pending.values()])
        if (p.win.webContentsId === wcId) p.settle({ ok: false, reason: 'failed' })
    },
    get pendingCount() {
      return pending.size
    }
  }
}

// ───────────────────────── IPC 등록 (ipcMain 은 index.ts 가 주입) ─────────────────────────

export interface IpcLike {
  handle(channel: string, fn: (e: { sender: { id: number } }, ...args: unknown[]) => unknown): void
  on(channel: string, fn: (e: { sender: { id: number } }, ...args: unknown[]) => void): void
}

let registered = false
let active: DetachManager | null = null

/** 대기 중인 detach 수 (diag 가 snapshot 요청 때만 읽는다) */
export function getPendingDetachCount(): number {
  return active?.pendingCount ?? 0
}

/** terms.ts 가 SSH 셸이 열린 직후 부른다. 대기 중인 detach 가 없으면 아무 일도 없다 */
export function notifyShellOpened(webContentsId: number): void {
  active?.shellOpened(webContentsId)
}

/** SSH 연결이 오류로 끝났을 때 부른다 */
export function notifyShellFailed(webContentsId: number): void {
  active?.shellFailed(webContentsId)
}

/** ipcMain.handle 은 같은 채널을 두 번 등록하면 던진다. 한 번만 등록한다 */
export function registerWindowHandlers(ipc: IpcLike, deps: DetachDeps): DetachManager {
  if (registered && active) return active
  registered = true
  const mgr = createDetachManager(deps)
  active = mgr
  ipc.handle('win:detachSsh', (_e, sessionId) => mgr.detach(sessionId))
  ipc.handle('win:getInit', (e) => mgr.getInit(e.sender.id))
  ipc.on('win:detachReady', (e, token) => mgr.ready(e.sender.id, token))
  return mgr
}
