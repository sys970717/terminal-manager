// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import type { AuthType } from '../../shared/types'
import { t } from './i18n'

/** 호스트가 IPv4, IPv6, 도메인(또는 단일 이름) 형식인지. BE 검증 규칙(PM 계획 3-5)과 같은 기준 */
export function isValidHost(host: string): boolean {
  const h = host.trim()
  if (!h || h.length > 253) return false
  // 숫자와 점만 있으면 IPv4 로 보고 각 자리를 검사
  if (/^[\d.]+$/.test(h)) {
    const parts = h.split('.')
    return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  }
  // IPv6 (콜론 2개 이상, 16진수/점/콜론만)
  if (h.includes(':')) return /^[0-9a-fA-F:.]+$/.test(h) && (h.match(/:/g) ?? []).length >= 2
  // 도메인: 라벨은 영문/숫자/하이픈, 하이픈으로 시작·끝 불가
  return h.split('.').every((l) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l))
}

export function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

export interface SessionFormValues {
  name: string
  host: string
  port: string
  username: string
  authType: AuthType
  keyPath: string
}

export type FieldErrors = Partial<Record<'name' | 'host' | 'port' | 'username' | 'keyPath', string>>

export function validateSessionForm(v: SessionFormValues): FieldErrors {
  const e: FieldErrors = {}
  if (!v.name.trim()) e.name = t('session.valid.name')
  if (!v.host.trim()) e.host = t('session.valid.hostRequired')
  else if (!isValidHost(v.host)) e.host = t('session.valid.hostFormat')
  if (!isValidPort(v.port)) e.port = t('session.valid.port')
  if (!v.username.trim()) e.username = t('session.valid.username')
  if (v.authType === 'key' && !v.keyPath.trim()) e.keyPath = t('session.valid.keyPath')
  return e
}
