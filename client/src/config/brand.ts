/**
 * Product name shown in the UI (sidebar, login, browser tab).
 * Default is the open-source name "IntegrationX"; internal deployments set
 * VITE_APP_NAME / VITE_APP_TAGLINE at build time (e.g. DEH / Data Exchange Hub).
 */
export const APP_NAME: string = import.meta.env.VITE_APP_NAME || 'IntegrationX';
export const APP_TAGLINE: string =
  import.meta.env.VITE_APP_TAGLINE ?? (import.meta.env.VITE_APP_NAME ? '' : 'Integration Platform');
