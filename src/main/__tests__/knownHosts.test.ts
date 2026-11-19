// known_hosts 저장소 단위 테스트. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createKnownHosts,
  fingerprintsLostMessage,
  saveFailedMessage,
  type KnownHostsFs
} from '../knownHosts.ts'

const FILE = '/data/known_hosts.json'

/** 메모리 위의 가짜 파일 시스템 */
function memFs(initial: Record<string, string> = {}): {
  files: Map<string, string>
  fs: Partial<KnownHostsFs>
  renames: [string, string][]
} {
  const files = new Map(Object.entries(initial))
  const renames: [string, string][] = []
  return {
    files,
    renames,
    fs: {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => {
        if (!files.has(p)) throw new Error('ENOENT')
        return files.get(p)!
      },
      writeFileSync: (p, d) => void files.set(p, d),
      renameSync: (a, b) => {
        files.set(b, files.get(a)!)
        files.delete(a)
        renames.push([a, b])
      },
      mkdirSync: () => {},
      unlinkSync: (p) => void files.delete(p)
    }
  }
}

const eperm = (): Error =>
  Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

test('테스트 1: tmp 파일에 쓴 뒤 rename 으로 교체하고, 실패해도 최대 3회까지 다시 시도한다', async () => {
  const m = memFs({ [FILE]: JSON.stringify({ '[a]:22': 'SHA256:old' }) })
  let calls = 0
  const sleeps: number[] = []
  const kh = createKnownHosts({
    filePath: FILE,
    fs: m.fs,
    rename: async (a, b) => {
      calls++
      assert.match(a, /known_hosts\.json\.tmp-/) // 원본이 아니라 tmp 에서 교체
      assert.equal(b, FILE)
      if (calls < 3) throw eperm() // 2번 실패 후 3번째 성공
      m.fs.renameSync!(a, b)
    },
    sleep: async (ms) => void sleeps.push(ms),
    log: () => {}
  })
  const notices: string[] = []
  assert.equal(await kh.save('[b]:22', 'SHA256:new', (s) => notices.push(s)), true)
  assert.equal(calls, 3)
  assert.equal(sleeps.length, 2)
  assert.deepEqual(notices, []) // 성공하면 안내 없음
  assert.deepEqual(JSON.parse(m.files.get(FILE)!), {
    '[a]:22': 'SHA256:old',
    '[b]:22': 'SHA256:new'
  })
  assert.deepEqual([...m.files.keys()], [FILE]) // tmp 파일이 남지 않음
})

test('테스트 2: 3회 모두 실패해도 예외 없이 끝나고 "지문을 저장하지 못했습니다" 만 안내한다', async () => {
  const m = memFs({ [FILE]: JSON.stringify({ '[a]:22': 'SHA256:old' }) })
  let calls = 0
  const kh = createKnownHosts({
    filePath: FILE,
    fs: m.fs,
    rename: async () => {
      calls++
      throw eperm()
    },
    sleep: async () => {},
    log: () => {}
  })
  const notices: string[] = []
  const ok = await kh.save('[b]:22', 'SHA256:new', (s) => notices.push(s))
  assert.equal(ok, false)
  assert.equal(calls, 3) // 4번째 시도 없음
  assert.deepEqual(notices, ['지문을 저장하지 못했습니다'])
  assert.equal(saveFailedMessage(), '지문을 저장하지 못했습니다')
  // 기존 파일은 그대로, tmp 는 정리됨
  assert.deepEqual(JSON.parse(m.files.get(FILE)!), { '[a]:22': 'SHA256:old' })
  assert.deepEqual([...m.files.keys()], [FILE])
})

test('테스트 3: 깨진 파일은 .corrupt-<Date.now()> 로 rename 되고, 이후 안내문이 계속 붙는다', () => {
  const m = memFs({ [FILE]: '{ 깨진 json' })
  const kh = createKnownHosts({
    filePath: FILE,
    fs: m.fs,
    now: () => 1700000000000,
    log: () => {}
  })
  assert.equal(kh.lostNotice(), undefined) // 손상 전에는 안내 없음
  assert.deepEqual(kh.load(), {})
  assert.deepEqual(m.renames, [[FILE, `${FILE}.corrupt-1700000000000`]])
  assert.equal(m.files.get(`${FILE}.corrupt-1700000000000`), '{ 깨진 json') // 원본 보존
  assert.equal(m.files.has(FILE), false)
  // "처음 접속" 대화상자마다 같은 문구 (여러 번 물어도 유지)
  for (let i = 0; i < 3; i++) {
    assert.equal(kh.lostNotice(), '이전 지문이 없어져 이번 지문은 검증할 수 없습니다')
  }
  assert.equal(fingerprintsLostMessage(), '이전 지문이 없어져 이번 지문은 검증할 수 없습니다')
})

test('손상 백업 rename 이 실패해도 예외 없이 빈 목록과 안내문으로 계속된다', () => {
  const m = memFs({ [FILE]: '[]' }) // 배열도 형식 오류로 취급
  m.fs.renameSync = () => {
    throw eperm()
  }
  const kh = createKnownHosts({ filePath: FILE, fs: m.fs, log: () => {} })
  assert.deepEqual(kh.load(), {})
  assert.equal(kh.lostNotice(), fingerprintsLostMessage())
})

test('파일이 없으면 빈 목록이고 안내문도 없다 (처음 실행은 손상이 아니다)', () => {
  const kh = createKnownHosts({ filePath: FILE, fs: memFs().fs, log: () => {} })
  assert.deepEqual(kh.load(), {})
  assert.equal(kh.lostNotice(), undefined)
})
