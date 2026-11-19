// 세션 저장소 단위 테스트. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, type CryptoLike, type StoreOptions } from '../storeCore.ts'
import { DecryptError } from '../sshAuth.ts'
import type { SessionInfo, SessionInput } from '../../shared/types.ts'

/** 평문이 그대로 비치지 않는 가짜 DPAPI (XOR + 접두어) */
function fakeCrypto(available = true): CryptoLike {
  const xor = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x5a))
  return {
    isEncryptionAvailable: () => available,
    encryptString: (p) => Buffer.concat([Buffer.from('v10'), xor(Buffer.from(p, 'utf8'))]),
    decryptString: (enc) => {
      if (enc.subarray(0, 3).toString() !== 'v10')
        throw new Error(
          'Error while decrypting the ciphertext provided to safeStorage.decryptString.'
        )
      return xor(enc.subarray(3)).toString('utf8')
    }
  }
}

function tmpFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tm-store-'))
  return { dir, file: join(dir, 'sessions.json') }
}

const input = (over: Partial<SessionInput> = {}): SessionInput => ({
  name: '운영 서버',
  folderId: null,
  host: '10.0.0.5',
  port: 22,
  username: 'ubuntu',
  authType: 'password',
  password: 'S3cret-PW!',
  ...over
})

const quiet: Partial<StoreOptions> = { log: () => {} }

// ───────────── 저장 유지 + 평문 없음 ─────────────

test('저장한 세션은 새 인스턴스(앱 재시작)에서도 같은 값으로 읽힌다', async () => {
  const { dir, file } = tmpFile()
  const a = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  await a.saveSession(input({ name: 'A', host: 'a.example.com', port: 2222, username: 'root' }))
  await a.saveSession(
    input({
      name: 'B',
      authType: 'key',
      keyPath: 'C:\\keys\\b.pem',
      passphrase: 'PASS-phrase-1',
      password: undefined
    })
  )
  const b = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  const { sessions } = b.getTree()
  assert.equal(sessions.length, 2)
  const s1 = sessions.find((s) => s.name === 'A')!
  assert.deepEqual(
    [s1.host, s1.port, s1.username, s1.authType, s1.hasPassword],
    ['a.example.com', 2222, 'root', 'password', true]
  )
  const s2 = sessions.find((s) => s.name === 'B')!
  assert.deepEqual([s2.keyPath, s2.hasPassphrase, s2.hasPassword], ['C:\\keys\\b.pem', true, false])
  rmSync(dir, { recursive: true })
})

test('sessions.json 에 비밀번호/passphrase 원문이 0건이다 (base64 변환 후에도)', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  await st.saveSession(input({ password: 'S3cret-PW!', passphrase: 'PASS-phrase-1' }))
  const text = readFileSync(file, 'utf8')
  for (const secret of ['S3cret-PW!', 'PASS-phrase-1']) {
    assert.equal(text.includes(secret), false, `${secret} 평문 발견`)
    assert.equal(text.includes(Buffer.from(secret).toString('base64')), false)
  }
  assert.match(text, /encPassword/)
  rmSync(dir, { recursive: true })
})

test('getTree 응답에는 password/passphrase/암호문 필드가 없다', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  await st.saveSession(input({ passphrase: 'PASS-phrase-1' }))
  const json = JSON.stringify(st.getTree())
  for (const k of ['password', 'passphrase', 'encPassword', 'encPassphrase'])
    assert.equal(new RegExp(`"${k}" ?:`).test(json), false, `${k} 필드 노출`)
  assert.equal(json.includes('S3cret-PW!'), false)
  assert.equal(json.includes('PASS-phrase-1'), false)
  assert.match(json, /"hasPassword":true/)
  rmSync(dir, { recursive: true })
})

test('password/passphrase: undefined=유지, 빈 문자열=삭제, 값=교체', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  const saved = await st.saveSession(input({ passphrase: 'pp1' }))
  await st.saveSession(
    input({ id: saved.id, password: undefined, passphrase: undefined, name: '이름만 변경' })
  )
  assert.equal(st.getConnectInfo(saved.id).password, 'S3cret-PW!')
  assert.equal(st.getConnectInfo(saved.id).passphrase, 'pp1')
  await st.saveSession(input({ id: saved.id, password: '', passphrase: 'pp2' }))
  const ci = st.getConnectInfo(saved.id)
  assert.equal(ci.password, undefined)
  assert.equal(ci.passphrase, 'pp2')
  rmSync(dir, { recursive: true })
})

test('암호화를 쓸 수 없으면(encryptionAvailable=false) 비밀값 저장을 거부하고 평문으로 쓰지 않는다', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(false), ...quiet })
  assert.equal(st.getTree().encryptionAvailable, false)
  await assert.rejects(() => st.saveSession(input()), /DPAPI/)
  assert.equal(st.getTree().sessions.length, 0, '실패한 저장은 목록에 남지 않는다')
  assert.equal(existsSync(file), false, '파일도 만들어지지 않는다')
  // 비밀값이 없으면 저장 가능
  await st.saveSession(input({ authType: 'key', keyPath: 'k.pem', password: undefined }))
  assert.equal(st.getTree().sessions.length, 1)
  assert.equal(readFileSync(file, 'utf8').includes('S3cret'), false)
  rmSync(dir, { recursive: true })
})

test('손상된 암호문을 복호화하면 DecryptError(DECRYPT_FAILED)', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  const saved = await st.saveSession(input())
  st._peek().sessions[0].encPassword = Buffer.from('garbage-bytes').toString('base64')
  assert.throws(
    () => st.getConnectInfo(saved.id),
    (e: unknown) => e instanceof DecryptError && (e as DecryptError).code === 'DECRYPT_FAILED'
  )
  rmSync(dir, { recursive: true })
})

// ───────────── EPERM 재시도 + 롤백 ─────────────

test('rename 이 EPERM 을 계속 던지면 100ms 간격으로 정확히 3회 재시도하고, 목록은 저장 전 상태로 돌아가며 한국어 오류로 reject', async () => {
  const { dir, file } = tmpFile()
  let renameCalls = 0
  const sleeps: number[] = []
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    rename: async () => {
      renameCalls++
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })
  await assert.rejects(
    () => st.saveSession(input()),
    (e: Error) =>
      /세션 저장에 실패했습니다 \(EPERM\)/.test(e.message) && /반영되지 않았습니다/.test(e.message)
  )
  assert.equal(renameCalls, 4, '최초 1회 + 재시도 3회')
  assert.deepEqual(sleeps, [100, 100, 100])
  assert.equal(st.getTree().sessions.length, 0, '메모리 목록 롤백')
  assert.deepEqual(readdirSync(dir), [], '임시 파일(.tmp)이 남지 않는다')
  rmSync(dir, { recursive: true })
})

test('저장이 실패해도 기존 세션은 그대로 남는다 (수정/삭제 롤백)', async () => {
  const { dir, file } = tmpFile()
  let fail = false
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    rename: async (a, b) => {
      if (fail) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      const { promises } = await import('node:fs')
      await promises.rename(a, b)
    },
    sleep: async () => {}
  })
  const saved = await st.saveSession(input({ name: '원본' }))
  fail = true
  await assert.rejects(() => st.saveSession(input({ id: saved.id, name: '바뀐 이름' })))
  assert.equal(st.getTree().sessions[0].name, '원본')
  await assert.rejects(() => st.deleteSession(saved.id))
  assert.equal(st.getTree().sessions.length, 1)
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).sessions[0].name,
    '원본',
    '디스크 파일도 그대로'
  )
  rmSync(dir, { recursive: true })
})

test('EPERM 이 두 번 나고 세 번째에 성공하면 저장된다', async () => {
  const { dir, file } = tmpFile()
  let calls = 0
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    rename: async (a, b) => {
      if (++calls <= 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      const { promises } = await import('node:fs')
      await promises.rename(a, b)
    }
  })
  await st.saveSession(input({ password: undefined, authType: 'key', keyPath: 'k.pem' }))
  assert.equal(calls, 3)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 1)
  rmSync(dir, { recursive: true })
})

test('재시도 대기 중에도 main 이벤트 루프가 막히지 않는다 (async 대기)', async () => {
  const { dir, file } = tmpFile()
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    rename: async () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    }
    // sleep 은 기본(setTimeout 100ms × 3 = 약 300ms)
  })
  const t0 = Date.now()
  await assert.rejects(() => st.saveSession(input()))
  clearInterval(timer)
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 280, `실제로 약 300ms 대기해야 함 (${elapsed}ms)`)
  assert.ok(ticks >= 10, `대기 중 타이머가 계속 돌아야 함 (ticks=${ticks})`)
  rmSync(dir, { recursive: true })
})

test('EPERM 이 아닌 오류는 재시도 없이 바로 실패한다', async () => {
  const { dir, file } = tmpFile()
  let calls = 0
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    rename: async () => {
      calls++
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    },
    sleep: async () => assert.fail('재시도하면 안 됨')
  })
  await assert.rejects(() => st.saveSession(input()), /ENOSPC/)
  assert.equal(calls, 1)
  rmSync(dir, { recursive: true })
})

test('동시에 여러 번 저장해도 순서대로 처리되고 한 건이 실패해도 나머지에 영향이 없다', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  const results = await Promise.allSettled([
    st.saveSession(input({ name: '1', password: undefined, authType: 'key', keyPath: 'a' })),
    st.saveSession(input({ name: '' })), // 검증 실패
    st.saveSession(input({ name: '3', password: undefined, authType: 'key', keyPath: 'a' }))
  ])
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'rejected', 'fulfilled']
  )
  assert.deepEqual(
    st.getTree().sessions.map((s) => s.name),
    ['1', '3']
  )
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 2)
  rmSync(dir, { recursive: true })
})

// ───────────── 손상 파일 ─────────────

test('깨진 JSON: 빈 목록으로 시작하고 원본은 백업으로 남으며 알림은 1회만', () => {
  const { dir, file } = tmpFile()
  writeFileSync(file, '{ "version": 1, "sessions": [ {broken', 'utf8')
  const notices: unknown[] = []
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    now: () => 111,
    onCorrupt: (i) => notices.push(i)
  })
  assert.deepEqual(st.getTree().sessions, [])
  st.getTree()
  st.getTree() // 여러 번 읽어도 재로드/재알림 없음
  assert.equal(notices.length, 1)
  const backup = `${file}.broken-111`
  assert.equal(readFileSync(backup, 'utf8'), '{ "version": 1, "sessions": [ {broken')
  assert.equal(existsSync(file), false)
  assert.deepEqual(notices[0], {
    filePath: file,
    backupPath: backup,
    reason: (notices[0] as { reason: string }).reason
  })
  rmSync(dir, { recursive: true })
})

test('sessions 필드가 없는 파일도 빈 목록 + 백업', () => {
  for (const content of ['{"version":1,"folders":[]}', 'null', '[]', '{"sessions":"x"}']) {
    const { dir, file } = tmpFile()
    writeFileSync(file, content, 'utf8')
    const notices: unknown[] = []
    const st = createStore({
      filePath: file,
      crypto: fakeCrypto(),
      ...quiet,
      now: () => 7,
      onCorrupt: (i) => notices.push(i)
    })
    assert.deepEqual(st.getTree().sessions, [], content)
    assert.equal(notices.length, 1, content)
    assert.equal(readFileSync(`${file}.broken-7`, 'utf8'), content)
    rmSync(dir, { recursive: true })
  }
})

test('백업(rename/copy)이 모두 실패해도 예외 없이 빈 목록으로 시작하고, 알림은 백업 실패로 1회', () => {
  const { dir, file } = tmpFile()
  writeFileSync(file, 'not json', 'utf8')
  const notices: { backupPath?: string }[] = []
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    fs: {
      renameSync: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
      copyFileSync: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
    },
    onCorrupt: (i) => notices.push(i)
  })
  assert.doesNotThrow(() => st.getTree())
  assert.deepEqual(st.getTree().sessions, [])
  assert.equal(notices.length, 1)
  assert.equal(notices[0].backupPath, undefined)
  rmSync(dir, { recursive: true })
})

test('rename 백업이 막혀도 복사로 원본을 보존한다', () => {
  const { dir, file } = tmpFile()
  writeFileSync(file, 'not json', 'utf8')
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    now: () => 5,
    fs: {
      renameSync: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      }
    }
  })
  st.getTree()
  assert.equal(readFileSync(`${file}.broken-5`, 'utf8'), 'not json')
  rmSync(dir, { recursive: true })
})

test('알림 콜백이 예외를 던져도 앱은 계속 동작한다', () => {
  const { dir, file } = tmpFile()
  writeFileSync(file, '{', 'utf8')
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    onCorrupt: () => {
      throw new Error('dialog 실패')
    }
  })
  assert.deepEqual(st.getTree().sessions, [])
  rmSync(dir, { recursive: true })
})

test('손상 복구 후 새로 저장하면 정상 파일이 만들어진다', async () => {
  const { dir, file } = tmpFile()
  writeFileSync(file, '{', 'utf8')
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  await st.saveSession(input({ password: undefined, authType: 'key', keyPath: 'k' }))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 1)
  rmSync(dir, { recursive: true })
})

test('folders 가 없고 sessions 만 있는 파일은 손상이 아니다 (그대로 읽음)', () => {
  const { dir, file } = tmpFile()
  writeFileSync(file, JSON.stringify({ version: 1, sessions: [] }), 'utf8')
  const notices: unknown[] = []
  const st = createStore({
    filePath: file,
    crypto: fakeCrypto(),
    ...quiet,
    onCorrupt: (i) => notices.push(i)
  })
  assert.deepEqual(st.getTree().folders, [])
  assert.equal(notices.length, 0)
  rmSync(dir, { recursive: true })
})

// ───────────── 입력값 검증 ─────────────

test('입력값 검증: 한국어 오류로 reject 하고 아무것도 저장하지 않는다', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  const cases: [Partial<SessionInput>, RegExp][] = [
    [{ name: '  ' }, /이름은 필수/],
    [{ host: '' }, /호스트.*필수/],
    [{ host: 'bad host!' }, /호스트 형식/],
    [{ host: '999.1.1.1' }, /호스트 형식/],
    [{ host: '-bad.example.com' }, /호스트 형식/],
    [{ port: 0 }, /포트는 1~65535/],
    [{ port: 65536 }, /포트는 1~65535/],
    [{ port: 22.5 }, /포트는 1~65535/],
    [{ port: NaN }, /포트는 1~65535/],
    [{ port: '' as unknown as number }, /포트는 1~65535/],
    [{ username: '' }, /계정은 필수/],
    [{ authType: 'key', keyPath: '  ' }, /키 파일 경로/],
    [{ authType: 'key', keyPath: undefined }, /키 파일 경로/],
    [{ folderId: 'no-such-folder' }, /폴더를 찾을 수 없/]
  ]
  for (const [over, re] of cases) {
    await assert.rejects(() => st.saveSession(input(over)), re, JSON.stringify(over))
  }
  assert.equal(st.getTree().sessions.length, 0)
  assert.equal(existsSync(file), false)
  rmSync(dir, { recursive: true })
})

test('입력값 검증: 올바른 IP/도메인/포트 경계값은 통과한다', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  const hosts = [
    '10.0.0.5',
    '255.255.255.255',
    '::1',
    'fe80::1',
    'localhost',
    'my-server',
    'a.b.example.co.kr',
    'ec2-1-2-3-4.compute.amazonaws.com',
    'host_1.internal'
  ]
  for (const host of hosts) await st.saveSession(input({ host, password: undefined }))
  await st.saveSession(input({ port: 1, password: undefined }))
  await st.saveSession(input({ port: 65535, password: undefined }))
  await st.saveSession(input({ port: '2222' as unknown as number, password: undefined }))
  assert.equal(st.getTree().sessions.length, hosts.length + 3)
  assert.equal(st.getTree().sessions.at(-1)!.port, 2222)
  rmSync(dir, { recursive: true })
})

// ───────────── 30개 이상 ─────────────

test('세션이 100개여도 모두 저장/조회된다', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  for (let i = 0; i < 100; i++)
    await st.saveSession(
      input({
        name: `서버-${i}`,
        host: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`,
        password: undefined,
        authType: 'key',
        keyPath: 'k.pem'
      })
    )
  assert.equal(
    createStore({ filePath: file, crypto: fakeCrypto(), ...quiet }).getTree().sessions.length,
    100
  )
  rmSync(dir, { recursive: true })
})

test('세션 500개를 저장하고 새 인스턴스로 불러오면 모두 같은 값이고 비밀 원문은 0건이다', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  const saved: SessionInfo[] = []
  for (let i = 0; i < 500; i++) {
    const useKey = i % 2 === 0
    saved.push(
      await st.saveSession(
        input({
          name: `서버-${i}`,
          host: `10.${Math.floor(i / 250)}.${Math.floor((i % 250) / 50)}.${(i % 50) + 1}`,
          port: 2200 + (i % 100),
          username: `user${i}`,
          authType: useKey ? 'key' : 'password',
          keyPath: useKey ? `C:\\keys\\key-${i}.pem` : undefined,
          password: useKey ? undefined : `PW-secret-${i}`,
          passphrase: useKey ? `PP-secret-${i}` : undefined
        })
      )
    )
  }
  assert.equal(new Set(saved.map((s) => s.id)).size, 500) // id 중복 없음

  // 새 인스턴스 = 앱 재시작
  const loaded = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet }).getTree().sessions
  assert.equal(loaded.length, 500)
  const pick = (s: (typeof loaded)[number]): unknown => ({
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    authType: s.authType,
    keyPath: s.keyPath
  })
  const byId = new Map(loaded.map((s) => [s.id, s]))
  for (const s of saved) assert.deepEqual(pick(byId.get(s.id)!), pick(s))

  // 파일에 비밀 원문 0건 (비밀번호/passphrase 모두)
  const raw = readFileSync(file, 'utf8')
  assert.equal((raw.match(/PW-secret-|PP-secret-/g) ?? []).length, 0)
  rmSync(dir, { recursive: true })
})

// ───────────── 폴더 회귀 ─────────────

test('폴더 삭제 시 안의 세션은 상위로 올라가고 사라지지 않는다', async () => {
  const { dir, file } = tmpFile()
  const st = createStore({ filePath: file, crypto: fakeCrypto(), ...quiet })
  const parent = await st.saveFolder({ name: '상위', parentId: null })
  const child = await st.saveFolder({ name: '하위', parentId: parent.id })
  const s = await st.saveSession(
    input({ folderId: child.id, password: undefined, authType: 'key', keyPath: 'k' })
  )
  await st.deleteFolder(child.id)
  assert.equal(st.getTree().sessions.find((x) => x.id === s.id)!.folderId, parent.id)
  rmSync(dir, { recursive: true })
})
