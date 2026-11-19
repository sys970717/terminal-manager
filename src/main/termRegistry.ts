// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
/**
 * 터미널 레지스트리 (순수 로직). terms.ts 가 electron/node-pty 와 엮어서 쓴다.
 * - 같은 id 를 몇 번 kill/remove 해도 안전하다(멱등).
 * - 소유자(창)가 사라지거나 리로드되면 그 소유자의 터미널만 골라서 정리한다.
 */
export interface Killable {
  kill(): void
}

export interface TermRegistry<B extends Killable, O extends object> {
  add(id: number, owner: O, backend: B): void
  get(id: number): B | undefined
  /** 레지스트리에서만 제거 (kill 은 하지 않음). 이미 없으면 false */
  remove(id: number): boolean
  /** 제거 후 backend.kill(). 이미 없으면 아무것도 하지 않는다 */
  kill(id: number): void
  killOwner(owner: O): void
  killAll(): void
  readonly size: number
  readonly ownerSize: number
}

export function createTermRegistry<B extends Killable, O extends object>(): TermRegistry<B, O> {
  const terms = new Map<number, B>()
  const owners = new Map<number, O>()

  const remove = (id: number): boolean => {
    owners.delete(id)
    return terms.delete(id)
  }

  const kill = (id: number): void => {
    const t = terms.get(id)
    if (!t) return
    remove(id)
    try {
      t.kill()
    } catch {
      // 이미 종료됨
    }
  }

  return {
    add(id, owner, backend) {
      terms.set(id, backend)
      owners.set(id, owner)
    },
    get: (id) => terms.get(id),
    remove,
    kill,
    killOwner(owner) {
      for (const [id, o] of [...owners]) if (o === owner) kill(id)
    },
    killAll() {
      for (const id of [...terms.keys()]) kill(id)
    },
    get size() {
      return terms.size
    },
    get ownerSize() {
      return owners.size
    }
  }
}
