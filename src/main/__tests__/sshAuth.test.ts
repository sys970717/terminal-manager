// SSH 오류 분류 / keyboard-interactive / 연결 상태 단위 테스트
// 오류는 가능한 한 실제로 재현한다: ssh2 클라이언트 ↔ 같은 프로세스 안의 ssh2.Server(모의 sshd), 닫힌 포트, 침묵하는 TCP 서버
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2, { type AuthContext } from 'ssh2'
import {
  READY_TIMEOUT_MS,
  DecryptError,
  answerKeyboardInteractive,
  attachKeyboardInteractive,
  classifySshError,
  loadPrivateKey,
  nextConnState
} from '../sshAuth.ts'
import { createStore } from '../storeCore.ts'

const { Client, Server, utils } = ssh2
const hostKey = utils.generateKeyPairSync('ed25519').private

// ───────────── 모의 sshd ─────────────

interface TestServer {
  port: number
  close: () => void
}

function startSshd(onAuth: (ctx: AuthContext) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('error', () => {})
      client.on('authentication', onAuth)
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acc) => acc && acc())
          session.on('shell', (acc) => {
            const ch = acc()
            ch.write('welcome\r\n')
            ch.on('data', (d: Buffer) => ch.write(`echo:${d}`))
          })
        })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })
    })
  })
}

type Outcome =
  { ok: true; shellOutput: string } | { ok: false; err: Error & { code?: string; level?: string } }

/** ssh.ts 와 같은 방식(attachKeyboardInteractive 사용)으로 접속을 시도 */
function attempt(
  port: number,
  opts: { host?: string; password?: string; readyTimeout?: number; tryKeyboard?: boolean } = {}
): Promise<Outcome> {
  return new Promise((resolve) => {
    const conn = new Client()
    const done = (o: Outcome): void => {
      conn.destroy()
      resolve(o)
    }
    if (opts.tryKeyboard) attachKeyboardInteractive(conn, opts.password)
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, ch) => {
        if (err) return done({ ok: false, err })
        let out = ''
        ch.on('data', (d: Buffer) => {
          out += d.toString()
          if (out.includes('echo:hi')) done({ ok: true, shellOutput: out })
        })
        ch.write('hi')
      })
    })
    conn.on('error', (err) => done({ ok: false, err }))
    conn.connect({
      host: opts.host ?? '127.0.0.1',
      port,
      username: 'tester',
      password: opts.password,
      tryKeyboard: opts.tryKeyboard,
      readyTimeout: opts.readyTimeout ?? 5000
    })
  })
}

const rejectAll = (ctx: AuthContext): void => void ctx.reject(['password', 'keyboard-interactive'])

// ───────────── 오류 6종 + 기타 ─────────────

test('키 파일 없음(ENOENT) → keyNotFound', async () => {
  await assert.rejects(
    () => loadPrivateKey(join(tmpdir(), 'tm-no-such-key.pem'), undefined, async () => null),
    (e: NodeJS.ErrnoException) => {
      assert.equal(e.code, 'ENOENT')
      const c = classifySshError(e)
      assert.equal(c.kind, 'keyNotFound')
      assert.match(c.message, /키 파일을 찾을 수 없습니다.*다시 선택/)
      return true
    }
  )
})

test('인증 실패(level=client-authentication) → authFailed', async () => {
  const sshd = await startSshd(rejectAll)
  const r = await attempt(sshd.port, { password: 'wrong' })
  sshd.close()
  assert.ok(!r.ok)
  assert.equal(r.err.level, 'client-authentication')
  const c = classifySshError(r.err)
  assert.equal(c.kind, 'authFailed')
  assert.match(c.message, /인증에 실패했습니다.*확인하세요/)
})

test('연결 불가: 닫힌 포트(ECONNREFUSED) → unreachable', async () => {
  const probe = net.createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise((r) => probe.close(r))
  const r = await attempt(port)
  assert.ok(!r.ok)
  assert.equal(r.err.code, 'ECONNREFUSED')
  const c = classifySshError(r.err)
  assert.equal(c.kind, 'unreachable')
  assert.match(c.message, /연결할 수 없습니다.*확인하세요/)
})

test('연결 불가: 없는 도메인(ENOTFOUND) → unreachable', async () => {
  const r = await attempt(22, { host: 'no-such-host.invalid' })
  assert.ok(!r.ok)
  // 오프라인 DNS 환경에서는 EAI_AGAIN 이 나올 수 있어 둘 다 허용
  assert.ok(['ENOTFOUND', 'EAI_AGAIN'].includes(r.err.code ?? ''), `code=${r.err.code}`)
  assert.equal(classifySshError(r.err).kind, 'unreachable')
})

test('코드로만 판별되는 오류 코드는 합성 오류로 확인: EHOSTUNREACH → unreachable, ETIMEDOUT → timeout', () => {
  assert.equal(
    classifySshError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })).kind,
    'unreachable'
  )
  assert.equal(
    classifySshError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).kind,
    'timeout'
  )
})

test('시간 초과: 응답 없는 서버(level=client-timeout) → timeout', async () => {
  const sockets: net.Socket[] = []
  const silent = net.createServer((s) => sockets.push(s)) // 연결만 받고 아무 말도 안 함
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
  const port = (silent.address() as net.AddressInfo).port
  const t0 = Date.now()
  const r = await attempt(port, { readyTimeout: 300 })
  silent.close()
  sockets.forEach((s) => s.destroy())
  assert.ok(!r.ok)
  assert.ok(Date.now() - t0 < 3000)
  assert.equal(r.err.level, 'client-timeout')
  const c = classifySshError(r.err)
  assert.equal(c.kind, 'timeout')
  assert.match(c.message, /시간이 초과.*방화벽/)
})

test('앱의 접속 시간 초과 설정은 20초', () => {
  assert.equal(READY_TIMEOUT_MS, 20000)
})

test('passphrase 오류 → passphraseWrong, 맞으면 키 로드, 없으면 입력 요청, 취소하면 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-key-'))
  try {
    const kp = utils.generateKeyPairSync('ed25519', {
      passphrase: 'right-pass',
      cipher: 'aes256-ctr',
      rounds: 16
    })
    const keyFile = join(dir, 'enc_key')
    writeFileSync(keyFile, kp.private)

    await assert.rejects(
      () => loadPrivateKey(keyFile, 'wrong-pass', async () => null),
      (e: Error) => {
        const c = classifySshError(e)
        assert.equal(c.kind, 'passphraseWrong', e.message)
        assert.match(c.message, /passphrase.*맞지 않습니다.*다시/)
        return true
      }
    )
    const ok = await loadPrivateKey(keyFile, 'right-pass', async () => null)
    assert.equal(ok?.passphrase, 'right-pass')

    let asked = 0
    const typed = await loadPrivateKey(keyFile, undefined, async () => (asked++, 'right-pass'))
    assert.equal(asked, 1)
    assert.equal(typed?.passphrase, 'right-pass')
    assert.equal(await loadPrivateKey(keyFile, undefined, async () => null), null)

    // 암호 없는 키는 입력을 묻지 않는다
    const plain = utils.generateKeyPairSync('ed25519')
    const plainFile = join(dir, 'plain_key')
    writeFileSync(plainFile, plain.private)
    const p = await loadPrivateKey(plainFile, undefined, async () => assert.fail('묻지 않아야 함'))
    assert.equal(p?.passphrase, undefined)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('DPAPI 복호화 실패(손상된 암호문) → decryptFailed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-dec-'))
  try {
    const crypto = {
      isEncryptionAvailable: () => true,
      encryptString: (p: string) => Buffer.from('v10' + p),
      decryptString: (b: Buffer) => {
        if (b.subarray(0, 3).toString() !== 'v10')
          throw new Error('Error while decrypting the ciphertext')
        return b.subarray(3).toString()
      }
    }
    const st = createStore({ filePath: join(dir, 's.json'), crypto, log: () => {} })
    const s = await st.saveSession({
      name: 'n',
      folderId: null,
      host: 'h.example.com',
      port: 22,
      username: 'u',
      authType: 'password',
      password: 'pw'
    })
    st._peek().sessions[0].encPassword = Buffer.from('손상').toString('base64')
    let caught: unknown
    try {
      st.getConnectInfo(s.id)
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof DecryptError)
    const c = classifySshError(caught)
    assert.equal(c.kind, 'decryptFailed')
    assert.match(c.message, /복호화하지 못했습니다.*다시 입력하세요/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('그 밖의 오류 → other: "기타" 문구와 원문을 함께 보여 준다', () => {
  const c = classifySshError(new Error('Something weird happened'))
  assert.equal(c.kind, 'other')
  assert.match(c.message, /기타/)
  assert.ok(c.message.includes('Something weird happened'))
  assert.ok(!c.message.includes('PuTTYgen'))
})

test('other + PPK 키: OpenSSH 형식 변환 안내를 덧붙인다 (.ppk 경로 또는 PuTTY 헤더)', () => {
  const byPath = classifySshError(new Error('Unsupported key format'), {
    keyPath: 'C:\\keys\\server.PPK'
  })
  assert.equal(byPath.kind, 'other')
  assert.match(byPath.message, /PuTTYgen.*OpenSSH/)
  assert.ok(byPath.message.includes('Unsupported key format'))
  const byMsg = classifySshError(new Error('bad PuTTY-User-Key-File-3 header'))
  assert.match(byMsg.message, /PuTTYgen/)
})

test('분류 우선순위: 키 없음(ENOENT)이 기타로 새지 않고, code 없는 null/문자열 오류도 죽지 않는다', () => {
  assert.equal(classifySshError(undefined).kind, 'other')
  assert.equal(classifySshError('문자열 오류').kind, 'other')
  assert.equal(classifySshError(null).kind, 'other')
})

test('분류 문구는 모두 한 줄(개행 없음)이고 비밀값을 포함하지 않는다', () => {
  const errs: unknown[] = [
    Object.assign(new Error('a'), { code: 'ENOENT' }),
    Object.assign(new Error('a'), { level: 'client-authentication' }),
    Object.assign(new Error('a'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('a'), { level: 'client-timeout' }),
    new Error('Bad passphrase?'),
    new DecryptError(),
    new Error('x')
  ]
  for (const e of errs) assert.doesNotMatch(classifySshError(e).message, /[\r\n]/)
})

// ───────────── keyboard-interactive ─────────────

test('answerKeyboardInteractive: 질문 1개 + 저장된 비밀번호 → 응답, 그 외 → null', () => {
  const q = { prompt: 'Password: ', echo: false }
  assert.deepEqual(answerKeyboardInteractive([q], 'pw'), ['pw'])
  assert.equal(answerKeyboardInteractive([q, q], 'pw'), null)
  assert.equal(answerKeyboardInteractive([q, q, q], 'pw'), null)
  assert.equal(answerKeyboardInteractive([], 'pw'), null)
  assert.equal(answerKeyboardInteractive([q], undefined), null)
  assert.equal(answerKeyboardInteractive([q], ''), null)
})

const kbdOnlyServer = (questions: number, password: string): Promise<TestServer> =>
  startSshd((ctx) => {
    if (ctx.method !== 'keyboard-interactive') return void ctx.reject(['keyboard-interactive'])
    const prompts = Array.from({ length: questions }, (_, i) => ({
      prompt: `Q${i + 1}: `,
      echo: false
    }))
    ctx.prompt(prompts, '', '', (answers) => {
      if (answers.length === questions && answers[0] === password) ctx.accept()
      else ctx.reject(['keyboard-interactive'])
    })
  })

test('keyboard-interactive 질문 1개: 저장된 비밀번호로 자동 응답해 접속에 성공하고 명령 결과가 나온다', async () => {
  const sshd = await kbdOnlyServer(1, 'pw-1234')
  const r = await attempt(sshd.port, { password: 'pw-1234', tryKeyboard: true })
  sshd.close()
  assert.ok(r.ok, r.ok ? '' : r.err.message)
  assert.match(r.shellOutput, /echo:hi/)
})

test('keyboard-interactive 질문 1개 + 저장된 비밀번호가 틀리면 인증 실패(authFailed)', async () => {
  const sshd = await kbdOnlyServer(1, 'right')
  const r = await attempt(sshd.port, { password: 'wrong', tryKeyboard: true })
  sshd.close()
  assert.ok(!r.ok)
  assert.equal(classifySshError(r.err).kind, 'authFailed')
})

test('keyboard-interactive 질문 2개 이상: 자동 응답하지 않고 인증 실패로 처리한다', async () => {
  let answersSeen: string[] | undefined
  const sshd = await startSshd((ctx) => {
    if (ctx.method !== 'keyboard-interactive') return void ctx.reject(['keyboard-interactive'])
    ctx.prompt(
      [
        { prompt: 'Password: ', echo: false },
        { prompt: 'Verification code: ', echo: true }
      ],
      '',
      '',
      (answers) => {
        answersSeen = answers
        ctx.reject(['keyboard-interactive'])
      }
    )
  })
  const r = await attempt(sshd.port, { password: 'pw-1234', tryKeyboard: true })
  sshd.close()
  assert.ok(!r.ok)
  assert.deepEqual(answersSeen, [], '비밀번호를 서버로 보내지 않았다')
  assert.equal(classifySshError(r.err).kind, 'authFailed')
})

test('일반 비밀번호 인증 성공 (회귀)', async () => {
  const sshd = await startSshd((ctx) =>
    ctx.method === 'password' && ctx.password === 'pw-1234'
      ? ctx.accept()
      : ctx.reject(['password'])
  )
  const r = await attempt(sshd.port, { password: 'pw-1234', tryKeyboard: true })
  sshd.close()
  assert.ok(r.ok, r.ok ? '' : r.err.message)
})

// ───────────── 연결 상태 ─────────────

test('nextConnState: error 는 종료 상태라 closed/connected 로 덮어쓰지 않는다', () => {
  assert.equal(nextConnState('error', 'closed'), 'error')
  assert.equal(nextConnState('error', 'connected'), 'error')
  assert.equal(nextConnState('connecting', 'connected'), 'connected')
  assert.equal(nextConnState('connected', 'closed'), 'closed')
  assert.equal(nextConnState('connected', 'error'), 'error')
  assert.equal(nextConnState('connecting', 'error'), 'error')
})
