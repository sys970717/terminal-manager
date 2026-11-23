// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteEntry, RemoteListing } from '../../../shared/types'
import { errMsg } from '../errors'
import { formatBytes, formatTime, joinRemote, parentRemote } from '../format'
import { ConfirmDialog } from './Modal'
import { rich } from './rich'
import { useT } from '../i18n'

/**
 * SSH 탭 오른쪽의 원격 파일 브라우저 (SFTP 패널).
 * - 폴더 더블클릭으로 이동, 윈도우 탐색기에서 끌어다 놓으면 보고 있는 폴더(또는 놓은 폴더 줄)로 업로드
 * - 선택(클릭, Ctrl/Shift+클릭, Ctrl+A) 후 다운로드 / 새 폴더 / 이름 변경(F2) / 삭제(Delete), 우클릭 메뉴
 * 패널이 열려 있을 때만 SFTP 를 쓴다.
 */

interface Props {
  termId: number | null
  online: boolean
  open: boolean
  /** 업로드가 끝날 때마다 바뀌는 값 → 목록 새로고침 */
  refreshTick: number
  onCwd: (path: string | null) => void
  onUpload: (localPaths: string[], remoteDir: string) => void
  onCdTerminal: (path: string) => void
  onClose: () => void
}

type SortKey = 'name' | 'size' | 'mtime'
type Edit = { mode: 'new' } | { mode: 'rename'; name: string }
type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean } | '-'

const HIDDEN_KEY = 'tm.filePanel.hidden'
const readHidden = (): boolean => {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

const cleanErr = (e: unknown): string =>
  errMsg(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 새 폴더 / 이름 변경 입력칸. 이름 변경이면 확장자 앞까지 선택해 둔다 (탐색기처럼) */
function NameInput(props: {
  initial: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = props.initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : props.initial.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <input
      ref={ref}
      className="fp-name-input"
      defaultValue={props.initial}
      spellCheck={false}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation() // 목록 단축키(Delete, F2, Backspace 등)로 새지 않게
        if (e.key === 'Enter') props.onCommit()
        if (e.key === 'Escape') props.onCancel()
      }}
      onBlur={props.onCommit}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}

export default function FilePanel(props: Props): React.JSX.Element {
  const { termId, online, open, refreshTick, onCwd, onUpload, onCdTerminal, onClose } = props
  const t = useT()
  const api = window.api.term
  const [listing, setListing] = useState<RemoteListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [showHidden, setShowHidden] = useState(readHidden)
  const [addrEditing, setAddrEditing] = useState(false)
  const [addr, setAddr] = useState('')
  const [dropAt, setDropAt] = useState<string | null>(null) // '.' = 지금 폴더, 그 밖 = 폴더 줄 이름
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [edit, setEditState] = useState<Edit | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [confirmDel, setConfirmDel] = useState<string[] | null>(null)
  const reqRef = useRef(0)
  const cwdRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<{ edit: Edit | null; value: string; busy: boolean }>({
    edit: null,
    value: '',
    busy: false
  })
  const termIdRef = useRef(termId) // 응답이 왔을 때 "지금" 연결과 비교하기 위한 최신 termId
  useEffect(() => {
    termIdRef.current = termId
  })
  const onCwdRef = useRef(onCwd) // 부모가 매번 새 함수를 넘겨도 목록을 다시 읽지 않게
  useEffect(() => {
    onCwdRef.current = onCwd
  })

  const setEdit = (e: Edit | null): void => {
    editRef.current = {
      edit: e,
      value: e?.mode === 'rename' ? e.name : t('files.defaultFolderName'),
      busy: false
    }
    setEditState(e)
  }

  const load = useCallback(
    (path?: string, opts: { select?: string } = {}): void => {
      if (termId === null) return
      const req = ++reqRef.current
      setLoading(true)
      window.api.term.listDir(termId, path).then(
        (l) => {
          if (req !== reqRef.current) return // 더 늦게 보낸 요청이 이미 있음
          // 응답의 connId 가 지금 연결(termId)과 다르면 이전 연결의 응답이므로 버린다
          if (l.connId !== termIdRef.current) {
            setLoading(false) // 재연결/종료로 이전 연결이 된 응답: 화면에 반영하지 않는다
            return
          }
          const moved = l.path !== cwdRef.current
          cwdRef.current = l.path
          setListing(l)
          setError('')
          setLoading(false)
          if (opts.select) {
            setSel(new Set([opts.select]))
            setAnchor(opts.select)
            requestAnimationFrame(() =>
              listRef.current
                ?.querySelector(`[data-name="${CSS.escape(opts.select!)}"]`)
                ?.scrollIntoView({ block: 'nearest' })
            )
          } else if (moved) {
            setSel(new Set())
            setAnchor(null)
            listRef.current?.scrollTo({ top: 0 })
          }
          onCwdRef.current(l.path)
        },
        (e) => {
          if (req !== reqRef.current) return
          setError(cleanErr(e)) // 권한 없음 등: 지금 목록은 그대로 둔다
          setLoading(false)
        }
      )
    },
    [termId]
  )

  // 연결(termId)이 바뀌거나 패널이 사라지면 진행 중인 요청을 무효화한다 (늦게 온 응답이 화면에 반영되지 않게).
  // 새 요청은 아래 effect 가 이벤트(열림/재연결/업로드 완료)로만 보낸다. 폴링은 없다.
  useEffect(() => {
    const req = reqRef // 요청 번호 카운터 (DOM ref 아님)
    return () => {
      req.current++
      setLoading(false)
    }
  }, [termId])

  // 열릴 때, 재연결(termId 변경) 때, 업로드가 끝났을 때 지금 폴더를 다시 읽는다
  useEffect(() => {
    if (open && online) load(cwdRef.current ?? undefined)
  }, [open, online, load, refreshTick])

  // 우클릭 메뉴는 아무 데나 누르거나 창이 포커스를 잃으면 닫는다
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const toggleHidden = (): void => {
    const v = !showHidden
    setShowHidden(v)
    try {
      localStorage.setItem(HIDDEN_KEY, v ? '1' : '0')
    } catch {
      // 저장 못 해도 동작에는 문제 없음
    }
  }

  const entries = useMemo(() => {
    const list = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith('.'))
    const { key, dir } = sort
    return [...list].sort((a, b) => {
      const d = (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1)
      if (d) return d
      const v =
        key === 'name'
          ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          : key === 'size'
            ? a.size - b.size
            : a.mtime - b.mtime
      return v * dir || a.name.localeCompare(b.name)
    })
  }, [listing, showHidden, sort])

  const cwd = listing?.path ?? null
  // 보이는 항목 중 선택된 것 (숨김 처리됐거나 사라진 이름은 빠진다)
  const selected = useMemo(() => entries.filter((e) => sel.has(e.name)), [entries, sel])
  const can = online && cwd !== null && termId !== null && !busy

  const go = (p: string): void => {
    setAddrEditing(false)
    setEdit(null)
    load(p)
  }
  const openEntry = (e: RemoteEntry): void => {
    if (cwd && e.type === 'dir') go(joinRemote(cwd, e.name))
  }
  const pathsOf = (list: RemoteEntry[]): string[] => list.map((e) => joinRemote(cwd!, e.name))

  // ───── 선택 ─────
  const clickRow = (e: React.MouseEvent, name: string): void => {
    if (e.ctrlKey || e.metaKey) {
      setSel((prev) => {
        const next = new Set(prev)
        if (next.has(name)) next.delete(name)
        else next.add(name)
        return next
      })
      setAnchor(name)
    } else if (e.shiftKey && anchor) {
      const names = entries.map((x) => x.name)
      const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y)
      setSel(new Set(a < 0 ? [name] : names.slice(a, b + 1)))
    } else {
      setSel(new Set([name]))
      setAnchor(name)
    }
  }
  const moveSel = (delta: number): void => {
    if (entries.length === 0) return
    const cur = anchor ? entries.findIndex((x) => x.name === anchor) : -1
    const i = Math.min(entries.length - 1, Math.max(0, cur < 0 ? 0 : cur + delta))
    const name = entries[i].name
    setSel(new Set([name]))
    setAnchor(name)
    listRef.current
      ?.querySelector<HTMLElement>(`[data-name="${CSS.escape(name)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  // ───── 동작 ─────
  const doDownload = (list: RemoteEntry[]): void => {
    if (!can || list.length === 0) return
    api.download(termId!, pathsOf(list)).catch((e) => setError(cleanErr(e)))
  }
  const startNewFolder = (): void => {
    if (!can) return
    setSel(new Set())
    setEdit({ mode: 'new' })
    listRef.current?.scrollTo({ top: 0 })
  }
  const startRename = (e: RemoteEntry | undefined): void => {
    if (!can || !e) return
    setSel(new Set([e.name]))
    setAnchor(e.name)
    setEdit({ mode: 'rename', name: e.name })
  }
  const commitEdit = async (): Promise<void> => {
    const cur = editRef.current
    if (!cur.edit || cur.busy || termId === null || !cwd) return
    const v = cur.value.trim()
    if (!v || (cur.edit.mode === 'rename' && v === cur.edit.name)) return setEdit(null)
    cur.busy = true // Enter 뒤에 따라오는 blur 로 두 번 실행되지 않게
    setBusy(cur.edit.mode === 'new' ? t('files.busy.mkdir') : t('files.busy.rename'))
    try {
      if (cur.edit.mode === 'new') await api.mkdir(termId, cwd, v)
      else await api.rename(termId, cwd, cur.edit.name, v)
      setEdit(null)
      load(cwd, { select: v })
    } catch (e) {
      setError(cleanErr(e))
      setEdit(null)
    } finally {
      setBusy('')
    }
  }
  const askDelete = (list: RemoteEntry[]): void => {
    if (can && list.length) setConfirmDel(list.map((e) => e.name))
  }
  const doDelete = async (names: string[]): Promise<void> => {
    setConfirmDel(null)
    if (termId === null || !cwd) return
    setBusy(t('files.busy.delete', { n: names.length }))
    try {
      await api.remove(
        termId,
        names.map((n) => joinRemote(cwd, n))
      )
      setSel(new Set())
    } catch (e) {
      setError(cleanErr(e))
    } finally {
      setBusy('')
      load(cwd) // 일부만 지워졌을 수도 있으니 성공/실패 모두 다시 읽는다
    }
  }
  const copyPaths = (paths: string[]): void => {
    navigator.clipboard.writeText(paths.join('\n')).catch(() => {})
  }

  const openMenu = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    e.stopPropagation()
    // 패널은 창 오른쪽 끝에 있으므로 메뉴가 화면 밖으로 나가지 않게 당긴다
    const x = Math.min(e.clientX, window.innerWidth - 190)
    const y = Math.min(e.clientY, window.innerHeight - items.length * 28 - 16)
    setMenu({ x, y, items })
  }
  const rowMenu = (e: React.MouseEvent, entry: RemoteEntry): void => {
    let list = selected
    if (!sel.has(entry.name)) {
      setSel(new Set([entry.name]))
      setAnchor(entry.name)
      list = [entry]
    }
    const one = list.length === 1 ? list[0] : undefined
    openMenu(e, [
      ...(one?.type === 'dir' ? [{ label: t('files.open'), run: () => openEntry(one) }] : []),
      {
        label: list.length > 1 ? t('files.downloadN', { n: list.length }) : t('files.download'),
        run: () => doDownload(list)
      },
      { label: t('files.renameMenu'), run: () => startRename(one), disabled: !one },
      { label: t('files.copyPath'), run: () => copyPaths(pathsOf(list)) },
      '-',
      {
        label: list.length > 1 ? t('files.deleteN', { n: list.length }) : t('common.delete'),
        run: () => askDelete(list),
        danger: true
      }
    ])
  }
  const blankMenu = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('[data-name]')) return
    setSel(new Set())
    openMenu(e, [
      { label: t('files.newFolder'), run: startNewFolder },
      { label: t('files.refresh'), run: () => load(cwd ?? undefined) },
      { label: t('files.copyPath'), run: () => cwd && copyPaths([cwd]) },
      { label: t('files.cdHere'), run: () => cwd && onCdTerminal(cwd) }
    ])
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || !online) return
    const one = selected.length === 1 ? selected[0] : undefined
    if (e.key === 'Delete') askDelete(selected)
    else if (e.key === 'F2') startRename(one)
    else if (e.key === 'Enter' && one) openEntry(one)
    else if (e.key === 'Backspace' && cwd && cwd !== '/') go(parentRemote(cwd))
    else if (e.key === 'ArrowDown') moveSel(1)
    else if (e.key === 'ArrowUp') moveSel(-1)
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      setSel(new Set(entries.map((x) => x.name)))
    } else return
    e.preventDefault()
  }

  // ───── 드래그앤드롭 (윈도우 탐색기 → 원격) ─────
  const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')
  const rowDirOf = (e: React.DragEvent): string | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]')
    return el?.dataset.dir ?? null
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation() // 터미널 쪽 드롭 오버레이가 뜨지 않게
    const ok = online && cwd !== null
    e.dataTransfer.dropEffect = ok ? 'copy' : 'none'
    setDropAt(ok ? (rowDirOf(e) ?? '.') : null)
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDropAt(null)
    if (!online || cwd === null) return
    const row = rowDirOf(e)
    const paths = [...e.dataTransfer.files].map((f) => window.api.getPathForFile(f)).filter(Boolean)
    if (paths.length) onUpload(paths, row ? joinRemote(cwd, row) : cwd)
  }

  const crumbs = useMemo(() => {
    if (!cwd) return []
    const parts = cwd.split('/').filter(Boolean)
    return [
      { label: '/', path: '/' },
      ...parts.map((p, i) => ({ label: p, path: '/' + parts.slice(0, i + 1).join('/') }))
    ]
  }, [cwd])

  const target = dropAt === '.' ? cwd : dropAt && cwd ? joinRemote(cwd, dropAt) : null

  const head = (key: SortKey, label: string): React.JSX.Element => (
    <button
      type="button"
      className={`fp-h fp-h-${key} ${sort.key === key ? 'on' : ''}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
    >
      {label}
      {sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </button>
  )

  const editInput = (initial: string): React.JSX.Element => (
    <NameInput
      initial={initial}
      onChange={(v) => (editRef.current.value = v)}
      onCommit={() => void commitEdit()}
      onCancel={() => setEdit(null)}
    />
  )

  const delNames = confirmDel ?? []
  const delHasDir = delNames.some((n) => entries.find((e) => e.name === n)?.type === 'dir')

  return (
    <div
      className={`file-panel ${dropAt ? 'dropping' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null)
      }}
      onDrop={onDrop}
    >
      <div className="fp-top">
        <span className="fp-title">{t('files.title')}</span>
        <span className="fp-spacer" />
        <label className="fp-hidden" title={t('files.hiddenTitle')}>
          <input type="checkbox" checked={showHidden} onChange={toggleHidden} /> {t('files.hidden')}
        </label>
        <button type="button" className="fp-icon" title={t('files.closePanel')} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="fp-nav">
        <button
          type="button"
          className="fp-icon"
          title={t('files.up')}
          disabled={!cwd || cwd === '/' || !online}
          onClick={() => cwd && go(parentRemote(cwd))}
        >
          ⬆
        </button>
        <button
          type="button"
          className="fp-icon"
          title={t('files.home')}
          disabled={!online || !listing}
          onClick={() => listing && go(listing.home)}
        >
          ⌂
        </button>
        <button
          type="button"
          className="fp-icon"
          title={t('files.refresh')}
          disabled={!online}
          onClick={() => load(cwd ?? undefined)}
        >
          ↻
        </button>
        {addrEditing ? (
          <input
            className="fp-addr-input"
            autoFocus
            value={addr}
            spellCheck={false}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && addr.trim()) go(addr.trim())
              if (e.key === 'Escape') setAddrEditing(false)
            }}
            onBlur={() => setAddrEditing(false)}
          />
        ) : (
          <div
            className="fp-addr"
            title={t('files.addrTitle')}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) return
              setAddr(cwd ?? '')
              setAddrEditing(true)
            }}
          >
            {crumbs.map((c, i) => (
              <span key={c.path} className="fp-crumb">
                {i > 1 && <span className="fp-sep">/</span>}
                <button type="button" disabled={!online} onClick={() => go(c.path)}>
                  {c.label}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="fp-actions">
        <button
          type="button"
          className="fp-act fp-act-download"
          disabled={!can || selected.length === 0}
          title={t('files.downloadTitle')}
          onClick={() => doDownload(selected)}
        >
          {t('files.download')}
        </button>
        <button
          type="button"
          className="fp-act fp-act-mkdir"
          disabled={!can}
          title={t('files.newFolder')}
          onClick={startNewFolder}
        >
          {t('files.newFolder')}
        </button>
        <button
          type="button"
          className="fp-act fp-act-rename"
          disabled={!can || selected.length !== 1}
          title={t('files.renameTitle')}
          onClick={() => startRename(selected[0])}
        >
          {t('files.rename')}
        </button>
        <button
          type="button"
          className="fp-act fp-act-delete danger"
          disabled={!can || selected.length === 0}
          title={t('files.deleteTitle')}
          onClick={() => askDelete(selected)}
        >
          {t('common.delete')}
        </button>
      </div>

      {error && (
        <div className="fp-error" role="alert">
          <span>{error}</span>
          <button type="button" title={t('common.close')} onClick={() => setError('')}>
            ✕
          </button>
        </div>
      )}

      <div className="fp-cols">
        {head('name', t('files.col.name'))}
        {head('size', t('files.col.size'))}
        {head('mtime', t('files.col.mtime'))}
        <span className="fp-h fp-h-perm">{t('files.col.perm')}</span>
      </div>

      <div
        ref={listRef}
        className={`fp-list ${dropAt === '.' ? 'drop-here' : ''}`}
        tabIndex={0}
        onKeyDown={onListKey}
        onContextMenu={blankMenu}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('[data-name]')) setSel(new Set())
        }}
      >
        {!online && <div className="fp-empty">{t('files.offline')}</div>}
        {online && !listing && (
          <div className="fp-empty">{loading ? t('files.loading') : t('files.noListing')}</div>
        )}
        {online && edit?.mode === 'new' && (
          <div className="fp-row dir editing">
            <span className="fp-name">
              <span className="fp-ico">📁</span>
              {editInput(t('files.defaultFolderName'))}
            </span>
          </div>
        )}
        {online && listing && entries.length === 0 && edit?.mode !== 'new' && (
          <div className="fp-empty">{t('files.emptyDir')}</div>
        )}
        {online &&
          entries.map((e) => {
            const renaming = edit?.mode === 'rename' && edit.name === e.name
            return (
              <div
                key={e.name}
                className={`fp-row ${e.type} ${sel.has(e.name) ? 'sel' : ''} ${dropAt === e.name ? 'drop-into' : ''}`}
                data-name={e.name}
                data-dir={e.type === 'dir' ? e.name : undefined}
                title={e.isLink ? t('files.linkTitle', { name: e.name }) : e.name}
                onClick={(m) => clickRow(m, e.name)}
                onDoubleClick={() => openEntry(e)}
                onContextMenu={(m) => rowMenu(m, e)}
              >
                <span className="fp-name">
                  <span className="fp-ico">
                    {e.type === 'dir' ? '📁' : e.type === 'file' ? '📄' : '❔'}
                  </span>
                  {renaming ? editInput(e.name) : <span className="fp-label">{e.name}</span>}
                  {e.isLink && !renaming && <span className="fp-link">↪</span>}
                </span>
                <span className="fp-size">{e.type === 'file' ? formatBytes(e.size) : ''}</span>
                <span className="fp-time">{formatTime(e.mtime)}</span>
                <span className="fp-perm">{e.perm}</span>
              </div>
            )
          })}
      </div>

      <div className="fp-foot">
        {target ? (
          <span className="fp-target">
            {rich(t('files.uploadTo'), { target: <b>{target}</b> })}
          </span>
        ) : (
          <>
            <span className="fp-count">
              {busy ||
                (listing
                  ? selected.length
                    ? t('files.selectedOf', { n: selected.length, total: entries.length })
                    : entries.length === 1
                      ? t('files.items1')
                      : t('files.items', { n: entries.length })
                  : '')}
              {!busy && loading && listing ? ` · ${t('files.loading')}` : ''}
            </span>
            <span className="fp-spacer" />
            <button
              type="button"
              className="fp-cd"
              disabled={!online || !cwd}
              title={t('files.cdTitle')}
              onClick={() => cwd && onCdTerminal(cwd)}
            >
              {t('files.cdHere')}
            </button>
          </>
        )}
      </div>
      <div className="fp-hint">{t('files.hint')}</div>

      {/* 패널(.fp-wrap)은 container query 때문에 fixed 요소의 기준이 되므로 body 로 띄운다 */}
      {menu &&
        createPortal(
          <div className="context-menu fp-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.items.map((it, i) =>
              it === '-' ? (
                <div key={i} className="context-sep" />
              ) : (
                <div
                  key={it.label}
                  className={`context-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`}
                  onClick={() => {
                    if (it.disabled) return
                    setMenu(null)
                    it.run()
                  }}
                >
                  {it.label}
                </div>
              )
            )}
          </div>,
          document.body
        )}
      {confirmDel &&
        createPortal(
          <ConfirmDialog
            title={t('common.delete')}
            message={
              (delNames.length === 1
                ? t('files.delete.one', { name: delNames[0] })
                : t('files.delete.many', { n: delNames.length }) +
                  '\n' +
                  delNames.slice(0, 8).join('\n') +
                  (delNames.length > 8
                    ? '\n' + t('files.delete.more', { n: delNames.length - 8 })
                    : '')) +
              (delHasDir ? '\n\n' + t('files.delete.dirWarn') : '') +
              '\n' +
              t('common.irreversible')
            }
            onConfirm={() => void doDelete(delNames)}
            onClose={() => setConfirmDel(null)}
          />,
          document.body
        )}
    </div>
  )
}
