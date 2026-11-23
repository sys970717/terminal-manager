// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
/**
 * SSH 연결 하나가 쓰는 SFTP 채널 보관소 (순수 로직, electron/ssh2 를 import 하지 않는다).
 * - 동시에 여러 번 요청해도 채널은 하나만 연다 (opening Promise 공유).
 * - reset(): 연결이 close/end 되면 채널·home·열리는 중이던 Promise 를 모두 비운다.
 *   열리는 중이던 요청은 reject 되고, 늦게 도착한 채널은 바로 닫는다 (핸들 누수 방지).
 * - 갱신은 호출(이벤트) 기반이다. 타이머·폴링을 두지 않는다.
 */
export interface SftpLike {
  end(): void
  once(event: 'close', cb: () => void): unknown
}

export interface SftpHolderDeps<S extends SftpLike> {
  /** 채널 열기 (ssh2 의 conn.sftp 에 해당) */
  open(cb: (err: Error | undefined | null, s: S) => void): void
  /** 연결이 끝났는가 */
  isEnded(): boolean
  /** 살아 있는 채널 수 게이지의 acquire. 반환값은 채널이 실제로 닫힐 때 부르는 release */
  acquire(): () => void
  /** 연결 종료 오류 (현재 언어 메시지) */
  endedError(): Error
}

export interface SftpHolder<S extends SftpLike> {
  get(): Promise<S>
  /** home 디렉터리 캐시. 채널과 함께 reset 된다 */
  home(resolve: (s: S) => Promise<string>): Promise<string>
  reset(): void
  readonly hasChannel: boolean
  readonly opening: boolean
}

export function createSftpHolder<S extends SftpLike>(deps: SftpHolderDeps<S>): SftpHolder<S> {
  let sftp: S | null = null
  let opening: Promise<S> | null = null
  let homeDir: string | null = null
  // reset 마다 올라가는 세대 번호. 이전 세대의 open 콜백이 늦게 도착해도 상태를 건드리지 못하게 한다
  let gen = 0
  let rejectOpening: ((e: Error) => void) | null = null

  const closeQuietly = (s: S): void => {
    try {
      s.end()
    } catch {
      // 이미 닫힘
    }
  }

  const get = (): Promise<S> => {
    if (sftp) return Promise.resolve(sftp)
    if (opening) return opening
    const myGen = gen
    let resolveP!: (s: S) => void
    let rejectP!: (e: Error) => void
    const p = new Promise<S>((res, rej) => {
      resolveP = res
      rejectP = rej
    })
    // open 콜백이 동기로 불려도 상태가 꼬이지 않게 opening 을 먼저 세팅한다
    opening = p
    rejectOpening = rejectP
    // 아무도 기다리지 않아도 unhandledRejection 이 나지 않게 (호출자는 반환된 p 를 따로 받는다)
    p.catch(() => {})
    try {
      deps.open((err, s) => {
        if (myGen !== gen) {
          // reset 된 뒤에 도착: 쓰지 않고 닫는다 (호출자는 reset 에서 이미 reject 됨)
          if (!err) closeQuietly(s)
          return
        }
        opening = null
        rejectOpening = null
        if (err) return rejectP(err)
        if (deps.isEnded()) {
          // 열리는 도중 연결이 끝남: 새 채널을 쓰지 않고 바로 닫는다
          closeQuietly(s)
          return rejectP(deps.endedError())
        }
        sftp = s
        const release = deps.acquire()
        s.once('close', () => {
          release()
          if (sftp === s) {
            sftp = null
            homeDir = null
          }
        })
        resolveP(s)
      })
    } catch (e) {
      if (myGen === gen) {
        opening = null
        rejectOpening = null
      }
      rejectP(e as Error)
    }
    return p
  }

  return {
    get,
    async home(resolve) {
      if (homeDir) return homeDir
      const myGen = gen
      const s = await get()
      const h = await resolve(s)
      if (myGen === gen) homeDir = h
      return h
    },
    reset() {
      gen++
      const rej = rejectOpening
      const s = sftp
      sftp = null
      opening = null
      homeDir = null
      rejectOpening = null
      rej?.(deps.endedError())
      if (s) closeQuietly(s)
    },
    get hasChannel() {
      return sftp !== null
    },
    get opening() {
      return opening !== null
    }
  }
}
