import React from 'react'
import { ko } from '../../core/i18n/ko'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error(ko.errors.rootMissing)

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
