// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { useState } from 'react'
import { Modal } from './Modal'
import { folderOptions } from '../treeUtils'
import { errMsg } from '../errors'
import { validateSessionForm } from '../sessionValidation'
import { useT } from '../i18n'
import type { AuthType, Folder, SessionInfo, SessionInput } from '../../../shared/types'

// shared/types.ts 의 SaveSessionResult 와 같은 모양
type SavedResult = SessionInfo & { warnings?: string[] }

interface Props {
  session?: SessionInfo // 없으면 새 세션
  defaultFolderId: string | null
  folders: Folder[]
  encryptionAvailable: boolean
  onSaved: (s: SessionInfo) => void
  onClose: () => void
}

export default function SessionDialog({
  session,
  defaultFolderId,
  folders,
  encryptionAvailable,
  onSaved,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(session?.name ?? '')
  const [folderId, setFolderId] = useState<string | null>(session?.folderId ?? defaultFolderId)
  const [host, setHost] = useState(session?.host ?? '')
  const [port, setPort] = useState(String(session?.port ?? 22))
  const [username, setUsername] = useState(session?.username ?? '')
  const [authType, setAuthType] = useState<AuthType>(session?.authType ?? 'key')
  const [keyPath, setKeyPath] = useState(session?.keyPath ?? '')
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [clearPassphrase, setClearPassphrase] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitted, setSubmitted] = useState(false) // 저장을 한 번 시도한 뒤부터 필드 오류를 보여줌
  // 저장은 끝났지만 경고(예: 키 파일 없음)가 있어 사용자가 확인할 때까지 열어 두는 상태
  const [pending, setPending] = useState<SavedResult | null>(null)

  const fieldErrors = validateSessionForm({ name, host, port, username, authType, keyPath })
  const show = (k: keyof typeof fieldErrors): string | undefined =>
    submitted ? fieldErrors[k] : undefined

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    setSubmitted(true)
    if (Object.keys(fieldErrors).length > 0) return
    const input: SessionInput = {
      id: session?.id,
      name: name.trim(),
      folderId,
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      authType,
      keyPath: authType === 'key' ? keyPath.trim() : undefined,
      // undefined = 기존 값 유지, '' = 삭제
      password:
        authType === 'password' ? (password ? password : clearPassword ? '' : undefined) : '',
      passphrase:
        authType === 'key' ? (passphrase ? passphrase : clearPassphrase ? '' : undefined) : ''
    }
    setSaving(true)
    try {
      const saved: SavedResult = await window.api.sessions.saveSession(input)
      // 비밀값은 저장 직후 폐기 (대화상자는 곧 닫힘)
      setPassword('')
      setPassphrase('')
      if (saved.warnings && saved.warnings.length > 0) {
        setPending(saved) // 저장은 성공. 경고를 보여주고 확인/닫기 때 onSaved 호출
      } else {
        onSaved(saved)
      }
    } catch (err) {
      setError(errMsg(err)) // BE 검증/저장 실패 메시지(한국어 한 줄)를 대화상자 안에 표시
    } finally {
      setSaving(false)
    }
  }

  const pickKey = async (): Promise<void> => {
    try {
      const p = await window.api.sessions.pickKeyFile()
      if (p) setKeyPath(p)
    } catch (err) {
      setError(errMsg(err))
    }
  }

  // 필드 공통 접근성 속성
  const a11y = (id: string, msg?: string): React.InputHTMLAttributes<HTMLInputElement> => ({
    id,
    'aria-invalid': !!msg,
    'aria-describedby': msg ? `${id}-err` : undefined
  })
  const err = (id: string, msg?: string): React.JSX.Element | null =>
    msg ? (
      <small id={`${id}-err`} className="field-error" role="alert">
        {msg}
      </small>
    ) : null
  const req = (
    <b className="req" aria-hidden title={t('session.form.required')}>
      *
    </b>
  )

  // 경고가 있는 저장: Esc·바깥 클릭·확인 어느 쪽으로 닫아도 목록이 갱신되도록 onSaved 를 부른다
  if (pending) {
    const done = (): void => onSaved(pending)
    return (
      <Modal title={t('session.saved.title')} onClose={done} width={480}>
        <p className="modal-message">{t('session.saved.message', { name: pending.name })}</p>
        <ul className="form-warning" role="alert">
          {(pending.warnings ?? []).map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        <small>{t('session.saved.hint')}</small>
        <div className="modal-actions">
          <button type="button" className="primary" autoFocus onClick={done}>
            {t('common.ok')}
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={session ? t('session.editTitle') : t('session.newTitle')}
      onClose={onClose}
      width={480}
    >
      <form onSubmit={submit} className="session-form" noValidate>
        <label className="field">
          <span>
            {t('session.form.name')} {req}
          </span>
          <input
            {...a11y('sd-name', show('name'))}
            autoFocus
            required
            value={name}
            placeholder={t('session.form.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
          {err('sd-name', show('name'))}
        </label>
        <label className="field">
          <span>{t('session.form.folder')}</span>
          <select value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value || null)}>
            <option value="">{t('session.form.root')}</option>
            {folderOptions(folders).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="field-row">
          <label className="field grow">
            <span>
              {t('session.form.host')} {req}
            </span>
            <input
              {...a11y('sd-host', show('host'))}
              required
              value={host}
              placeholder={t('session.form.hostPlaceholder')}
              onChange={(e) => setHost(e.target.value)}
            />
            {err('sd-host', show('host'))}
          </label>
          <label className="field port">
            <span>
              {t('session.form.port')} {req}
            </span>
            <input
              {...a11y('sd-port', show('port'))}
              required
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            />
            {err('sd-port', show('port'))}
          </label>
        </div>
        <label className="field">
          <span>
            {t('session.form.username')} {req}
          </span>
          <input
            {...a11y('sd-user', show('username'))}
            required
            value={username}
            placeholder={t('session.form.usernamePlaceholder')}
            onChange={(e) => setUsername(e.target.value)}
          />
          {err('sd-user', show('username'))}
        </label>
        <div className="field" role="radiogroup" aria-label={t('session.form.authMethod')}>
          <span>{t('session.form.auth')}</span>
          <div className="radio-row">
            <label>
              <input
                type="radio"
                checked={authType === 'key'}
                onChange={() => setAuthType('key')}
              />{' '}
              {t('session.form.pemKey')}
            </label>
            <label>
              <input
                type="radio"
                checked={authType === 'password'}
                onChange={() => setAuthType('password')}
              />{' '}
              {t('session.form.password')}
            </label>
          </div>
        </div>

        {authType === 'key' ? (
          <>
            <label className="field">
              <span>
                {t('session.form.keyFile')} {req}
              </span>
              <div className="input-with-button">
                <input
                  {...a11y('sd-key', show('keyPath'))}
                  value={keyPath}
                  placeholder={
                    navigator.userAgent.includes('Mac')
                      ? '~/.ssh/server.pem'
                      : 'C:\\keys\\server.pem'
                  }
                  onChange={(e) => setKeyPath(e.target.value)}
                />
                <button type="button" onClick={pickKey}>
                  {t('session.form.browse')}
                </button>
              </div>
              {err('sd-key', show('keyPath'))}
              <small>{t('session.form.keyPathOnly')}</small>
            </label>
            <label className="field">
              <span>{t('session.form.passphrase')}</span>
              <input
                type="password"
                value={passphrase}
                disabled={!encryptionAvailable}
                placeholder={
                  session?.hasPassphrase
                    ? t('session.form.savedTypeToChange')
                    : t('session.form.passphraseEmpty')
                }
                onChange={(e) => setPassphrase(e.target.value)}
              />
              {!encryptionAvailable && <small>{t('session.form.passphraseNoEnc')}</small>}
              {session?.hasPassphrase && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={clearPassphrase}
                    onChange={(e) => setClearPassphrase(e.target.checked)}
                  />{' '}
                  {t('session.form.clearPassphrase')}
                </label>
              )}
            </label>
          </>
        ) : (
          <label className="field">
            <span>{t('session.form.password')}</span>
            <input
              type="password"
              value={password}
              disabled={!encryptionAvailable}
              placeholder={
                session?.hasPassword
                  ? t('session.form.savedTypeToChange')
                  : t('session.form.passwordEmpty')
              }
              onChange={(e) => setPassword(e.target.value)}
            />
            {session?.hasPassword && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={clearPassword}
                  onChange={(e) => setClearPassword(e.target.checked)}
                />{' '}
                {t('session.form.clearPassword')}
              </label>
            )}
            <small>
              {encryptionAvailable
                ? navigator.userAgent.includes('Mac')
                  ? t('session.form.encMac')
                  : t('session.form.encWin')
                : t('session.form.passwordNoEnc')}
            </small>
          </label>
        )}

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
