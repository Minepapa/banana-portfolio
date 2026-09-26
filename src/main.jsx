import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './lib/ErrorBoundary.jsx'

try {
  const pref = localStorage.getItem('banana_theme_pref');
  if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
} catch { /* 프라이빗 모드 등 */ }

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
