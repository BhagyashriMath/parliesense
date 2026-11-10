import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// SPA fallback: if 404.html redirected here, restore the original URL
(function () {
  const redirect = sessionStorage.getItem('spa_redirect');
  if (redirect && redirect !== '/') {
    sessionStorage.removeItem('spa_redirect');
    window.history.replaceState(null, '', redirect);
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
