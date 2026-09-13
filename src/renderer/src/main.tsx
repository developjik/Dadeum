import React from 'react'
import { createRoot } from 'react-dom/client'
import { ko } from '../../core/i18n/ko'
import { App } from './App'
import { initTheme } from './themes/theme'
import './styles/global.css'

// React 렌더 전에 저장된 테마를 DOM에 반영한다(첫 페인트부터 올바른 테마).
initTheme()

const container = document.getElementById('root')
if (!container) throw new Error(ko.errors.rootMissing)

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
