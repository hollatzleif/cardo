import { createHost, type Host, type HostOverrides } from './services';

let hostInstance: Host | null = null;

export function initHost(overrides?: HostOverrides): Host {
  if (!hostInstance) hostInstance = createHost(overrides);
  return hostInstance;
}

export function getHost(): Host {
  if (!hostInstance) throw new Error('host not initialized');
  return hostInstance;
}

export type { Host };
