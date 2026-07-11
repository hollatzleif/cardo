import { createHost, type Host } from './services';

let hostInstance: Host | null = null;

export function initHost(): Host {
  if (!hostInstance) hostInstance = createHost();
  return hostInstance;
}

export function getHost(): Host {
  if (!hostInstance) throw new Error('host not initialized');
  return hostInstance;
}

export type { Host };
