import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installApiAuth } from './lib/apiAuth';
// Carbon Design System styles first; app/Tailwind styles override on top
import '@carbon/styles/css/styles.min.css';
import './index.css';
import { APP_NAME } from './config/brand';

document.title = APP_NAME;

installApiAuth();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
