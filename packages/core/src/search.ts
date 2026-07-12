import type { SearchProvider, SearchResult } from '@cardo/plugin-api';

export interface ScoredSearchResult extends SearchResult {
  toolId: string;
}

/**
 * Global content search behind the command palette. Tools register
 * providers; a query fans out to all of them. Providers that throw or
 * dawdle (300 ms) are skipped – search must never hang the palette.
 */
export class SearchRegistry {
  private providers = new Map<string, SearchProvider[]>();

  register(toolId: string, provider: SearchProvider): void {
    const list = this.providers.get(toolId) ?? [];
    list.push(provider);
    this.providers.set(toolId, list);
  }

  unregisterTool(toolId: string): void {
    this.providers.delete(toolId);
  }

  async query(text: string, limitPerTool = 5): Promise<ScoredSearchResult[]> {
    const q = text.trim();
    if (!q) return [];
    const timeout = new Promise<SearchResult[]>((resolve) => setTimeout(() => resolve([]), 300));
    const jobs = [...this.providers.entries()].flatMap(([toolId, list]) =>
      list.map(async (provider) => {
        try {
          const results = await Promise.race([provider(q), timeout]);
          return results.slice(0, limitPerTool).map((r) => ({ ...r, toolId }));
        } catch {
          return [];
        }
      }),
    );
    return (await Promise.all(jobs)).flat();
  }
}
