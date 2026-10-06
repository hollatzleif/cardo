/**
 * Google OAuth "Web application" client of the Cardo Cloud project, used by
 * the iPhone web app to reach the same Drive appDataFolder as the desktop.
 * A web client id is public by design (it is visible in every page that uses
 * it); there is no client secret on this side. VITE_GDRIVE_WEB_CLIENT_ID
 * overrides it for local testing.
 */
export const GDRIVE_WEB_CLIENT_ID: string =
  (import.meta.env.VITE_GDRIVE_WEB_CLIENT_ID as string | undefined) ?? '';

export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export function oauthRedirectUri(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}oauth-callback.html`;
}

/** localStorage keys shared by the app and the callback page. */
export const OAUTH_PENDING_KEY = 'cardo-oauth-pending';
export const OAUTH_RESULT_KEY = 'cardo-oauth-result';
export const OAUTH_TOKEN_KEY = 'cardo-gdrive-token';
export const OAUTH_CHANNEL = 'cardo-oauth';
