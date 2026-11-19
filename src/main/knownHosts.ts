// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
// known_hosts 저장소 (electron 비의존: 파일 입출력, 대기, 시계, 알림을 주입 가능 → node:test 로 검증)
// - 저장은 임시 파일에 쓴 뒤 rename 으로 교체. rename 이 실패하면 100ms 간격으로 최대 3회 시도.
// - 3회 모두 실패해도 예외를 던지지 않는다(접속은 계속). 호출자가 넘긴 notify 로 한국어 안내만 전달.
// - JSON 이 깨졌으면 known_hosts.json.corrupt-<Date.now()> 로 rename 하고 빈 목록으로 시작.
//   그 뒤 "처음 접속" 대화상자에는 지문이 사라졌다는 안내를 붙인다(프로세스 단위 플래그 하나, 캐시 없음).
import * as nodeFs from 'fs'
import { dirname } from 'path'
import { t } from './i18n.ts'

/** 저장 실패 안내 (부를 때의 언어로 번역) */
export const saveFailedMessage = (): string => t('knownHosts.saveFailed')
/** 지문 유실 안내 (부를 때의 언어로 번역) */
export const fingerprintsLostMessage = (): string => t('knownHosts.fingerprintsLost')
export const KNOWN_HOSTS_RETRY_COUNT = 3
export const KNOWN_HOSTS_RETRY_DELAY_MS = 100

export interface KnownHostsFs {
  existsSync(p: string): boolean
  readFileSync(p: string, enc: 'utf8'): string
  writeFileSync(p: string, data: string, enc: 'utf8'): void
  renameSync(from: string, to: string): void
  mkdirSync(p: string, opts: { recursive: true }): void
  unlinkSync(p: string): void
}

export interface KnownHostsOptions {
  /** known_hosts.json 전체 경로 */
  filePath: string
  fs?: Partial<KnownHostsFs>
  /** 저장용 rename (async). 실패 시험을 위해 주입 가능 */
  rename?: (from: string, to: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (msg: string, err?: unknown) => void
}

export interface KnownHosts {
  /** 저장된 지문 목록. 손상됐으면 백업하고 {} */
  load(): Record<string, string>
  /** 지문 저장. 절대 reject 하지 않는다. 실패하면 notify(saveFailedMessage()) 호출 후 false */
  save(hostKey: string, fingerprint: string, notify?: (msg: string) => void): Promise<boolean>
  /** 손상으로 지문이 사라졌다면 "처음 접속" 대화상자에 붙일 안내문, 아니면 undefined */
  lostNotice(): string | undefined
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createKnownHosts(opts: KnownHostsOptions): KnownHosts {
  const fs: KnownHostsFs = { ...(nodeFs as unknown as KnownHostsFs), ...opts.fs }
  const rename = opts.rename ?? ((a, b) => nodeFs.promises.rename(a, b))
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((m, e) => console.error(m, e))
  const { filePath } = opts
  let fingerprintsLost = false
  let tmpSeq = 0

  function backupCorrupt(): void {
    fingerprintsLost = true
    const backupPath = `${filePath}.corrupt-${now()}`
    try {
      fs.renameSync(filePath, backupPath)
    } catch (e) {
      log(`known_hosts 손상 파일 백업 실패: ${backupPath}`, e)
    }
  }

  function load(): Record<string, string> {
    if (!fs.existsSync(filePath)) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      backupCorrupt()
      return {}
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      backupCorrupt()
      return {}
    }
    return parsed as Record<string, string>
  }

  async function renameWithRetry(tmp: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, filePath)
        return
      } catch (e) {
        if (attempt >= KNOWN_HOSTS_RETRY_COUNT) throw e
        await sleep(KNOWN_HOSTS_RETRY_DELAY_MS)
      }
    }
  }

  async function save(
    hostKey: string,
    fingerprint: string,
    notify?: (msg: string) => void
  ): Promise<boolean> {
    const tmp = `${filePath}.tmp-${now()}-${tmpSeq++}`
    try {
      const all = load()
      all[hostKey] = fingerprint
      fs.mkdirSync(dirname(filePath), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8')
      await renameWithRetry(tmp)
      return true
    } catch (e) {
      log('known_hosts 저장 실패', e)
      try {
        fs.unlinkSync(tmp)
      } catch {
        // 임시 파일이 없으면 무시
      }
      try {
        notify?.(saveFailedMessage())
      } catch {
        // 알림 실패가 접속을 막지 않는다
      }
      return false
    }
  }

  return {
    load,
    save,
    lostNotice: () => (fingerprintsLost ? fingerprintsLostMessage() : undefined)
  }
}
