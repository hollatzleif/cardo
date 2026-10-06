/**
 * Pure parsing/validation of Google's implicit-flow redirect fragment
 * (#access_token=…&expires_in=…&state=…&scope=…). Shared by the callback
 * page and the app; unit-tested.
 */

export interface OAuthResult {
  state: string;
  accessToken?: string;
  expiresIn?: number;
  scope?: string;
  error?: string;
}

export interface StoredToken {
  accessToken: string;
  /** Epoch ms after which the token must not be used. */
  expiresAt: number;
}

export function parseFragment(hash: string): OAuthResult {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const expires = Number(params.get('expires_in'));
  return {
    state: params.get('state') ?? '',
    accessToken: params.get('access_token') ?? undefined,
    expiresIn: Number.isFinite(expires) && expires > 0 ? expires : undefined,
    scope: params.get('scope') ?? undefined,
    error: params.get('error') ?? undefined,
  };
}

/**
 * Validates a result against the state we sent and the scope we need.
 * Returns the token to store, or an error code.
 */
export function acceptResult(
  result: OAuthResult,
  expectedState: string,
  requiredScope: string,
  nowMs: number,
): { token: StoredToken } | { error: string } {
  if (!expectedState || result.state !== expectedState) return { error: 'state_mismatch' };
  if (result.error) return { error: result.error };
  if (!result.accessToken) return { error: 'no_token' };
  const scopes = (result.scope ?? '').split(/\s+/);
  if (!scopes.includes(requiredScope)) return { error: 'scope_missing' };
  // One minute of slack so a token is never used right at its edge.
  const ttl = Math.max(0, (result.expiresIn ?? 3600) - 60) * 1000;
  return { token: { accessToken: result.accessToken, expiresAt: nowMs + ttl } };
}

export function buildAuthUrl(o: {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  silent: boolean;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'token',
    scope: o.scope,
    state: o.state,
    include_granted_scopes: 'true',
  });
  if (o.silent) params.set('prompt', 'none');
  if (o.loginHint) params.set('login_hint', o.loginHint);
  return `${o.authUrl}?${params.toString()}`;
}
