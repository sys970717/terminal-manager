// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import { Fragment, type ReactNode } from 'react'

/**
 * 번역문의 "{name}" 자리에 JSX(예: <b>경로</b>)를 넣는다.
 * 언어마다 어순이 달라도 문장을 조각내지 않고 한 키로 번역할 수 있게 한다.
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part)
    return <Fragment key={i}>{m && m[1] in nodes ? nodes[m[1]] : part}</Fragment>
  })
}
