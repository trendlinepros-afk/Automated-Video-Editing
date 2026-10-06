import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

async function boot() {
  // Browser review only (`vite` without Electron): a fake window.api with sample data.
  // In the app the preload script always provides window.api, and production builds drop this branch.
  if (import.meta.env.DEV && !(window as { api?: unknown }).api) {
    const { installMockApi } = await import('./dev/mockApi')
    installMockApi()
  }
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void boot()
