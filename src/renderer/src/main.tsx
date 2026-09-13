import React from 'react'
import { createRoot } from 'react-dom/client'
import { ko } from '../../core/i18n/ko'
import { App } from './App'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) throw new Error(ko.errors.rootMissing)

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
