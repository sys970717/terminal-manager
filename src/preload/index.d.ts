// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import type { Api } from './index'

declare global {
  interface Window {
    api: Api
  }
}
