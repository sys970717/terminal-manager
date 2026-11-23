// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { app, BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { createHash } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { promises as fsp } from 'fs'
import { basename, join, posix } from 'path'
import { getConnectInfo, type ConnectInfo } from './sessionStore'
import {
  READY_TIMEOUT_MS,
  attachKeyboardInteractive,
  classifySshError,
  loadPrivateKey,
  nextConnState
} from './sshAuth.ts'
import { createKnownHosts, type KnownHosts } from './knownHosts.ts'
import { createGauge } from './gauge.ts'
import { createSftpHolder } from './sftpHolder.ts'
import { createShellGate } from './shellGate.ts'
import type { TermBackend, TermEmitter } from './terms'
import type {
  ConnState,
  RemoteEntry,
  RemoteListing,
  RemoveResult,
  UploadProgress
} from '../shared/types'
import {
  modeKind,
  normalizeRemotePath,
  safeLocalName,
  sftpError,
  sortEntries,
  toEntry,
  validName
} from './sftpUtil.ts'
import { t } from './i18n.ts'

type SftpAttrs = { mode: number; size: number; mtime: number }
type SftpItem = { filename: string; attrs: SftpAttrs }

// 다운로드 폴더 대화상자에서 마지막으로 고른 곳 (모든 탭이 같이 쓴다)
let lastPickedDir: string | null = null

export { classifySshError, answerKeyboardInteractive } from './sshAuth.ts'

// 살아 있는 ssh 자원 개수 (dev 진단용). 소켓/채널/SFTP 가 실제로 닫힐 때 내려간다 → 0 이 아니면 누수
const gauges = { clients: createGauge(), streams: createGauge(), sftp: createGauge() }
export function getSshStats(): { clients: number; streams: number; sftp: number } {
  return {
    clients: gauges.clients.value,
    streams: gauges.streams.value,
    sftp: gauges.sftp.value
  }
}

const GRAY = '\x1b[90m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

/** 덮어쓰기 확인 대화상자에 보여줄 이름 목록 (15개까지, 나머지는 개수만) */
function conflictList(names: string[]): string {
  const shown = names.slice(0, 15).join('\n')
  return names.length > 15
    ? `${shown}\n${t('sftp.conflict.more', { count: names.length - 15 })}`
    : shown
}

// ───────────────────────── known_hosts (처음 접속 시 지문 확인 → 저장, 바뀌면 경고) ─────────────────────────

let knownHosts: KnownHosts | null = null
function getKnownHosts(): KnownHosts {
  knownHosts ??= createKnownHosts({ filePath: join(app.getPath('userData'), 'known_hosts.json') })
  return knownHosts
}

async function verifyHostKey(
  win: BrowserWindow | null,
  info: ConnectInfo,
  key: Buffer,
  notify: (msg: string) => void,
  signal: AbortSignal
): Promise<boolean> {
  const fp = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  const hostKey = `[${info.host}]:${info.port}`
  const kh = getKnownHosts()
  const known = kh.load()[hostKey]
  if (known === fp) return true

  const opts: Electron.MessageBoxOptions = known
    ? {
        type: 'warning',
        title: t('hostKey.changed.title'),
        message: t('hostKey.changed.message', { name: info.name, host: hostKey }),
        detail: t('hostKey.changed.detail', { old: known, current: fp }),
        buttons: [t('common.cancel'), t('hostKey.changed.replace')],
        defaultId: 0,
        cancelId: 0,
        signal
      }
    : {
        type: 'question',
        title: t('hostKey.new.title'),
        message: t('hostKey.new.message', { name: info.name, host: hostKey }),
        detail:
          t('hostKey.new.detail', { fp }) + (kh.lostNotice() ? `\n\n⚠ ${kh.lostNotice()}` : ''),
        buttons: [t('hostKey.new.accept'), t('common.cancel')],
        defaultId: 0,
        cancelId: 1,
        signal
      }
  if (signal.aborted) return false
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  // 탭이 닫혀 대화상자가 중단(abort)됐으면 취소로 취급하고 known_hosts 에 저장하지 않는다
  const accepted = !signal.aborted && (known ? r.response === 1 : r.response === 0)
  // 저장에 실패해도(3회 재시도 후) 접속은 계속한다. 안내만 터미널에 출력
  if (accepted) await kh.save(hostKey, fp, notify)
  return accepted
}

// ───────────────────────── SSH 터미널 ─────────────────────────

export function connectSsh(
  owner: WebContents,
  emit: TermEmitter,
  sessionId: string,
  cols: number,
  rows: number
): TermBackend {
  const win = BrowserWindow.fromWebContents(owner)
  const conn = new Client()
  let stream: ClientChannel | null = null
  let size = { cols, rows }
  let state: ConnState = 'connecting'
  let lastError: string | undefined // 오류 종료 사유(현재 언어). 있으면 term:exit 의 reason 으로 전달
  // 업로드/다운로드는 한 번에 하나씩 (같은 SFTP 채널을 순서대로 쓴다)
  let transferChain: Promise<void> = Promise.resolve()
  let lastDownloadDir: string | null = null
  const ended = (): boolean => state === 'error' || state === 'closed'
  // 종료 시 abort: 열려 있는 호스트키/덮어쓰기 대화상자를 닫고, 진행 중 SFTP 대기를 끊는다
  const abort = new AbortController()
  const endedSignal = new Promise<never>((_, reject) =>
    abort.signal.addEventListener('abort', () => reject(new Error(t('ssh.ended'))), {
      once: true
    })
  )
  endedSignal.catch(() => {}) // 아무도 기다리지 않아도 unhandledRejection 이 나지 않게
  /** 연결이 종료되면 영원히 끝나지 않는 SFTP 대기(Promise)도 같이 reject 되게 한다 */
  const alive = <T>(p: Promise<T>): Promise<T> => Promise.race([p, endedSignal])

  // SFTP 채널·home·열리는 중인 Promise 는 연결(conn)마다 따로. close/end 때 반드시 비운다 (아래 conn.on)
  // 셸이 열릴 때까지 파일 조회를 기다리게 하는 문 (연결 중 조회가 "접속 안 됨" 으로 끝나 패널이 비는 것을 막는다)
  const shellGate = createShellGate()
  shellGate.wait().catch(() => {}) // 닫힌 뒤 아무도 기다리지 않아도 unhandledRejection 이 나지 않게
  const holder = createSftpHolder<SFTPWrapper>({
    open: (cb) => conn.sftp(cb),
    isEnded: ended,
    acquire: () => gauges.sftp.acquire(),
    endedError: () => new Error(t('ssh.ended'))
  })
  // 다른 close 리스너(onClosed)보다 먼저 등록해서 항상 먼저 초기화한다. 이벤트 기반이며 타이머는 없다
  conn.on('end', () => holder.reset())
  conn.on('close', () => holder.reset())

  // 접속 전 비밀번호/암호 입력용 (터미널에서 직접 입력받음, 화면에 표시 안 함)
  let promptState: { buf: string; resolve: (v: string | null) => void } | null = null
  const prompt = (label: string): Promise<string | null> => {
    emit.data(label)
    return new Promise((resolve) => (promptState = { buf: '', resolve }))
  }

  /** 종료 정리: 입력 대기 해제, SFTP/셸/클라이언트(소켓과 keepalive 타이머 포함) 닫기 */
  const cleanup = (): void => {
    abort.abort()
    shellGate.close(new Error(t('ssh.ended')))
    promptState?.resolve(null)
    promptState = null
    holder.reset()
    stream = null
    conn.destroy()
  }

  /**
   * 종료는 한 번만. reason 이 있으면 오류 종료('error'), 없으면 정상 종료('closed').
   * 'error' 이후에 close 이벤트가 와도 상태를 덮어쓰지 않는다.
   */
  const finish = (code: number, reason?: string): void => {
    if (ended()) return
    state = nextConnState(state, reason ? 'error' : 'closed')
    cleanup()
    emit.exit(code, reason)
  }

  /** 오류를 터미널에 보여주고 종료 사유를 기록 (실제 종료는 finish) */
  const fail = (err: unknown, keyPath?: string): string => {
    const { message } = classifySshError(err, { keyPath })
    emit.data(`\r\n${RED}${message}${RESET}\r\n`)
    lastError ??= message
    return message
  }

  /** 셸/소켓이 닫혔을 때: 앞서 오류가 기록됐으면 오류 종료, 아니면 정상 종료 */
  const onClosed = (): void => {
    if (ended()) return
    if (lastError) return finish(1, lastError)
    emit.data(`\r\n${GRAY}${t('ssh.disconnected')}${RESET}\r\n`)
    finish(0)
  }

  const start = async (): Promise<void> => {
    let info: ConnectInfo
    try {
      info = getConnectInfo(sessionId)
    } catch (e) {
      return finish(1, fail(e))
    }
    if (ended()) return
    const connecting = t('ssh.connecting', {
      user: info.username,
      host: info.host,
      port: info.port
    })
    emit.data(`${GRAY}${connecting}${RESET}\r\n`)

    const cfg: ConnectConfig = {
      host: info.host,
      port: info.port,
      username: info.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        if (ended()) return verify(false)
        verifyHostKey(
          win,
          info,
          key,
          (msg) => !ended() && emit.data(`\r\n${RED}${msg}${RESET}\r\n`),
          abort.signal
        ).then(verify, () => verify(false))
      }
    }

    if (info.authType === 'key') {
      if (!info.keyPath) {
        return finish(1, fail(new Error(t('ssh.keyPathEmpty'))))
      }
      try {
        const key = await loadPrivateKey(info.keyPath, info.passphrase, () =>
          prompt(t('ssh.passphrasePrompt'))
        )
        if (!key) return // 입력 취소 (finish 에서 이미 정리됨)
        cfg.privateKey = key.privateKey
        if (key.passphrase) cfg.passphrase = key.passphrase
      } catch (e) {
        return finish(1, fail(e, info.keyPath))
      }
    } else {
      let password = info.password
      if (!password) {
        password =
          (await prompt(t('ssh.passwordPrompt', { user: info.username, host: info.host }))) ??
          undefined
        if (password === undefined) return
      }
      cfg.password = password
      // 비밀번호 인증 대신 keyboard-interactive 만 여는 서버 대응:
      // 질문이 1개일 때만 저장된 비밀번호로 응답하고, 2개 이상이면 자동 응답하지 않는다(→ 인증 실패)
      cfg.tryKeyboard = true
      attachKeyboardInteractive(conn, password)
    }
    if (ended()) return

    conn.on('ready', () => {
      if (ended()) return
      state = nextConnState(state, 'connected')
      conn.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, ch) => {
        if (err) {
          fail(new Error(t('ssh.shellFailed', { message: err.message })))
          return finish(1, lastError)
        }
        if (ended()) return ch.close()
        stream = ch
        shellGate.open()
        ch.once('close', gauges.streams.acquire()) // 채널이 실제로 닫힐 때 내려간다
        const out = new StringDecoder('utf8') // 한글 등 멀티바이트가 청크 경계에서 깨지지 않게
        const errOut = new StringDecoder('utf8')
        ch.on('data', (b: Buffer) => !ended() && emit.data(out.write(b)))
        ch.stderr.on('data', (b: Buffer) => !ended() && emit.data(errOut.write(b)))
        ch.on('close', onClosed)
        emit.ready?.() // SSH ready 와 셸 열림을 모두 마친 시점 (분리 창 성공 판정)
      })
    })
    conn.on('error', (err) => {
      // 오류 직후 close 가 따라온다. 사유만 기록하고 종료는 close 에서 한 번 처리
      if (!ended()) fail(err, info.keyPath)
    })
    conn.on('close', onClosed)

    // 소켓이 실제로 닫힐 때(close 이벤트) 내려간다. connect 전에는 소켓이 없으므로 여기서 올린다
    const releaseClient = gauges.clients.acquire()
    conn.once('close', releaseClient)
    try {
      conn.connect(cfg)
    } catch (e) {
      releaseClient() // connect 가 동기적으로 던지면 close 가 오지 않는다
      finish(1, fail(e, info.keyPath))
    }
  }

  const getSftp = (): Promise<SFTPWrapper> => holder.get()

  const realpath = (s: SFTPWrapper, p: string): Promise<string> =>
    new Promise((res, rej) => s.realpath(p, (e, r) => (e ? rej(sftpError(e, p)) : res(r))))

  const getHome = (): Promise<string> => holder.home((s) => realpath(s, '.'))

  // ssh2 콜백 API 를 Promise 로 (오류는 현재 언어의 메시지로)
  const readdirP = (s: SFTPWrapper, p: string): Promise<SftpItem[]> =>
    new Promise((res, rej) =>
      s.readdir(p, (e, list) =>
        e
          ? rej(sftpError(e, p))
          : res(list.filter((f) => f.filename !== '.' && f.filename !== '..'))
      )
    )
  const statP = (s: SFTPWrapper, p: string, follow = true): Promise<SftpAttrs> =>
    new Promise((res, rej) =>
      (follow ? s.stat : s.lstat).call(s, p, (e: unknown, st: SftpAttrs) =>
        e ? rej(sftpError(e, p)) : res(st)
      )
    )
  /** 링크도 있는 것으로 친다 (깨진 링크 포함) */
  const existsP = (s: SFTPWrapper, p: string): Promise<boolean> =>
    new Promise((res) => s.lstat(p, (e) => res(!e)))
  const call = (p: string, fn: (cb: (e?: Error | null) => void) => void): Promise<void> =>
    new Promise((res, rej) => fn((e) => (e ? rej(sftpError(e, p)) : res())))

  /** 셸이 열릴 때까지 기다린다. 이미 끝난 연결이면 바로 실패, 기다리는 도중 끝나도 reject */
  const waitShell = async (notConnectedMsg: string): Promise<void> => {
    if (ended()) throw new Error(notConnectedMsg)
    await shellGate.wait()
    if (!stream) throw new Error(notConnectedMsg)
  }

  /** SFTP 작업 준비: 접속 확인, 채널, home */
  const ready = async (): Promise<{ s: SFTPWrapper; home: string }> => {
    await waitShell(t('ssh.notConnected'))
    const s = await getSftp()
    return { s, home: await getHome() }
  }

  const mkdirRemote = async (dir: string, name: string): Promise<string> => {
    const { s, home } = await ready()
    const p = posix.join(normalizeRemotePath(dir, home), validName(name))
    if (await existsP(s, p)) throw new Error(t('sftp.exists', { name: posix.basename(p) }))
    await call(p, (cb) => s.mkdir(p, cb))
    return p
  }

  const renameRemote = async (dir: string, from: string, to: string): Promise<void> => {
    const { s, home } = await ready()
    const base = normalizeRemotePath(dir, home)
    const a = posix.join(base, validName(from))
    const b = posix.join(base, validName(to))
    if (a === b) return
    // SFTP 버전에 따라 rename 이 덮어쓰기도 하므로 먼저 확인한다
    if (await existsP(s, b)) throw new Error(t('sftp.exists', { name: posix.basename(b) }))
    await call(a, (cb) => s.rename(a, b, cb))
  }

  /** 지울 수 없는 곳: 루트, home 자체 */
  const guardRemove = (p: string, home: string): void => {
    if (p === '/' || p === home || posix.dirname(p) === p)
      throw new Error(t('sftp.cannotRemove', { path: p }))
  }

  const removeRemote = async (paths: string[]): Promise<RemoveResult> => {
    const { s, home } = await ready()
    const targets = [...new Set(paths.map((p) => normalizeRemotePath(p, home).replace(/\/+$/, '')))]
    for (const t of targets) guardRemove(t, home)
    let deleted = 0
    // lstat 기준: 링크는 가리키는 대상이 아니라 링크만 지운다
    const rm = async (p: string, mode: number): Promise<void> => {
      if (ended()) throw new Error(t('ssh.ended'))
      if (modeKind(mode) === 'dir') {
        for (const f of await readdirP(s, p)) await rm(posix.join(p, f.filename), f.attrs.mode)
        await call(p, (cb) => s.rmdir(p, cb))
      } else {
        await call(p, (cb) => s.unlink(p, cb))
      }
      deleted++
    }
    for (const t of targets) await rm(t, (await statP(s, t, false)).mode)
    return { deleted }
  }

  const progress = (p: Omit<UploadProgress, 'termId'>): void => emit.progress(p)

  /** 저장할 로컬 폴더: 테스트는 TM_DOWNLOAD_DIR, 평소엔 대화상자 */
  const pickDownloadDir = async (): Promise<string | null> => {
    const fixed = process.env['TM_DOWNLOAD_DIR']
    if (fixed) return fixed
    const opts: Electron.OpenDialogOptions = {
      title: t('sftp.pickDownloadDir.title'),
      buttonLabel: t('sftp.pickDownloadDir.button'),
      defaultPath: lastPickedDir ?? app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    lastPickedDir = r.filePaths[0]
    return lastPickedDir
  }

  const doDownload = async (remotePaths: string[]): Promise<void> => {
    const { s, home } = await ready()
    const targets = [...new Set(remotePaths.map((p) => normalizeRemotePath(p, home)))]
    const dest = await pickDownloadDir()
    if (!dest || ended()) return

    // 받을 목록 (폴더는 재귀). 로컬 이름은 윈도우에서 쓸 수 있게 바꾼다.
    // 링크: 파일을 가리키면 받고, 폴더를 가리키는 링크는 직접 고른 경우만 들어간다 (순환 방지)
    const dirs: string[] = []
    const files: { remote: string; rel: string; size: number }[] = []
    const walk = async (
      remote: string,
      rel: string,
      attrs: SftpAttrs,
      top: boolean
    ): Promise<void> => {
      let kind = modeKind(attrs.mode)
      let size = attrs.size
      if (kind === 'link') {
        const st = await statP(s, remote).catch(() => null)
        if (!st) return // 깨진 링크
        kind = modeKind(st.mode)
        size = st.size
        if (kind === 'dir' && !top) return
      }
      if (kind === 'dir') {
        dirs.push(rel)
        for (const f of await readdirP(s, remote))
          await walk(
            posix.join(remote, f.filename),
            join(rel, safeLocalName(f.filename)),
            f.attrs,
            false
          )
      } else if (kind === 'file') {
        files.push({ remote, rel, size })
      }
    }
    for (const t of targets)
      await walk(t, safeLocalName(posix.basename(t) || 'root'), await statP(s, t, false), true)

    const tops = [...new Set(targets.map((t) => safeLocalName(posix.basename(t) || 'root')))]
    const conflicts: string[] = []
    for (const t of tops)
      if (
        await fsp.stat(join(dest, t)).then(
          () => true,
          () => false
        )
      )
        conflicts.push(t)
    if (conflicts.length > 0) {
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: t('sftp.conflict.title'),
        message: t('sftp.conflict.message', { dir: dest }),
        detail: conflictList(conflicts),
        buttons: [t('sftp.conflict.overwrite'), t('common.cancel')],
        defaultId: 1,
        cancelId: 1,
        signal: abort.signal
      }
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (ended()) return
      if (r.response !== 0) {
        progress({
          file: '',
          fileIndex: 0,
          fileCount: files.length,
          transferred: 0,
          total: 0,
          state: 'cancelled',
          kind: 'download',
          localDir: dest
        })
        return
      }
    }

    for (const d of dirs) await fsp.mkdir(join(dest, d), { recursive: true })
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      let last = 0
      await new Promise<void>((res, rej) =>
        s.fastGet(
          f.remote,
          join(dest, f.rel),
          {
            step: (transferred, _chunk, total) => {
              const now = Date.now()
              if (now - last < 100) return
              last = now
              progress({
                file: f.rel,
                fileIndex: i,
                fileCount: files.length,
                transferred,
                total,
                state: 'running',
                kind: 'download',
                localDir: dest
              })
            }
          },
          (err) => (err ? rej(sftpError(err, f.remote)) : res())
        )
      )
    }
    lastDownloadDir = dest
    const total = files.reduce((a, f) => a + f.size, 0)
    progress({
      file: files.at(-1)?.rel ?? '',
      fileIndex: files.length - 1,
      fileCount: files.length,
      transferred: total,
      total,
      state: 'done',
      kind: 'download',
      localDir: dest
    })
  }

  /** 전송 작업을 줄 세운다. 실패는 진행률 이벤트(error)로 알린다 */
  const enqueue = (kind: 'upload' | 'download', job: () => Promise<void>): Promise<void> => {
    // 연결이 끊기면 끝나지 않는 SFTP 대기가 체인을 붙잡지 않도록 alive 로 감싼다
    const run = transferChain.then(() => alive(job()))
    transferChain = run.catch((e: Error) => {
      progress({
        file: '',
        fileIndex: 0,
        fileCount: 0,
        transferred: 0,
        total: 0,
        state: 'error',
        kind,
        message: e.message
      })
    })
    return transferChain
  }

  /** 원격 폴더 목록. 링크는 대상을 stat 해서 폴더면 폴더로 보여준다 (열 수 있게) */
  const listDir = async (path?: string): Promise<Omit<RemoteListing, 'connId'>> => {
    await waitShell(t('ssh.notConnectedList'))
    const s = await getSftp()
    const home = await getHome()
    const dir = await realpath(s, normalizeRemotePath(path ?? '', home))
    const raw = await readdirP(s, dir)
    const entries: RemoteEntry[] = await Promise.all(
      raw
        .filter((f) => f.filename !== '.' && f.filename !== '..')
        .map(async (f) => {
          if (modeKind(f.attrs.mode) !== 'link') return toEntry(f.filename, f.attrs)
          const target = await new Promise<number | undefined>((res) =>
            s.stat(posix.join(dir, f.filename), (e, st) => res(e ? undefined : st.mode))
          )
          return toEntry(f.filename, f.attrs, target)
        })
    )
    return { path: dir, home, entries: sortEntries(entries) }
  }

  const doUpload = async (localPaths: string[], remoteDir?: string): Promise<void> => {
    if (!stream) throw new Error(t('ssh.notConnected'))
    const s = await getSftp()
    const home = await getHome()
    // 받는 폴더: 파일 브라우저에서 고른 곳, 없으면 home
    const target = await realpath(s, normalizeRemotePath(remoteDir ?? '', home))
    const isDir = await new Promise<boolean>((res, rej) =>
      s.stat(target, (e, st) => (e ? rej(sftpError(e, target)) : res(modeKind(st.mode) === 'dir')))
    )
    if (!isDir) throw new Error(t('sftp.notFolder', { path: target }))

    // 업로드 목록 만들기 (폴더는 재귀)
    const dirs: string[] = []
    const files: { local: string; rel: string; size: number }[] = []
    const walk = async (local: string, rel: string): Promise<void> => {
      const st = await fsp.stat(local)
      if (st.isDirectory()) {
        dirs.push(rel)
        for (const name of await fsp.readdir(local))
          await walk(join(local, name), posix.join(rel, name))
      } else if (st.isFile()) {
        files.push({ local, rel, size: st.size })
      }
    }
    for (const p of localPaths) await walk(p, basename(p))
    if (files.length === 0 && dirs.length === 0) return

    // 이미 있는 항목 확인
    const exists = (remote: string): Promise<boolean> =>
      new Promise((res) => s.stat(remote, (e) => res(!e)))
    const tops = [...new Set(localPaths.map((p) => basename(p)))]
    const conflicts: string[] = []
    for (const t of tops) if (await exists(posix.join(target, t))) conflicts.push(t)
    if (conflicts.length > 0) {
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: t('sftp.conflict.title'),
        message: t('sftp.conflict.message', { dir: target }),
        detail: conflictList(conflicts),
        buttons: [t('sftp.conflict.overwrite'), t('common.cancel')],
        defaultId: 1,
        cancelId: 1,
        signal: abort.signal
      }
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (ended()) return // 대화상자가 떠 있는 동안 탭이 닫힘
      if (r.response !== 0) {
        emit.progress({
          file: '',
          fileIndex: 0,
          fileCount: files.length,
          transferred: 0,
          total: 0,
          state: 'cancelled',
          remoteDir: target
        })
        return
      }
    }

    for (const d of dirs) {
      const rp = posix.join(target, d)
      await new Promise<void>((res, rej) =>
        s.mkdir(rp, (mkErr) => {
          if (!mkErr) return res()
          // 이미 있는 폴더면 통과. 그 밖(권한 없음 등)은 실패
          s.stat(rp, (e, st) =>
            !e && modeKind(st.mode) === 'dir' ? res() : rej(sftpError(mkErr, rp))
          )
        })
      )
    }

    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      let last = 0
      await new Promise<void>((res, rej) =>
        s.fastPut(
          f.local,
          posix.join(target, f.rel),
          {
            step: (transferred, _chunk, total) => {
              const now = Date.now()
              if (now - last < 100) return // 진행률 이벤트는 100ms 에 한 번
              last = now
              emit.progress({
                file: f.rel,
                fileIndex: i,
                fileCount: files.length,
                transferred,
                total,
                state: 'running',
                remoteDir: target
              })
            }
          },
          (err) => (err ? rej(sftpError(err, posix.join(target, f.rel))) : res())
        )
      )
    }
    const total = files.reduce((a, f) => a + f.size, 0)
    emit.progress({
      file: files.at(-1)?.rel ?? '',
      fileIndex: files.length - 1,
      fileCount: files.length,
      transferred: total,
      total,
      state: 'done',
      remoteDir: target
    })
  }

  // 렌더러가 termId 를 먼저 받은 뒤에 "접속 중..." 같은 출력이 가도록 한 틱 늦게 시작
  setImmediate(() => void start())

  return {
    write: (d) => {
      if (promptState) {
        // 접속 전 비밀번호 입력 처리 (에코 없음)
        for (const ch of d) {
          if (ch === '\r' || ch === '\n') {
            const p = promptState
            promptState = null
            emit.data('\r\n')
            p.resolve(p.buf)
            return
          } else if (ch === '\x7f' || ch === '\b') {
            promptState.buf = promptState.buf.slice(0, -1)
          } else if (ch === '\x03') {
            emit.data('^C\r\n')
            finish(0) // 사용자가 입력을 취소: 오류가 아니라 정상 종료
            return
          } else if (ch >= ' ') {
            promptState.buf += ch
          }
        }
        return
      }
      stream?.write(d)
    },
    resize: (c, r) => {
      size = { cols: c, rows: r }
      stream?.setWindow(r, c, 0, 0)
    },
    kill: () => finish(0), // 정상 종료(closed). cleanup 이 소켓/스트림/SFTP 를 모두 닫는다
    listDir: (path) => alive(listDir(path)),
    upload: (paths, remoteDir) => enqueue('upload', () => doUpload(paths, remoteDir)),
    download: (paths) => enqueue('download', () => doDownload(paths)),
    mkdir: (dir, name) => alive(mkdirRemote(dir, name)),
    rename: (dir, from, to) => alive(renameRemote(dir, from, to)),
    remove: (paths) => alive(removeRemote(paths)),
    openDownloads: async () => {
      if (!lastDownloadDir) throw new Error(t('sftp.noDownloadDir'))
      const err = await shell.openPath(lastDownloadDir)
      if (err) throw new Error(err)
    }
  }
}
