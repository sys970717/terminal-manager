// Copyright (c) 2026 sys970717 — PolyForm Perimeter 1.0.0
import './assets/main.css'
import './assets/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initLang } from './i18n'

// 언어를 먼저 정한 뒤 그린다 (처음 화면이 다른 언어로 깜박이지 않게)
void initLang().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
)
