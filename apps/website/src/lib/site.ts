/**
 * Central place for site-wide URLs. GITHUB_USER is patched to the real
 * account when the repos are created; the public repo (cardo-app) hosts
 * releases, the forum (GitHub Discussions) and this website via Pages.
 */
export const GITHUB_USER = 'GITHUB_USER';
export const PUBLIC_REPO_URL = `https://github.com/${GITHUB_USER}/cardo-app`;
export const RELEASES_URL = `${PUBLIC_REPO_URL}/releases`;
export const LATEST_RELEASE_URL = `${PUBLIC_REPO_URL}/releases/latest`;
export const FORUM_URL = `${PUBLIC_REPO_URL}/discussions`;

/** Prefix an absolute site path with the GitHub-Pages base path. */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}
