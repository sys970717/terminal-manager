// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ConnState, UploadProgress } from '../../../shared/types'
import { errMsg } from '../errors'
import { termBus } from '../termBus'
import { formatBytes, shellQuote } from '../format'
import FilePanel from './FilePanel'
import { rich } from './rich'
import { useT } from '../i18n'

// 탭 하나가 쌓을 수 있는 스크롤백 줄 수. 메모리 상한의 핵심 값이다 (xterm 은 줄마다 셀 버퍼를 보관).
// 메모리 사용량을 줄이거나 늘리려면 이 값만 조정한다.
const SCROLLBACK = 10000

export type TermTarget = { kind: 'local'; shell?: string } | { kind: 'ssh'; sessionId: string }

interface Props {
  target: TermTarget
  active: boolean
  /** 연결 상태가 바뀔 때 App(탭 표시)에 알림 */
  onState?: (state: ConnState) => void
  /** 파일 패널 열림 여부. 탭마다 따로이며 App 이 메모리에만 보관한다 (새 탭은 닫힌 채로 시작) */
  panelOpen: boolean
  onPanelChange: (open: boolean) => void
}

// 파일 패널 너비만 모든 SSH 탭이 같이 쓴다 (마지막 값을 기억). 열림 여부는 탭별 state 라 저장하지 않는다
const PANEL_WIDTH_KEY = 'tm.filePanel.width'
const PANEL_MIN = 260
const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const lsSet = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // 저장 못 해도 동작에는 문제 없음
  }
}

/**
 * 탭 하나 = TerminalView 하나. 로컬 PTY 또는 SSH 셸을 xterm.js 로 그림.
 * SSH 면 오른쪽에 원격 파일 패널(FilePanel)을 열 수 있고, 파일 드롭 → 패널에서 보고 있는 폴더(없으면 home)로 업로드
 */
export default function TerminalView({
  target,
  active,
  onState,
  panelOpen,
  onPanelChange
}: Props): React.JSX.Element {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const termIdRef = useRef<number | null>(null)
  const reconnectRef = useRef<() => void>(() => {})
  const onStateRef = useRef(onState)
  useEffect(() => {
    onStateRef.current = onState
  })

  const [conn, setConn] = useState<ConnState>('connecting')
  const [reason, setReason] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [upload, setUpload] = useState<UploadProgress | null>(null)
  const [termId, setTermId] = useState<number | null>(null) // FilePanel 에 넘기는 용도 (termIdRef 와 같은 값)
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.max(PANEL_MIN, Number(lsGet(PANEL_WIDTH_KEY)) || 420)
  )
  const [remoteCwd, setRemoteCwd] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  const isSsh = target.kind === 'ssh'
  const targetKey =
    target.kind === 'ssh' ? `ssh:${target.sessionId}` : `local:${target.shell ?? ''}`

  useEffect(() => {
    const host = hostRef.current!
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "D2Coding", "Cascadia Mono", monospace',
      fontSize: 14,
      scrollback: SCROLLBACK,
      theme: { background: '#1e1e1e' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    let disposed = false // StrictMode 이중 마운트 / 빠른 탭 닫기 대비
    const api = window.api.term

    // term:data/exit 는 앱 전체에서 한 번만 구독(termBus)하고 termId 로 분배된다.
    // connectSsh 응답(termId)보다 이벤트가 먼저 도착해도 버스가 bind 시점에 순서대로 재생한다.
    let starting = false

    // 'error' 는 이후의 일반 종료('closed')로 덮어쓰지 않는다 (오류 사유를 탭에 계속 보여주기 위해)
    let state: ConnState = 'connecting'
    const setState = (next: ConnState): void => {
      if (state === 'error' && next === 'closed') return
      state = next
      setConn(next)
      onStateRef.current?.(next)
    }
    const setTid = (v: number | null): void => {
      termIdRef.current = v
      setTermId(v)
    }
    const fail = (msg: string): void => {
      setTid(null)
      setReason(msg)
      setState('error')
    }

    const slot = termBus(api).open({
      onData: (data) => term.write(data),
      onExit: (code, exitReason) => {
        if (target.kind === 'local')
          term.write(`\r\n\x1b[90m${t('term.processExited', { code })}\x1b[0m\r\n`)
        setTid(null)
        // reason 이 있으면 오류 종료
        if (exitReason) fail(exitReason)
        else setState('closed')
      }
    })
    const offProgress = api.onUploadProgress((p) => {
      if (p.termId !== termIdRef.current) return
      setUpload(p)
      // 업로드가 끝나면 파일 패널 목록 다시 읽기 (다운로드는 원격이 안 바뀌므로 필요 없음)
      if (p.state === 'done' && p.kind !== 'download') setRefreshTick((n) => n + 1)
    })

    const begin = (): void => {
      starting = true
      slot.begin()
      state = 'connecting'
      setReason('')
      setState('connecting')
      const startP =
        target.kind === 'ssh'
          ? api.connectSsh(target.sessionId, term.cols, term.rows)
          : api.spawnLocal({ shell: target.shell, cols: term.cols, rows: term.rows })
      startP.then(
        (id) => {
          if (disposed) return api.kill(id)
          setTid(id)
          starting = false
          setState('connected')
          slot.bind(id) // 응답 전에 도착한 이벤트는 여기서 재생된다
        },
        (err) => {
          starting = false
          slot.abort()
          if (disposed) return
          const msg = errMsg(err)
          term.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`)
          fail(msg)
        }
      )
    }
    // 재연결: 같은 sessionId 로 connectSsh 를 다시 호출해 새 termId 로 교체 (이전 화면 기록은 유지)
    reconnectRef.current = (): void => {
      if (termIdRef.current !== null || starting) return
      term.write(`\r\n\x1b[90m${t('term.reconnecting')}\x1b[0m\r\n`)
      begin()
      term.focus()
    }
    begin()

    // 선택하면 자동 복사, 우클릭 붙여넣기
    const selSub = term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) navigator.clipboard.writeText(sel).catch(() => {})
    })
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      navigator.clipboard.readText().then(
        (text) => text && term.paste(text),
        () => {}
      )
    }
    host.addEventListener('contextmenu', onContext)

    const inputSub = term.onData((data) => {
      if (termIdRef.current !== null) api.write(termIdRef.current, data)
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (termIdRef.current !== null) api.resize(termIdRef.current, cols, rows)
    })

    const ro = new ResizeObserver(() => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) fit.fit() // 숨겨진 탭은 건너뜀
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      host.removeEventListener('contextmenu', onContext)
      selSub.dispose()
      inputSub.dispose()
      resizeSub.dispose()
      slot.dispose()
      offProgress()
      if (termIdRef.current !== null) api.kill(termIdRef.current)
      termIdRef.current = null
      reconnectRef.current = () => {}
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active])

  // 완료/오류 메시지는 잠시 뒤 자동으로 숨김
  useEffect(() => {
    if (!upload || upload.state === 'running') return
    // 오류와 다운로드 완료("폴더 열기" 버튼)는 조금 더 오래 보여준다
    const long = upload.state === 'error' || upload.kind === 'download'
    const timer = setTimeout(() => setUpload(null), long ? 10000 : 5000)
    return () => clearTimeout(timer)
  }, [upload])

  const exited = conn === 'error' || conn === 'closed'
  const canUpload = isSsh && conn === 'connected'
  const isDownload = upload?.kind === 'download'

  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = canUpload ? 'copy' : 'none'
    setDragOver(true)
  }

  const startUpload = (paths: string[], remoteDir?: string): void => {
    const id = termIdRef.current
    if (!canUpload || id === null || paths.length === 0) return
    setUpload({
      termId: id,
      file: '',
      fileIndex: 0,
      fileCount: paths.length,
      transferred: 0,
      total: 0,
      state: 'running'
    })
    window.api.term.upload(id, paths, remoteDir).catch((err: Error) =>
      setUpload({
        termId: id,
        file: '',
        fileIndex: 0,
        fileCount: 0,
        transferred: 0,
        total: 0,
        state: 'error',
        message: err.message
      })
    )
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const paths = [...e.dataTransfer.files].map((f) => window.api.getPathForFile(f)).filter(Boolean)
    startUpload(paths, remoteCwd ?? undefined)
    termRef.current?.focus()
  }

  const togglePanel = (open: boolean): void => {
    onPanelChange(open)
    if (!open) requestAnimationFrame(() => termRef.current?.focus())
  }

  // 터미널과 파일 패널 사이 경계를 끌어서 너비 조절
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = panelWidth
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const max = (): number => Math.max(PANEL_MIN, window.innerWidth - 480)
    let w = w0
    const move = (ev: PointerEvent): void => {
      w = Math.min(max(), Math.max(PANEL_MIN, w0 + (x0 - ev.clientX)))
      setPanelWidth(w)
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      lsSet(PANEL_WIDTH_KEY, String(Math.round(w)))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const cdTerminal = (path: string): void => {
    const id = termIdRef.current
    if (id === null) return
    window.api.term.write(id, `cd -- ${shellQuote(path)}\r`)
    termRef.current?.focus()
  }

  const showPanel = isSsh && panelOpen

  return (
    <div className="terminal-pane" style={{ display: active ? 'flex' : 'none' }}>
      <div
        className="term-area"
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
        }}
        onDrop={onDrop}
      >
        <div ref={hostRef} className="terminal-host" />

        {dragOver && (
          <div className={`drop-overlay ${canUpload ? '' : 'disabled'}`}>
            {canUpload ? (
              <>
                <div className="drop-title">{t('upload.dropHere')}</div>
                <div className="drop-sub">
                  {remoteCwd
                    ? rich(t('upload.dropToDir'), { dir: <b>{remoteCwd}</b> })
                    : t('upload.dropToHome')}
                </div>
              </>
            ) : (
              <div className="drop-title">
                {isSsh ? t('upload.tabDisconnected') : t('upload.sshOnly')}
              </div>
            )}
          </div>
        )}

        {upload && (
          <div className={`upload-toast ${upload.state} ${upload.kind ?? 'upload'}`}>
            {upload.state === 'running' && (
              <>
                <div>
                  {isDownload ? t('download.running') : t('upload.running')}{' '}
                  {upload.fileCount > 1 && `(${upload.fileIndex + 1}/${upload.fileCount}) `}
                  <b>{upload.file || t('upload.preparing')}</b>
                </div>
                {upload.total > 0 && (
                  <>
                    <div className="progress">
                      <div style={{ width: `${(upload.transferred / upload.total) * 100}%` }} />
                    </div>
                    <div className="upload-meta">
                      {formatBytes(upload.transferred)} / {formatBytes(upload.total)}
                    </div>
                  </>
                )}
              </>
            )}
            {upload.state === 'done' && upload.kind !== 'download' && (
              <div>
                {rich(
                  upload.fileCount === 1
                    ? t('upload.done1')
                    : t('upload.done', { n: upload.fileCount }),
                  { dir: <b>{upload.remoteDir}</b> }
                )}
              </div>
            )}
            {upload.state === 'done' && upload.kind === 'download' && (
              <div className="download-done">
                <span>
                  {rich(
                    upload.fileCount === 1
                      ? t('download.done1')
                      : t('download.done', { n: upload.fileCount }),
                    { dir: <b>{upload.localDir}</b> }
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (termIdRef.current !== null)
                      window.api.term.openDownloads(termIdRef.current).catch(() => {})
                  }}
                >
                  {t('download.openFolder')}
                </button>
              </div>
            )}
            {upload.state === 'cancelled' && (
              <div>{isDownload ? t('download.cancelled') : t('upload.cancelled')}</div>
            )}
            {upload.state === 'error' && (
              <div>
                {t(isDownload ? 'download.failed' : 'upload.failed', {
                  msg: errMsg(upload.message ?? '')
                })}
              </div>
            )}
          </div>
        )}

        {exited && isSsh && (
          <div className={`reconnect-bar ${conn}`} role={conn === 'error' ? 'alert' : 'status'}>
            <span className="reconnect-msg">
              {conn === 'error' ? reason || t('term.connectFailed') : t('term.disconnected')}
            </span>
            <button type="button" onClick={() => reconnectRef.current()} autoFocus>
              {t('term.reconnect')}
            </button>
          </div>
        )}
      </div>

      {isSsh && !panelOpen && (
        <button
          type="button"
          className="fp-strip"
          title={t('files.openPanel')}
          onClick={() => togglePanel(true)}
        >
          📁<span>{t('files.strip')}</span>
        </button>
      )}
      {isSsh && (
        <>
          {showPanel && <div className="fp-splitter" onPointerDown={startResize} />}
          <div
            className="fp-wrap"
            style={{ width: panelWidth, display: showPanel ? 'flex' : 'none' }}
          >
            <FilePanel
              termId={termId}
              online={canUpload && termId !== null}
              open={showPanel && active}
              refreshTick={refreshTick}
              onCwd={setRemoteCwd}
              onUpload={startUpload}
              onCdTerminal={cdTerminal}
              onClose={() => togglePanel(false)}
            />
          </div>
        </>
      )}
    </div>
  )
}
