import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import App from './App'
import { ToastProvider } from './components/ui'
import './styles.css'

// A data router (routes themselves live in App) so pages can ask before the user navigates away.
const router = createBrowserRouter([{ path: '*', element: <ToastProvider><App /></ToastProvider> }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
