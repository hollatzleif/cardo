import { z } from 'zod';

/**
 * Tool manifest – the contract every tool ships with.
 * Privacy declaration and self-tests are mandatory by design:
 * a manifest without them does not validate (transparency principle).
 */

export const PermissionSchema = z.enum([
  'notifications',
  'scheduler',
  'audio',
  'file-read', // read access to a user-picked folder (e.g. notes)
  'file-write',
  'network', // MUST come with privacy.level "yellow" + network declaration
  'global-shortcut',
]);
export type Permission = z.infer<typeof PermissionSchema>;

export const PrivacyDeclarationSchema = z
  .object({
    /** green = fully local · yellow = contacts the internet */
    level: z.enum(['green', 'yellow']),
    /** For yellow: exactly which hosts are contacted and what data is sent (i18n key). */
    network: z
      .array(z.object({ host: z.string().min(1), dataKey: z.string().min(1) }))
      .default([]),
    /** Plain-language summary shown before first activation (i18n key). */
    summaryKey: z.string().min(1),
  })
  .refine((p) => p.level === 'green' || p.network.length > 0, {
    message: 'privacy.level "yellow" requires at least one network declaration',
  })
  .refine((p) => p.level === 'yellow' || p.network.length === 0, {
    message: 'privacy.level "green" must not declare network hosts',
  });

export const WidgetSizeSchema = z.object({
  w: z.number().int().min(1).max(24),
  h: z.number().int().min(1).max(24),
});

export const WidgetDeclarationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  defaultSize: WidgetSizeSchema,
  minSize: WidgetSizeSchema,
  variants: z.array(z.string()).default([]),
});

export const SelfTestDeclarationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  titleKey: z.string().min(1),
});

export const TourStepSchema = z.object({
  /** Anchor id, e.g. "widget:todo:main" or "ui:settings-button" */
  anchor: z.string().min(1),
  titleKey: z.string().min(1),
  bodyKey: z.string().min(1),
});

/**
 * One numbered step of a tool's in-app setup guide. Tools that need user
 * configuration (accounts, imports, folders …) declare their guide here;
 * the market shows it before activation and the tool's empty state renders
 * it via the shared <SetupGuide> component.
 */
export const SetupStepSchema = z.object({
  titleKey: z.string().min(1),
  bodyKey: z.string().min(1),
});

export const ToolManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'tool id must be kebab-case'),
  nameKey: z.string().min(1),
  descriptionKey: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  permissions: z.array(PermissionSchema).default([]),
  privacy: PrivacyDeclarationSchema,
  widgets: z.array(WidgetDeclarationSchema).min(1),
  /** Command ids this tool registers on activate(). Verified by the host. */
  commands: z.array(z.string().regex(/^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9-]*$/)).default([]),
  /** Mandatory: every tool must ship self-tests (quality gate, also for future community tools). */
  selfTests: z.array(SelfTestDeclarationSchema).min(1),
  tourSteps: z.array(TourStepSchema).default([]),
  /** In-app setup guide for tools that need configuration/imports. */
  setupSteps: z.array(SetupStepSchema).default([]),
  settingsSchema: z.record(z.unknown()).optional(),
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;
export type WidgetDeclaration = z.infer<typeof WidgetDeclarationSchema>;
export type PrivacyDeclaration = z.infer<typeof PrivacyDeclarationSchema>;
export type SetupStep = z.infer<typeof SetupStepSchema>;
