// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// SSH 접속 보조 로직 (electron 을 import 하지 않는 순수 모듈 → node:test 로 직접 검증 가능)
// ssh.ts 가 이 모듈을 가져다 쓴다.
import { readFileSync } from 'fs'
import ssh2, { type Client } from 'ssh2'
import type { ConnState, SshErrorKind } from '../shared/types'
import { t } from './i18n.ts'

const sshUtils = ssh2.utils

/** 접속 시간 초과 (ms). ssh2 readyTimeout 으로 전달 → 초과하면 level 'client-timeout' */
export const READY_TIMEOUT_MS = 20000

/** safeStorage(DPAPI) 복호화 실패. classifySshError 가 decryptFailed 로 분류한다. */
export class DecryptError extends Error {
  readonly code = 'DECRYPT_FAILED'
  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? t('sshErr.decryptErrorCause', { cause: cause.message })
        : t('sshErr.decryptError')
    )
    this.name = 'DecryptError'
  }
}

export interface ClassifiedSshError {
  kind: SshErrorKind
  /** 사용자에게 보여줄 한 줄(현재 언어): "원인. 해결 방법." */
  message: string
}

type ErrLike = { code?: string; level?: string; message?: string }

const UNREACHABLE_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']

/**
 * ssh2 / 소켓 / 파일 / DPAPI 오류를 한국어 "원인 + 해결 방법" 한 줄로 분류한다.
 * 판별은 err.code 와 err.level 로 한다. (passphrase 오류만 ssh2 키 파싱 메시지로 판별)
 * @param ctx.keyPath 접속에 쓴 키 파일 경로 (.ppk 면 변환 안내를 덧붙임)
 */
export function classifySshError(err: unknown, ctx: { keyPath?: string } = {}): ClassifiedSshError {
  const e = (err ?? {}) as ErrLike
  const raw = e.message ?? String(err)

  if (e.code === 'DECRYPT_FAILED') {
    return {
      kind: 'decryptFailed',
      message: t('sshErr.decryptFailed')
    }
  }
  if (e.code === 'ENOENT') {
    return {
      kind: 'keyNotFound',
      message: t('sshErr.keyNotFound')
    }
  }
  if (e.level === 'client-authentication') {
    return {
      kind: 'authFailed',
      message: t('sshErr.authFailed')
    }
  }
  if (e.code && UNREACHABLE_CODES.includes(e.code)) {
    return {
      kind: 'unreachable',
      message: t('sshErr.unreachable')
    }
  }
  if (e.code === 'ETIMEDOUT' || e.level === 'client-timeout') {
    return {
      kind: 'timeout',
      message: t('sshErr.timeout')
    }
  }
  if (isPassphraseError(raw)) {
    return {
      kind: 'passphraseWrong',
      message: t('sshErr.passphraseWrong')
    }
  }

  let message = t('sshErr.other', { raw })
  if (isPpk(ctx.keyPath, raw)) message += ` ${t('sshErr.ppkHint')}`
  return { kind: 'other', message }
}

/** ssh2 parseKey 의 "암호가 틀렸다" 계열 메시지 (암호 미입력 메시지는 제외) */
function isPassphraseError(msg: string): boolean {
  if (/no passphrase given/i.test(msg)) return false
  return /bad passphrase|incorrect passphrase|wrong passphrase|passphrase.*(invalid|mismatch)/i.test(
    msg
  )
}

function isPpk(keyPath: string | undefined, msg: string): boolean {
  return (!!keyPath && /\.ppk$/i.test(keyPath.trim())) || /PuTTY-User-Key-File/i.test(msg)
}

// ───────────────────────── keyboard-interactive ─────────────────────────

/**
 * keyboard-interactive 자동 응답. 질문이 정확히 1개이고 저장된 비밀번호가 있을 때만 응답한다.
 * null 이면 자동 응답하지 않는다(호출자는 빈 응답으로 인증 실패 처리).
 */
export function answerKeyboardInteractive(
  prompts: ReadonlyArray<unknown>,
  password: string | undefined
): string[] | null {
  if (prompts.length === 1 && password) return [password]
  return null
}

/**
 * Client 에 keyboard-interactive 핸들러를 붙인다.
 * 자동 응답 대상이 아니면(질문 2개 이상 등) 빈 응답을 보내 인증 실패로 처리한다.
 */
export function attachKeyboardInteractive(conn: Client, password: string | undefined): void {
  conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
    done(answerKeyboardInteractive(prompts, password) ?? [])
  })
}

// ───────────────────────── 키 읽기 ─────────────────────────

export interface LoadedKey {
  privateKey: Buffer
  passphrase?: string
}

/**
 * 키 파일을 읽고 passphrase 를 검증한다. 실패하면 classifySshError 가 분류할 수 있는 Error 를 던진다.
 * - 파일이 없으면 err.code === 'ENOENT' (readFileSync 오류 그대로)
 * - 암호화된 키인데 passphrase 가 없으면 askPassphrase() 로 받는다(null 이면 취소 → null 반환)
 * - passphrase 가 틀리면 ssh2 파싱 오류(Bad passphrase)를 그대로 던진다
 */
export async function loadPrivateKey(
  keyPath: string,
  savedPassphrase: string | undefined,
  askPassphrase: () => Promise<string | null>
): Promise<LoadedKey | null> {
  const privateKey = readFileSync(keyPath)
  const probe = sshUtils.parseKey(privateKey)
  const needsPassphrase = probe instanceof Error && /passphrase/i.test(probe.message)
  if (probe instanceof Error && !needsPassphrase) throw probe // 지원하지 않는 형식 등

  let passphrase = savedPassphrase
  if (needsPassphrase && !passphrase) {
    const typed = await askPassphrase()
    if (typed === null) return null
    passphrase = typed
  }
  if (needsPassphrase) {
    const checked = sshUtils.parseKey(privateKey, passphrase)
    if (checked instanceof Error) throw checked
  }
  return { privateKey, passphrase: passphrase || undefined }
}

// ───────────────────────── 연결 상태 ─────────────────────────

/** 'error' 는 종료 상태: 이후 'closed' 등으로 덮어쓰지 않는다. */
export function nextConnState(cur: ConnState, next: ConnState): ConnState {
  return cur === 'error' ? 'error' : next
}
