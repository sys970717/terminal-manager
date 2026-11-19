// 키 파일 존재 확인 단위 테스트. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkKeyFile } from '../keyCheck.ts'

const enoent = (): Promise<void> =>
  Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))

test('파일이 있으면 경고가 없다', async () => {
  assert.deepEqual(await checkKeyFile('C:\\keys\\a.pem', { access: () => Promise.resolve() }), [])
})

test('파일이 없으면 "키 파일을 찾을 수 없습니다: <파일 이름>" 경고', async () => {
  assert.deepEqual(await checkKeyFile('C:\\keys\\a.pem', { access: enoent }), [
    '키 파일을 찾을 수 없습니다: a.pem'
  ])
})

test('역슬래시 2개 또는 슬래시 2개로 시작하는 네트워크 경로는 확인하지 않는다', async () => {
  let called = 0
  const access = (): Promise<void> => {
    called++
    return enoent()
  }
  assert.deepEqual(await checkKeyFile('\\\\nas\\share\\a.pem', { access }), [])
  assert.deepEqual(await checkKeyFile('//nas/share/a.pem', { access }), [])
  assert.equal(called, 0)
})

test('access 가 시간 안에 끝나지 않으면 경고 없이 끝난다 (모의 지연)', async () => {
  const t0 = Date.now()
  const r = await checkKeyFile('C:\\keys\\a.pem', {
    access: () => new Promise<void>(() => {}), // 영원히 대기
    timeoutMs: 50
  })
  assert.deepEqual(r, [])
  assert.ok(Date.now() - t0 < 1000)
})

test('경고에는 파일 이름만 있고 전체 경로(폴더, 사용자 이름)는 없다', async () => {
  for (const p of ['C:\\Users\\me\\.ssh\\prod key.pem', '/home/me/.ssh/prod key.pem']) {
    const [w] = await checkKeyFile(p, { access: enoent })
    assert.equal(w, '키 파일을 찾을 수 없습니다: prod key.pem')
    assert.ok(!/Users|home|\.ssh|ys\.seo/.test(w))
  }
})

test('빈 경로나 ENOENT 이외의 오류(권한 등)는 경고하지 않는다', async () => {
  assert.deepEqual(await checkKeyFile('', { access: enoent }), [])
  assert.deepEqual(
    await checkKeyFile('C:\\a.pem', {
      access: () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' }))
    }),
    []
  )
})
