// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { useEffect, useMemo, useRef, useState } from 'react'
import { byName, folderPath, matchSession } from '../treeUtils'
import { useT } from '../i18n'
import type { SessionInfo, SessionTree } from '../../../shared/types'

/** Ctrl+Shift+K: 이름 일부만 입력하고 Enter 로 바로 접속 */
export default function QuickConnect({
  tree,
  onOpen,
  onClose
}: {
  tree: SessionTree
  onOpen: (s: SessionInfo) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(
    () => tree.sessions.filter((s) => matchSession(s, tree.folders, q)).sort(byName),
    [tree, q]
  )

  useEffect(() => {
    listRef.current?.children[idx]?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  return (
    <div
      className="modal-backdrop top"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette">
        <input
          autoFocus
          placeholder={t('quick.placeholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter' && results[idx]) {
              onOpen(results[idx])
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((s, i) => (
            <div
              key={s.id}
              className={`palette-item ${i === idx ? 'active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => onOpen(s)}
            >
              <span className="icon icon-key" aria-hidden />
              <span className="palette-name">{s.name}</span>
              <span className="palette-meta">
                {folderPath(tree.folders, s.folderId)} · {s.username}@{s.host}
              </span>
            </div>
          ))}
          {results.length === 0 && <div className="palette-empty">{t('session.noMatch')}</div>}
        </div>
      </div>
    </div>
  )
}
