// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n'

export function Modal({
  title,
  children,
  onClose,
  width = 420
}: {
  title: string
  children: ReactNode
  onClose: () => void
  width?: number
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  )
}

/** window.prompt 대체 (Electron 에서는 prompt 를 쓸 수 없음) */
export function InputDialog({
  title,
  label,
  initial = '',
  onSubmit,
  onClose
}: {
  title: string
  label: string
  initial?: string
  onSubmit: (value: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary" disabled={!value.trim()}>
            {t('common.ok')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose
}: {
  title: string
  message: string
  /** 없으면 "삭제" */
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-message">{message}</p>
      <div className="modal-actions">
        <button onClick={onClose}>{t('common.cancel')}</button>
        <button className="danger" autoFocus onClick={onConfirm}>
          {confirmLabel ?? t('common.delete')}
        </button>
      </div>
    </Modal>
  )
}
