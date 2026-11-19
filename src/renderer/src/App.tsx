// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { useCallback, useEffect, useRef, useState } from 'react'
import TerminalView, { type TermTarget } from './components/TerminalView'
import Sidebar, { type SidebarAction } from './components/Sidebar'
import SessionDialog from './components/SessionDialog'
import QuickConnect from './components/QuickConnect'
import { ConfirmDialog, InputDialog } from './components/Modal'
import { errMsg } from './errors'
import { setLang, t as tr, useLang, useT } from './i18n'
import { LANG_LABEL, type Lang } from '../../shared/i18n'
import type { ConnState, SessionInfo, SessionTree } from '../../shared/types'

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

function App(): React.JSX.Element {
  const t = useT()
  const lang = useLang()
  const otherLang: Lang = lang === 'ko' ? 'en' : 'ko'
  const [tree, setTree] = useState<SessionTree>(EMPTY_TREE)
  const [tabs, setTabs] = useState<Tab[]>(() => [
    {
      key: 1,
      title: localTitle(),
      target: LOCAL_TARGET
    }
  ])
  const [activeKey, setActiveKey] = useState<number>(1)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [palette, setPalette] = useState(false)
  const [toast, setToast] = useState('')
  const nextKey = useRef(2) // 이벤트 핸들러에서만 증가 (StrictMode 이중 실행 대비)
  // 전역 단축키 핸들러에서 최신 상태를 읽기 위한 ref
  const tabsRef = useRef(tabs)
  const activeRef = useRef(activeKey)
  useEffect(() => {
    tabsRef.current = tabs
    activeRef.current = activeKey
  })

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

  const closeTab = (key: number): void => {
    const idx = tabs.findIndex((tab) => tab.key === key)
    const next = tabs.filter((tab) => tab.key !== key)
    if (key === activeKey && next.length > 0) setActiveKey(next[Math.max(0, idx - 1)].key)
    setTabs(next)
  }

  const setConn = (key: number, conn: ConnState): void =>
    setTabs((prev) =>
      prev.map((tab) => (tab.key === key && tab.conn !== conn ? { ...tab, conn } : tab))
    )

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
        <div className="tabbar">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className={`tab ${tab.key === activeKey ? 'active' : ''} ${tab.conn === 'error' || tab.conn === 'closed' ? 'exited' : ''} ${tab.conn === 'error' ? 'conn-error' : ''} ${tab.target.kind}`}
              onClick={() => setActiveKey(tab.key)}
              onAuxClick={(e) => e.button === 1 && closeTab(tab.key)}
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
          {tabs.length === 0 && (
            <div className="empty">
              <p>{t('empty.hint', { mod: MOD })}</p>
              <button onClick={addLocalTab}>{t('empty.openLocal', { title: localTitle() })}</button>
            </div>
          )}
          {tabs.map((tab) => (
            <TerminalView
              key={tab.key}
              target={tab.target}
              active={tab.key === activeKey}
              onState={(c) => setConn(tab.key, c)}
            />
          ))}
        </div>
      </main>

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
