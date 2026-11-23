// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { useCallback, useEffect, useRef, useState } from 'react'
import { dropIndexAt, moveTab } from './tabOrder'
import TerminalView, { type TermTarget } from './components/TerminalView'
import Sidebar, { type SidebarAction } from './components/Sidebar'
import SessionDialog from './components/SessionDialog'
import QuickConnect from './components/QuickConnect'
import { ConfirmDialog, InputDialog } from './components/Modal'
import { errMsg } from './errors'
import { setLang, t as tr, useLang, useT } from './i18n'
import { LANG_LABEL, type Lang } from '../../shared/i18n'
import type { ConnState, SessionInfo, SessionTree, WindowInit } from '../../shared/types'

interface Tab {
  key: number
  title: string
  target: TermTarget
  /** TerminalView 가 알려주는 연결 상태 (탭 표시용). 재연결은 TerminalView 안에서 처리 */
  conn?: ConnState
}

type DialogState =
  | { kind: 'session'; session?: SessionInfo; folderId: string | null }
  | { kind: 'folder'; id?: string; name?: string; parentId: string | null }
  | { kind: 'confirm'; title: string; message: string; run: () => Promise<void> }
  | null

const EMPTY_TREE: SessionTree = { folders: [], sessions: [], encryptionAvailable: true }

/** macOS 는 Cmd, 그 외는 Ctrl 을 단축키 기준 키로 쓴다 */
const IS_MAC = navigator.userAgent.includes('Mac')
const MOD = IS_MAC ? 'Cmd' : 'Ctrl'
const modKey = (e: KeyboardEvent): boolean => (IS_MAC ? e.metaKey : e.ctrlKey)
/** 로컬 탭은 셸을 지정하지 않고 main 이 OS 기본 셸(Windows: PowerShell, macOS: 로그인 셸)을 고른다 */
// 지금 언어로 계산해야 하므로 상수가 아니라 함수 (이미 만든 탭의 제목은 그대로 둔다)
const localTitle = (): string => (IS_MAC ? tr('tab.localTitleMac') : 'PowerShell')
const LOCAL_TARGET: TermTarget = { kind: 'local' }
/** 탭 드래그 데이터 형식. 텍스트(text/plain)로 두지 않아 터미널 등에 글자로 떨어지지 않는다 */
const TAB_MIME = 'application/x-tm-tab'
/** 탭 우클릭 메뉴 (key: 대상 탭, x/y: 화면 좌표) */
interface TabMenu {
  key: number
  x: number
  y: number
}

function App(): React.JSX.Element {
  const t = useT()
  const lang = useLang()
  const otherLang: Lang = lang === 'ko' ? 'en' : 'ko'
  const [tree, setTree] = useState<SessionTree>(EMPTY_TREE)
  // 첫 탭은 win:getInit 응답을 받은 뒤 만든다. 분리된 새 창이면 SSH 탭 1개만 만들고 로컬 탭은 만들지 않는다
  const [tabs, setTabs] = useState<Tab[]>([])
  const [ready, setReady] = useState(false)
  const [activeKey, setActiveKey] = useState<number>(0)
  // 파일 패널 열림은 탭 key 별로 메모리에만 둔다 (저장하지 않음, 순서가 바뀌어도 key 를 따라간다, 새 탭은 닫힘)
  const [panelOpen, setPanelOpen] = useState<ReadonlyMap<number, boolean>>(() => new Map())
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null) // 드래그 중 놓일 위치 표시 (삽입 인덱스)
  const dragKeyRef = useRef<number | null>(null) // 드래그 중인 탭 key (이 값 하나만 보관)
  const detachingRef = useRef(new Set<number>()) // 새 창으로 보내는 중인 탭 (중복 요청 방지)
  const detachRef = useRef<{ key: number; token: string; sent: boolean } | null>(null)
  const initRef = useRef<Promise<WindowInit> | null>(null) // StrictMode 에서도 getInit 은 한 번만 부른다
  const menuRef = useRef<HTMLDivElement>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [palette, setPalette] = useState(false)
  const [toast, setToast] = useState('')
  const nextKey = useRef(1) // 이벤트 핸들러/콜백에서만 증가 (StrictMode 이중 실행 대비)
  // 전역 단축키 핸들러에서 최신 상태를 읽기 위한 ref
  const tabsRef = useRef(tabs)
  const activeRef = useRef(activeKey)
  useEffect(() => {
    tabsRef.current = tabs
    activeRef.current = activeKey
  })

  // 창이 열릴 때 한 번: 분리 창이면 넘겨받은 세션으로 SSH 탭 1개, 아니면 로컬 탭 1개
  useEffect(() => {
    let cancelled = false
    initRef.current ??= window.api.win.getInit().catch((): WindowInit => ({}))
    void initRef.current.then(async (init) => {
      const d = init.detach
      let title = 'SSH'
      if (d) {
        try {
          const loaded = await window.api.sessions.tree()
          title = loaded.sessions.find((x) => x.id === d.sessionId)?.name ?? title
        } catch {
          // 이름을 못 읽어도 탭은 만든다
        }
      }
      if (cancelled) return
      const key = nextKey.current++
      if (d) {
        detachRef.current = { key, token: d.token, sent: false }
        setTabs([{ key, title, target: { kind: 'ssh', sessionId: d.sessionId } }])
      } else {
        setTabs([{ key, title: localTitle(), target: LOCAL_TARGET }])
      }
      setActiveKey(key)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const reload = useCallback(async () => setTree(await window.api.sessions.tree()), [])
  useEffect(() => {
    window.api.sessions.tree().then(setTree)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  // 탭/사이드바 밖에 파일을 떨어뜨렸을 때 Electron 이 파일을 열어버리지 않게
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  const addTab = (title: string, target: TermTarget): void => {
    const key = nextKey.current++
    setTabs((prev) => [...prev, { key, title, target }])
    setActiveKey(key)
  }

  const addLocalTab = (): void => addTab(localTitle(), LOCAL_TARGET)

  // 단축키 (터미널이 키를 먹기 전에 capture 단계에서 처리)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (modKey(e) && e.shiftKey && e.code === 'KeyK') {
        e.preventDefault()
        e.stopPropagation()
        setPalette(true)
      } else if (modKey(e) && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault()
        e.stopPropagation()
        addLocalTab()
      } else if (e.ctrlKey && e.code === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const cur = tabsRef.current
        const n = cur.length
        if (n) {
          const i = cur.findIndex((x) => x.key === activeRef.current)
          setActiveKey(cur[(i + (e.shiftKey ? n - 1 : 1)) % n].key)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openSession = (s: SessionInfo): void => {
    setPalette(false)
    addTab(s.name, { kind: 'ssh', sessionId: s.id })
  }

  // 새 창 분리 응답처럼 늦게 불리는 경우가 있어 render 시점의 tabs 가 아니라 ref 의 최신 값을 쓴다
  const closeTab = (key: number): void => {
    const cur = tabsRef.current
    const idx = cur.findIndex((tab) => tab.key === key)
    if (idx < 0) return
    const next = cur.filter((tab) => tab.key !== key)
    if (key === activeRef.current && next.length > 0) setActiveKey(next[Math.max(0, idx - 1)].key)
    setTabs((prev) => prev.filter((tab) => tab.key !== key))
    setPanelOpen((prev) => {
      if (!prev.has(key)) return prev
      const n = new Map(prev)
      n.delete(key)
      return n
    })
    setTabMenu((m) => (m?.key === key ? null : m))
    if (dragKeyRef.current === key) dragKeyRef.current = null
  }

  const setPanel = (key: number, open: boolean): void =>
    setPanelOpen((prev) => {
      if ((prev.get(key) ?? false) === open) return prev
      return new Map(prev).set(key, open)
    })

  const setConn = (key: number, conn: ConnState): void => {
    // 분리 창: 호환용 신호를 한 번만 보낸다. 'connected' 는 connectSsh 가 termId 를 돌려준 시점이라 연결 성공이 아니다.
    // 성공/실패 판정(SSH ready + 셸 열림)은 main 이 직접 관측해서 내리므로, 이 신호는 판정에 쓰이지 않는다
    const d = detachRef.current
    if (d && d.key === key && conn === 'connected' && !d.sent) {
      d.sent = true
      window.api.win.detachReady(d.token)
    }
    setTabs((prev) =>
      prev.map((tab) => (tab.key === key && tab.conn !== conn ? { ...tab, conn } : tab))
    )
  }

  // ───── 탭 순서 (드래그, 첫 칸으로) ─────
  const moveToFirst = (key: number): void => setTabs((prev) => moveTab(prev, key, 0))

  const dropIndexFor = (bar: HTMLElement, clientX: number): number =>
    dropIndexAt(
      [...bar.querySelectorAll<HTMLElement>('[data-tab-key]')].map((el) => {
        const r = el.getBoundingClientRect()
        return r.left + r.width / 2
      }),
      clientX
    )

  const onTabDragStart = (e: React.DragEvent, key: number): void => {
    dragKeyRef.current = key
    setTabMenu(null)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(TAB_MIME, String(key))
  }
  const onTabDragEnd = (): void => {
    // 드롭 위치와 상관없이(탭 줄 밖 포함) 끝나면 항상 정리
    dragKeyRef.current = null
    setDropAt(null)
  }
  const onBarDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (dragKeyRef.current === null) return // 파일 드래그 등은 건드리지 않는다
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropAt(dropIndexFor(e.currentTarget, e.clientX))
  }
  const onBarDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
  }
  const onBarDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const key = dragKeyRef.current
    if (key === null) return
    e.preventDefault()
    const to = dropIndexFor(e.currentTarget, e.clientX)
    dragKeyRef.current = null
    setDropAt(null)
    setTabs((prev) => moveTab(prev, key, to)) // activeKey 는 그대로 (key 기준이라 위치가 바뀌어도 유지)
  }

  // ───── 탭 우클릭 메뉴 ─────
  // 열려 있는 동안에만 리스너를 달고, 닫히면(또는 App 이 사라지면) 모두 해제한다
  useEffect(() => {
    if (!tabMenu) return
    const close = (): void => setTabMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setTabMenu(null)
      document.querySelector<HTMLElement>(`[data-tab-key="${tabMenu.key}"]`)?.focus()
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('contextmenu', close, true) // 다른 곳을 우클릭하면 먼저 닫고 거기서 새로 연다
    window.addEventListener('keydown', onKey)
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
      ?.focus()
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('contextmenu', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [tabMenu])

  // ───── 새 창으로 (SSH 탭만, 탭이 2개 이상일 때) ─────
  const detachTab = (key: number): void => {
    const tab = tabsRef.current.find((x) => x.key === key)
    if (!tab || tab.target.kind !== 'ssh' || tabsRef.current.length <= 1) return
    if (detachingRef.current.has(key)) return
    detachingRef.current.add(key)
    window.api.win
      .detachSsh(tab.target.sessionId)
      .then(
        (res) => {
          if (res.ok)
            closeTab(key) // 새 창이 연결을 마쳤으니 원래 탭은 닫는다
          else
            setToast(res.reason === 'timeout' ? tr('tab.detach.timeout') : tr('tab.detach.failed'))
        },
        () => setToast(tr('tab.detach.failed')) // 실패하면 원래 탭은 그대로 둔다
      )
      .finally(() => detachingRef.current.delete(key))
  }

  const menuTab = tabMenu ? tabs.find((x) => x.key === tabMenu.key) : undefined
  const menuIdx = menuTab ? tabs.indexOf(menuTab) : -1
  const menuItems = menuTab
    ? [
        {
          label: t('tab.menu.moveFirst'),
          disabled: menuIdx <= 0,
          action: 'first' as const
        },
        {
          label: t('tab.menu.detach'),
          disabled: menuTab.target.kind !== 'ssh' || tabs.length <= 1,
          action: 'detach' as const
        }
      ]
    : []
  const runMenuItem = (key: number, action: 'first' | 'detach'): void => {
    setTabMenu(null)
    if (action === 'first') moveToFirst(key)
    else detachTab(key)
  }
  // 메뉴 안에서 위/아래 화살표로 항목 이동 (비활성 항목은 건너뛴다)
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [
      ...e.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      )
    ]
    if (items.length === 0) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    const down = e.key === 'ArrowDown'
    items[
      i < 0 ? (down ? 0 : items.length - 1) : (i + (down ? 1 : items.length - 1)) % items.length
    ].focus()
  }

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      await reload()
    } catch (e) {
      setToast(errMsg(e))
    }
  }

  const onSidebarAction = (a: SidebarAction): void => {
    switch (a.type) {
      case 'open':
        return openSession(a.session)
      case 'newSession':
        return setDialog({ kind: 'session', folderId: a.folderId })
      case 'editSession':
        return setDialog({ kind: 'session', session: a.session, folderId: a.session.folderId })
      case 'duplicateSession':
        run(() => window.api.sessions.duplicateSession(a.session.id))
        return
      case 'deleteSession':
        return setDialog({
          kind: 'confirm',
          title: t('session.deleteTitle'),
          message: t('session.deleteConfirm', { name: a.session.name }),
          run: () => window.api.sessions.deleteSession(a.session.id)
        })
      case 'newFolder':
        return setDialog({ kind: 'folder', parentId: a.parentId })
      case 'renameFolder':
        return setDialog({
          kind: 'folder',
          id: a.folder.id,
          name: a.folder.name,
          parentId: a.folder.parentId
        })
      case 'deleteFolder':
        return setDialog({
          kind: 'confirm',
          title: t('folder.deleteTitle'),
          message: t('folder.deleteConfirm', { name: a.folder.name }),
          run: () => window.api.sessions.deleteFolder(a.folder.id)
        })
    }
  }

  return (
    <div className="app">
      <Sidebar
        tree={tree}
        onAction={onSidebarAction}
        onMove={(kind, id, target) => run(() => window.api.sessions.move(kind, id, target))}
      />
      <main className="main">
        <div
          className="tabbar"
          role="tablist"
          onDragOver={onBarDragOver}
          onDragLeave={onBarDragLeave}
          onDrop={onBarDrop}
        >
          {tabs.map((tab, i) => (
            <div
              key={tab.key}
              data-tab-key={tab.key}
              role="tab"
              tabIndex={0}
              aria-selected={tab.key === activeKey}
              draggable
              className={`tab ${tab.key === activeKey ? 'active' : ''} ${tab.conn === 'error' || tab.conn === 'closed' ? 'exited' : ''} ${tab.conn === 'error' ? 'conn-error' : ''} ${tab.target.kind} ${dropAt === i ? 'drop-before' : ''} ${dropAt === tabs.length && i === tabs.length - 1 ? 'drop-after' : ''}`}
              onClick={() => setActiveKey(tab.key)}
              onAuxClick={(e) => e.button === 1 && closeTab(tab.key)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  setActiveKey(tab.key)
                }
              }}
              // 마우스 우클릭, 메뉴 키, Shift+F10 모두 contextmenu 이벤트로 들어온다
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ key: tab.key, x: e.clientX, y: e.clientY })
              }}
              onDragStart={(e) => onTabDragStart(e, tab.key)}
              onDragEnd={onTabDragEnd}
              title={tab.title}
            >
              <span
                className={`icon ${tab.target.kind === 'ssh' ? 'icon-key' : 'icon-shell'}`}
                aria-hidden
              />
              <span className="tab-title">{tab.title}</span>
              <button
                className="tab-close"
                title={t('tab.close')}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.key)
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="tab-add" title={t('tab.newLocal', { mod: MOD })} onClick={addLocalTab}>
            +
          </button>
          <div className="tabbar-spacer" />
          <button
            className="tabbar-lang"
            title={t('lang.switchTitle')}
            onClick={() => setLang(otherLang)}
          >
            {LANG_LABEL[otherLang]}
          </button>
          <button
            className="tabbar-quick"
            title={t('tabbar.quickTitle', { mod: MOD })}
            onClick={() => setPalette(true)}
          >
            {t('tabbar.quick')} <kbd>{MOD}+Shift+K</kbd>
          </button>
        </div>
        <div className="terminals">
          {ready && tabs.length === 0 && (
            <div className="empty">
              <p>{t('empty.hint', { mod: MOD })}</p>
              <button onClick={addLocalTab}>{t('empty.openLocal', { title: localTitle() })}</button>
            </div>
          )}
          {/* 탭 순서를 바꿔도 터미널 DOM 이 옮겨지지 않도록 key(생성) 순서로 그린다. 화면에는 활성 탭만 보인다 */}
          {[...tabs]
            .sort((a, b) => a.key - b.key)
            .map((tab) => (
              <TerminalView
                key={tab.key}
                target={tab.target}
                active={tab.key === activeKey}
                onState={(c) => setConn(tab.key, c)}
                panelOpen={panelOpen.get(tab.key) ?? false}
                onPanelChange={(open) => setPanel(tab.key, open)}
              />
            ))}
        </div>
      </main>

      {tabMenu && menuTab && (
        <div
          ref={menuRef}
          className="context-menu tab-menu"
          role="menu"
          aria-label={t('tab.menuLabel')}
          style={{
            left: Math.min(tabMenu.x, window.innerWidth - 200),
            top: Math.min(tabMenu.y, window.innerHeight - 100)
          }}
          onKeyDown={onMenuKeyDown}
        >
          {menuItems.map((it) => (
            <div
              key={it.label}
              role="menuitem"
              tabIndex={-1}
              aria-disabled={it.disabled}
              className={`context-item ${it.disabled ? 'disabled' : ''}`}
              onClick={() => {
                if (!it.disabled) runMenuItem(tabMenu.key, it.action)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                if (!it.disabled) runMenuItem(tabMenu.key, it.action)
              }}
            >
              {it.label}
            </div>
          ))}
        </div>
      )}

      {palette && (
        <QuickConnect tree={tree} onOpen={openSession} onClose={() => setPalette(false)} />
      )}

      {dialog?.kind === 'session' && (
        <SessionDialog
          session={dialog.session}
          defaultFolderId={dialog.folderId}
          folders={tree.folders}
          encryptionAvailable={tree.encryptionAvailable}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            reload()
          }}
        />
      )}
      {dialog?.kind === 'folder' && (
        <InputDialog
          title={dialog.id ? t('folder.renameTitle') : t('folder.newTitle')}
          label={t('folder.nameLabel')}
          initial={dialog.name}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            const d = dialog
            setDialog(null)
            run(() => window.api.sessions.saveFolder({ id: d.id, name, parentId: d.parentId }))
          }}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const d = dialog
            setDialog(null)
            run(d.run)
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export default App
