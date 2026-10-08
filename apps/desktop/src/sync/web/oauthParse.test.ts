import { describe, expect, it } from 'vitest';
import { acceptResult, buildAuthUrl, parseFragment } from './oauthParse';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

describe('Google implicit-flow fragment', () => {
  it('parses a successful redirect', () => {
    const r = parseFragment(
      `#access_token=abc&expires_in=3599&state=s1&scope=${encodeURIComponent(SCOPE)}&token_type=Bearer`,
    );
    expect(r).toMatchObject({ accessToken: 'abc', expiresIn: 3599, state: 's1', scope: SCOPE });
  });

  it('accepts only matching state and the drive.appdata scope', () => {
    const ok = parseFragment(
      `access_token=t&expires_in=3600&state=s&scope=${encodeURIComponent(SCOPE)}`,
    );
    expect(acceptResult(ok, 's', SCOPE, 1000)).toEqual({
      token: { accessToken: 't', expiresAt: 1000 + 3540_000 },
    });
    expect(acceptResult(ok, 'other', SCOPE, 0)).toEqual({ error: 'state_mismatch' });
    expect(acceptResult(ok, '', SCOPE, 0)).toEqual({ error: 'state_mismatch' });
    const noScope = parseFragment('access_token=t&state=s&scope=email');
    expect(acceptResult(noScope, 's', SCOPE, 0)).toEqual({ error: 'scope_missing' });
    const denied = parseFragment('error=access_denied&state=s');
    expect(acceptResult(denied, 's', SCOPE, 0)).toEqual({ error: 'access_denied' });
  });

  it('builds the auth url with prompt=none only for silent renewal', () => {
    const base = {
      authUrl: 'https://a/auth',
      clientId: 'c',
      redirectUri: 'https://r/cb',
      scope: SCOPE,
      state: 's',
    };
    const interactive = new URL(buildAuthUrl({ ...base, silent: false }));
    expect(interactive.searchParams.get('response_type')).toBe('token');
    expect(interactive.searchParams.get('prompt')).toBeNull();
    const silent = new URL(buildAuthUrl({ ...base, silent: true, loginHint: 'x@y' }));
    expect(silent.searchParams.get('prompt')).toBe('none');
    expect(silent.searchParams.get('login_hint')).toBe('x@y');
  });
});
