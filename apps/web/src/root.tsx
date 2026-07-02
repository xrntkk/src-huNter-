import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { ThemeProvider } from './contexts/theme-context.js'
import { routes } from './routes.js'
import './styles/globals.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000 } },
})

const router = createBrowserRouter(routes)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
