import { z } from 'zod';
import type { Page, WidgetInstance } from '../state/appStore';
import type { DesignOverrides } from '../design/design';

/**
 * Dashboard export/import: pure serialize/parse so boards (pages + widgets,
 * optionally the design) can be shared as a single JSON file. Instance and
 * page ids are stripped on export and freshly minted on import – imported
 * boards never collide with existing ones.
 */

export const LAYOUT_FILE_KIND = 'cardo-layout';
export const LAYOUT_FILE_VERSION = 1;

const WidgetSchema = z.object({
  toolId: z.string().min(1),
  widgetId: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(24),
  h: z.number().int().min(1).max(24),
  accentToken: z.string().optional(),
  variant: z.string().optional(),
});

const PageSchema = z.object({
  name: z.string().min(1).max(120),
  order: z.number().int().min(0),
  widgets: z.array(WidgetSchema),
});

export const LayoutFileSchema = z.object({
  kind: z.literal(LAYOUT_FILE_KIND),
  version: z.literal(LAYOUT_FILE_VERSION),
  exportedAt: z.string().optional(),
  pages: z.array(PageSchema).min(1),
  /** Optional: the design overrides travel with the board when included. */
  design: z.record(z.unknown()).optional(),
});

export type LayoutFile = z.infer<typeof LayoutFileSchema>;

export function serializeLayout(
  pages: readonly Page[],
  design?: DesignOverrides | null,
  exportedAt?: string,
): LayoutFile {
  return {
    kind: LAYOUT_FILE_KIND,
    version: LAYOUT_FILE_VERSION,
    ...(exportedAt ? { exportedAt } : {}),
    pages: pages.map((page) => ({
      name: page.name,
      order: page.order,
      widgets: page.widgets.map((widget) => ({
        toolId: widget.toolId,
        widgetId: widget.widgetId,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        ...(widget.accentToken ? { accentToken: widget.accentToken } : {}),
        ...(widget.variant ? { variant: widget.variant } : {}),
      })),
    })),
    ...(design && Object.keys(design).length > 0
      ? { design: design as Record<string, unknown> }
      : {}),
  };
}

export interface ParsedLayout {
  pages: Page[];
  design: Record<string, unknown> | null;
  /** Tool ids in the file that this install does not know. */
  missingTools: string[];
}

/**
 * Validates + re-mints ids. Widgets of unknown tools are dropped (and
 * reported) instead of producing dead frames; `orderOffset` appends the
 * imported pages after the existing ones.
 */
export function parseLayout(
  raw: unknown,
  knownToolIds: ReadonlySet<string>,
  orderOffset: number,
  mintId: () => string = () => crypto.randomUUID(),
): ParsedLayout | { error: string } {
  const result = LayoutFileSchema.safeParse(raw);
  if (!result.success) {
    return { error: result.error.issues.map((i) => i.message).join('; ') };
  }
  const missing = new Set<string>();
  const pages: Page[] = result.data.pages
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((page, index) => ({
      id: `page-${mintId()}`,
      name: page.name,
      order: orderOffset + index,
      widgets: page.widgets
        .filter((widget) => {
          const known = knownToolIds.has(widget.toolId);
          if (!known) missing.add(widget.toolId);
          return known;
        })
        .map((widget) => ({ ...widget, instanceId: `w-${mintId()}` }) as WidgetInstance),
    }));
  return { pages, design: result.data.design ?? null, missingTools: [...missing].sort() };
}
