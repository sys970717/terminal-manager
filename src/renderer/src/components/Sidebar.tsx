// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { useEffect, useState } from 'react'
import { byName, matchSession } from '../treeUtils'
import { useT } from '../i18n'
import type { Folder, SessionInfo, SessionTree } from '../../../shared/types'

const DRAG_TYPE = 'application/x-tm-item'
const COLLAPSED_KEY = 'tm.collapsedFolders'

export type SidebarAction =
  | { type: 'open'; session: SessionInfo }
  | { type: 'newSession'; folderId: string | null }
  | { type: 'editSession'; session: SessionInfo }
  | { type: 'duplicateSession'; session: SessionInfo }
  | { type: 'deleteSession'; session: SessionInfo }
  | { type: 'newFolder'; parentId: string | null }
  | { type: 'renameFolder'; folder: Folder }
  | { type: 'deleteFolder'; folder: Folder }

interface Props {
  tree: SessionTree
  onAction: (a: SidebarAction) => void
  onMove: (kind: 'session' | 'folder', id: string, target: string | null) => void
}

interface MenuState {
  x: number
  y: number
  items: { label: string; action: SidebarAction; danger?: boolean }[]
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

export default function Sidebar({ tree, onAction, onMove }: Props): React.JSX.Element {
  const t = useT()
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
    } catch {
      // 저장 실패는 무시 (펼침 상태는 편의 기능)
    }
  }, [collapsed])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const filtering = filter.trim().length > 0
  const visibleSessions = filtering
    ? tree.sessions.filter((s) => matchSession(s, tree.folders, filter))
    : tree.sessions

  // 검색 중에는 일치하는 세션이 있는 폴더만 보여줌
  const folderHasMatch = (id: string): boolean =>
    visibleSessions.some((s) => s.folderId === id) ||
    tree.folders.some((f) => f.parentId === id && folderHasMatch(f.id))

  const openMenu = (e: React.MouseEvent, items: MenuState['items']): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  // ───── 드래그로 세션/폴더 이동 ─────
  const onDragStart = (e: React.DragEvent, kind: 'session' | 'folder', id: string): void => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind, id }))
    e.dataTransfer.effectAllowed = 'move'
  }
  const dropProps = (target: string | null): React.HTMLAttributes<HTMLElement> => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(target)
    },
    onDragLeave: (e) => {
      e.stopPropagation()
      setDropTarget(undefined)
    },
    onDrop: (e) => {
      const raw = e.dataTransfer.getData(DRAG_TYPE)
      setDropTarget(undefined)
      if (!raw) return
      e.preventDefault()
      e.stopPropagation()
      const { kind, id } = JSON.parse(raw)
      onMove(kind, id, target)
      if (target) setCollapsed((prev) => new Set([...prev].filter((x) => x !== target)))
    }
  })

  const renderSession = (s: SessionInfo, depth: number): React.JSX.Element => (
    <div
      key={s.id}
      className={`tree-row session ${selected === s.id ? 'selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 16 }}
      title={t('sidebar.sessionTitle', { target: `${s.username}@${s.host}:${s.port}` })}
      draggable
      onDragStart={(e) => onDragStart(e, 'session', s.id)}
      onClick={() => setSelected(s.id)}
      onDoubleClick={() => onAction({ type: 'open', session: s })}
      onKeyDown={(e) => e.key === 'Enter' && onAction({ type: 'open', session: s })}
      tabIndex={0}
      onContextMenu={(e) => {
        setSelected(s.id)
        openMenu(e, [
          { label: t('sidebar.connect'), action: { type: 'open', session: s } },
          { label: t('sidebar.edit'), action: { type: 'editSession', session: s } },
          { label: t('sidebar.duplicate'), action: { type: 'duplicateSession', session: s } },
          {
            label: t('sidebar.delete'),
            action: { type: 'deleteSession', session: s },
            danger: true
          }
        ])
      }}
    >
      <span className="icon icon-key" aria-hidden />
      <span className="tree-label">{s.name}</span>
    </div>
  )

  const renderFolder = (f: Folder, depth: number): React.JSX.Element | null => {
    if (filtering && !folderHasMatch(f.id)) return null
    const open = filtering || !collapsed.has(f.id)
    return (
      <div key={f.id}>
        <div
          className={`tree-row folder ${dropTarget === f.id ? 'drop' : ''} ${selected === f.id ? 'selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          draggable
          onDragStart={(e) => onDragStart(e, 'folder', f.id)}
          onClick={() => {
            setSelected(f.id)
            toggle(f.id)
          }}
          onContextMenu={(e) => {
            setSelected(f.id)
            openMenu(e, [
              { label: t('sidebar.newSession'), action: { type: 'newSession', folderId: f.id } },
              { label: t('sidebar.newSubfolder'), action: { type: 'newFolder', parentId: f.id } },
              { label: t('sidebar.rename'), action: { type: 'renameFolder', folder: f } },
              {
                label: t('sidebar.deleteFolder'),
                action: { type: 'deleteFolder', folder: f },
                danger: true
              }
            ])
          }}
          {...dropProps(f.id)}
        >
          <span className={`chevron ${open ? 'open' : ''}`} aria-hidden />
          <span className="icon icon-folder" aria-hidden />
          <span className="tree-label">{f.name}</span>
        </div>
        {open && renderChildren(f.id, depth + 1)}
      </div>
    )
  }

  const renderChildren = (parentId: string | null, depth: number): React.JSX.Element[] => [
    ...(tree.folders
      .filter((f) => f.parentId === parentId)
      .sort(byName)
      .map((f) => renderFolder(f, depth))
      .filter(Boolean) as React.JSX.Element[]),
    ...visibleSessions
      .filter((s) => s.folderId === parentId)
      .sort(byName)
      .map((s) => renderSession(s, depth))
  ]

  const selectedFolderId = tree.folders.some((f) => f.id === selected)
    ? selected
    : (tree.sessions.find((s) => s.id === selected)?.folderId ?? null)

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>{t('sidebar.title')}</span>
        <div className="sidebar-tools">
          <button
            title={t('sidebar.newSession')}
            onClick={() => onAction({ type: 'newSession', folderId: selectedFolderId })}
          >
            {t('sidebar.addSession')}
          </button>
          <button
            title={t('sidebar.newFolder')}
            onClick={() => onAction({ type: 'newFolder', parentId: selectedFolderId })}
          >
            {t('sidebar.addFolder')}
          </button>
        </div>
      </div>
      <input
        className="sidebar-search"
        placeholder={t('sidebar.search')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setFilter('')
          if (e.key === 'Enter' && visibleSessions.length > 0) {
            onAction({ type: 'open', session: [...visibleSessions].sort(byName)[0] })
          }
        }}
      />
      <div
        className={`tree ${dropTarget === null ? 'drop' : ''}`}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: t('sidebar.newSession'), action: { type: 'newSession', folderId: null } },
            { label: t('sidebar.newFolder'), action: { type: 'newFolder', parentId: null } }
          ])
        }
        {...dropProps(null)}
      >
        {renderChildren(null, 0)}
        {tree.sessions.length === 0 && tree.folders.length === 0 && (
          <div className="tree-empty">
            {t('sidebar.empty')}
            <br />
            <button onClick={() => onAction({ type: 'newSession', folderId: null })}>
              {t('sidebar.addFirst')}
            </button>
          </div>
        )}
        {filtering && visibleSessions.length === 0 && (
          <div className="tree-empty">{t('session.noMatch')}</div>
        )}
      </div>

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.items.map((it) => (
            <div
              key={it.label}
              className={`context-item ${it.danger ? 'danger' : ''}`}
              onClick={() => {
                setMenu(null)
                onAction(it.action)
              }}
            >
              {it.label}
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
