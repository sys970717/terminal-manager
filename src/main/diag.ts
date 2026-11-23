// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { app, BrowserWindow, ipcMain } from 'electron'
import { appendFile } from 'fs/promises'
import { join } from 'path'
import { runInNewContext } from 'vm'
import { setFlagsFromString } from 'v8'
import { getSshStats } from './ssh'
import { getTermStats } from './terms'
import { getPendingDetachCount } from './windows'
import type { DiagGcResult, DiagSnapshot } from '../shared/types'

/**
 * dev 전용 진단 (메모리 누수 점검용). index.ts 의 `import.meta.env.DEV` 가드 안에서만 불러온다.
 * prod 빌드에는 이 모듈도, 채널 이름도 들어가지 않아야 한다 (scripts/check-prod-diag.mjs 로 검사).
 * - diag:snapshot  main 의 자원 개수 + 프로세스별 메모리
 * - diag:gc        main/renderer 에서 GC 를 강제로 돌린다
 */

/** ipcMain.on 으로 등록하는 채널. 같은 채널의 리스너가 늘어나면 중복 등록 누수다 */
const IPC_CHANNELS = ['term:write', 'term:resize', 'term:kill', 'win:detachReady']
/** 렌더러(WebContents) 쪽에 붙이는 리스너. 터미널을 열고 닫아도 늘어나면 안 된다 */
const WC_EVENTS = ['destroyed', 'render-process-gone', 'did-start-navigation'] as const

const LOG_INTERVAL_MS = 60_000

/**
 * main 프로세스의 gc 함수. app.commandLine 의 js-flags 는 main 에는 적용되지 않으므로
 * v8 플래그를 켜고 새 컨텍스트에서 꺼내 쓴다 (dev 진단에서만 호출됨).
 */
function getMainGc(): (() => void) | null {
  const g = (globalThis as { gc?: () => void }).gc
  if (typeof g === 'function') return g
  try {
    setFlagsFromString('--expose_gc')
    const fn = runInNewContext('gc') as unknown
    return typeof fn === 'function' ? (fn as () => void) : null
  } catch {
    return null
  }
}

/** 창 수와 대기 중인 detach 수. snapshot 요청 때만 계산한다 (타이머 없음) */
export function getWindowStats(): { count: number; pendingDetach: number } {
  return {
    count: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
    pendingDetach: getPendingDetachCount()
  }
}

export function snapshot(): DiagSnapshot {
  const t = getTermStats()
  const s = getSshStats()
  const ipcListeners: Record<string, number> = {}
  for (const ch of IPC_CHANNELS) ipcListeners[ch] = ipcMain.listenerCount(ch)
  const wcs = BrowserWindow.getAllWindows().map((w) => w.webContents)
  for (const ev of WC_EVENTS) {
    ipcListeners[`wc:${ev}`] = wcs.reduce((n, wc) => n + wc.listenerCount(ev), 0)
  }
  return {
    ts: Date.now(),
    windows: getWindowStats(),
    main: {
      terms: t.terms,
      owners: t.owners,
      sshClients: s.clients,
      sshStreams: s.streams,
      sftp: s.sftp,
      ptys: t.ptys,
      ipcListeners,
      heapUsed: process.memoryUsage().heapUsed
    },
    procs: app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      // privateBytes 는 Windows/Linux 에서 제공 (KB 단위 → 바이트로 변환)
      privateBytes: (m.memory.privateBytes ?? 0) * 1024,
      workingSet: m.memory.workingSetSize * 1024
    }))
  }
}

async function runGc(): Promise<DiagGcResult> {
  const gc = getMainGc()
  gc?.()
  let renderer = false
  for (const w of BrowserWindow.getAllWindows()) {
    // --expose-gc(js-flags)로 띄운 렌더러에만 gc 가 있다
    const ok = await w.webContents
      .executeJavaScript('typeof gc === "function" ? (gc(), true) : false')
      .catch(() => false)
    renderer ||= ok === true
  }
  return { main: gc !== null, renderer }
}

/** 60초마다 userData/diag.jsonl 에 한 줄씩 기록. 반환값은 정리 함수 */
function startPeriodicLog(): () => void {
  const file = join(app.getPath('userData'), 'diag.jsonl')
  const timer = setInterval(() => {
    appendFile(file, JSON.stringify(snapshot()) + '\n').catch(() => {})
  }, LOG_INTERVAL_MS)
  timer.unref() // 이 타이머 때문에 프로세스 종료가 막히지 않게
  return () => clearInterval(timer)
}

let registered = false

export function registerDiag(): void {
  if (registered) return
  registered = true
  ipcMain.handle('diag:snapshot', () => snapshot())
  ipcMain.handle('diag:gc', () => runGc())
  const stop = startPeriodicLog()
  // before-quit 를 거치지 않는 종료 경로(will-quit)도 정리한다. stop 은 clearInterval 이라 두 번 불려도 안전하다
  app.once('before-quit', stop)
  app.once('will-quit', stop)
}
