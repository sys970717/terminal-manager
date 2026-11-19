// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
/** IPC reject 메시지에서 Electron 이 붙이는 "Error invoking remote method ..." 접두어를 제거 → main 이 이미 현재 언어로 만든 문구만 남김 */
export function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
