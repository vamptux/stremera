import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ThemeProvider } from './components/theme-provider';
import { PrivacyProvider } from './contexts/privacy-context';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 min default — prevents redundant refetches
      gcTime: 1000 * 60 * 30, // 30 min in-memory cache retention
      refetchOnWindowFocus: false, // Desktop app — no tab switching noise
      retry: 1, // One retry on transient failures
    },
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PrivacyProvider>
        <ThemeProvider defaultTheme='dark' storageKey='vite-ui-theme'>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </PrivacyProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
