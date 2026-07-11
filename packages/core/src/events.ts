import type { CardoEvents, EventBus } from '@cardo/plugin-api';

export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<(payload: never) => void>>();
  return {
    emit<K extends keyof CardoEvents & string>(event: K, payload: CardoEvents[K]) {
      handlers.get(event)?.forEach((cb) => {
        try {
          cb(payload as never);
        } catch (err) {
          console.error(`[cardo] event handler for "${event}" failed:`, err);
        }
      });
    },
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(cb as never);
      return () => handlers.get(event)?.delete(cb as never);
    },
  };
}
