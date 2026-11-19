// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// 세션 입력값 검증 (electron 비의존 순수 모듈)
import { isIP } from 'net'
import type { SessionInput } from '../shared/types'
import { t } from './i18n.ts'

const DOMAIN_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/

/** IPv4/IPv6 이거나 도메인(호스트명) 형식인지 */
export function isValidHost(host: string): boolean {
  if (isIP(host)) return true
  // 숫자와 점만 있으면 IPv4 로 보고 엄격히 판정 (999.1.1.1 같은 값이 도메인으로 통과하지 않게)
  if (/^[\d.]+$/.test(host)) return false
  if (host.length > 253) return false
  return host.split('.').every((label) => DOMAIN_LABEL.test(label))
}

/** 통과하면 undefined, 실패하면 현재 언어의 메시지 */
export function validateSessionInput(input: SessionInput): string | undefined {
  if (!input || typeof input !== 'object') return t('validate.invalidInput')
  if (typeof input.name !== 'string' || !input.name.trim()) return t('validate.nameRequired')

  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (!host) return t('validate.hostRequired')
  if (!isValidHost(host)) return t('validate.hostInvalid', { host })

  const raw: unknown = input.port
  const port = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    return t('validate.portRange')

  if (typeof input.username !== 'string' || !input.username.trim())
    return t('validate.usernameRequired')

  if (input.authType !== 'key' && input.authType !== 'password') return t('validate.authType')
  if (input.authType === 'key' && !input.keyPath?.trim()) return t('validate.keyPathRequired')
  return undefined
}
