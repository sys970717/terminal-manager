// main 프로세스 번역 사전/언어 전환 단위 테스트. 실행: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ko } from '../locales/ko.ts'
import { en } from '../locales/en.ts'
import { getLang, setLang, t } from '../i18n.ts'
import { pickLang } from '../../shared/i18n.ts'
import { classifySshError } from '../sshAuth.ts'
import { validateSessionInput } from '../validate.ts'
import { sftpError, validName } from '../sftpUtil.ts'
import { checkKeyFile } from '../keyCheck.ts'
import type { SessionInput } from '../../shared/types.ts'

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

/** 영어로 바꿔 fn 을 실행하고, 끝나면 항상 ko 로 되돌린다 */
async function inEnglish(fn: () => void | Promise<void>): Promise<void> {
  setLang('en')
  try {
    await fn()
  } finally {
    setLang('ko')
  }
}

test('en 사전은 ko 와 키가 정확히 같다', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort())
})

test('각 키의 {placeholder} 는 ko/en 양쪽에 똑같이 있다', () => {
  for (const k of Object.keys(ko) as (keyof typeof ko)[]) {
    assert.deepEqual(placeholders(en[k]), placeholders(ko[k]), `${k} 의 자리표시자가 다름`)
  }
})

test('빈 문구가 없다', () => {
  for (const [k, v] of [...Object.entries(ko), ...Object.entries(en)])
    assert.ok(v.trim().length > 0, `${k} 가 비어 있음`)
})

test('기본 언어는 ko', () => {
  assert.equal(getLang(), 'ko')
  assert.equal(t('sftp.permissionDenied', { path: '/root' }), '권한 없음: /root')
})

test("setLang('en') 이면 main 함수가 영어 문구를 만들고, 되돌리면 다시 한국어", async () => {
  const input = {
    name: 'x',
    host: 'bad host!',
    port: 22,
    username: 'u',
    authType: 'password'
  } as SessionInput
  await inEnglish(async () => {
    assert.equal(getLang(), 'en')
    assert.match(
      classifySshError({ level: 'client-authentication' }).message,
      /^Authentication failed/
    )
    assert.match(validateSessionInput(input) ?? '', /^Invalid host format: "bad host!"/)
    assert.equal(sftpError({ code: 3 }, '/root').message, 'Permission denied: /root')
    assert.throws(() => validName('..'), /^Error: Invalid name: \.\.$/)
    const enoent = Object.assign(new Error('x'), { code: 'ENOENT' })
    const w = await checkKeyFile('C:\\keys\\a.pem', { access: () => Promise.reject(enoent) })
    assert.deepEqual(w, ['Key file not found: a.pem'])
    // 기술 용어는 영어에서도 그대로
    const ppk = classifySshError(new Error('Unsupported key format'), { keyPath: 'x.ppk' })
    assert.match(ppk.message, /PuTTYgen.*OpenSSH/)
    assert.match(ppk.message, /\.pem/)
  })
  assert.equal(getLang(), 'ko')
  assert.match(classifySshError({ level: 'client-authentication' }).message, /^인증에 실패했습니다/)
})

test('문구는 부를 때 번역된다 (실행 중 언어 전환이 바로 반영)', async () => {
  const before = sftpError({ code: 2 }, '/x').message
  await inEnglish(() => {
    assert.equal(sftpError({ code: 2 }, '/x').message, 'No such file or folder: /x')
  })
  assert.equal(before, '없는 경로: /x')
  assert.equal(sftpError({ code: 2 }, '/x').message, '없는 경로: /x')
})

test('pickLang: 한국어 OS 는 ko, 그 밖에는 en', () => {
  assert.equal(pickLang(['ko-KR']), 'ko')
  assert.equal(pickLang(['en-US']), 'en')
  assert.equal(pickLang([]), 'en')
})
