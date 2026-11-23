// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
/**
 * main → renderer 전송의 단일 통로 (순수 로직, electron 을 import 하지 않는다).
 * 창이 이미 파괴됐으면 보내지 않는다 (Electron 은 파괴된 WebContents 에 send 하면 던진다).
 */
export interface SendTarget {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/** 보냈으면 true, 창이 닫혔거나 전송이 실패하면 false */
export function sendToOwner(owner: SendTarget, channel: string, ...args: unknown[]): boolean {
  if (owner.isDestroyed()) return false
  try {
    owner.send(channel, ...args)
    return true
  } catch {
    // isDestroyed 확인 직후 창이 닫히는 경합
    return false
  }
}
