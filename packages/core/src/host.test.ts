import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CardoTool, ToolManifest } from '@cardo/plugin-api';
import { CommandRegistry } from './commands';
import { createEventBus } from './events';
import { createMemoryBackend, createNamespacedStorage } from './storage';
import { ToolRegistry, type HostServices } from './registry';
import { buildToolChecks, runDiagnostics, renderReportMarkdown } from './diagnose';

const testManifest: ToolManifest = {
  id: 'probe',
  nameKey: 'tool.probe.name',
  descriptionKey: 'tool.probe.description',
  version: '1.0.0',
  minAppVersion: '0.1.0',
  permissions: [],
  privacy: { level: 'green', network: [], summaryKey: 'tool.probe.privacy' },
  widgets: [{ id: 'main', defaultSize: { w: 3, h: 3 }, minSize: { w: 2, h: 2 }, variants: [] }],
  commands: ['probe.echo'],
  selfTests: [{ id: 'basic', titleKey: 'tool.probe.test.basic' }],
  tourSteps: [],
};

function createProbeTool(): CardoTool {
  return {
    manifest: structuredClone(testManifest),
    activate(ctx) {
      ctx.commands.register({
        id: 'probe.echo',
        titleKey: 'tool.probe.command.echo',
        params: z.object({ text: z.string() }),
        selfTestParams: { text: 'ping' },
        async run({ text }) {
          await ctx.storage.set('last-echo', { text });
          return { ok: true, data: text };
        },
      });
    },
    deactivate() {},
    Widget: (() => null) as never,
    async runSelfTest(testId, ctx) {
      if (testId !== 'basic') return { status: 'fail', detail: 'unknown test' };
      await ctx.storage.set('probe-doc', { n: 1 });
      const doc = await ctx.storage.get<{ n: number }>('probe-doc');
      return doc?.n === 1 ? { status: 'pass' } : { status: 'fail', detail: 'roundtrip failed' };
    },
  };
}

function createServices(): HostServices {
  return {
    backend: createMemoryBackend(),
    events: createEventBus(),
    commands: new CommandRegistry(),
    notifications: { notify: async () => {} },
    scheduler: { scheduleAt: async () => 'x', cancel: async () => {}, list: async () => [] },
    i18n: { t: (k) => k, language: 'en' },
  };
}

describe('namespaced storage', () => {
  it('scopes reads and writes to the namespace', async () => {
    const backend = createMemoryBackend();
    const a = createNamespacedStorage(backend, 'tool-a');
    const b = createNamespacedStorage(backend, 'tool-b');
    await a.set('doc', { from: 'a' });
    expect(await b.get('doc')).toBeNull();
    expect(await a.get('doc')).toEqual({ from: 'a' });
  });

  it('rejects invalid namespaces', () => {
    const backend = createMemoryBackend();
    expect(() => createNamespacedStorage(backend, '../evil')).toThrow();
    expect(() => createNamespacedStorage(backend, 'Evil')).toThrow();
  });

  it('filters, orders and limits queries', async () => {
    const backend = createMemoryBackend();
    const s = createNamespacedStorage(backend, 'q');
    await s.set('1', { p: 3, done: false });
    await s.set('2', { p: 1, done: true });
    await s.set('3', { p: 2, done: false });
    const open = await s.query<{ p: number }>({
      where: [{ field: 'done', op: '=', value: false }],
      orderBy: 'p',
      direction: 'desc',
    });
    expect(open.map((r) => r.p)).toEqual([3, 2]);
  });

  it('notifies subscribers only for their namespace', async () => {
    const backend = createMemoryBackend();
    const a = createNamespacedStorage(backend, 'tool-a');
    const b = createNamespacedStorage(backend, 'tool-b');
    const events: string[] = [];
    a.subscribe((ev) => events.push(ev.docId));
    await b.set('foreign', {});
    await a.set('mine', {});
    expect(events).toEqual(['mine']);
  });
});

describe('command registry', () => {
  it('validates params with the zod schema', async () => {
    const registry = new CommandRegistry();
    registry.register({
      id: 'test.cmd',
      titleKey: 't',
      params: z.object({ n: z.number() }),
      run: async ({ n }) => ({ ok: true, data: n * 2 }),
    });
    expect((await registry.execute('test.cmd', { n: 2 })).data).toBe(4);
    expect((await registry.execute('test.cmd', { n: 'nope' })).ok).toBe(false);
    expect((await registry.execute('missing.cmd', {})).ok).toBe(false);
  });

  it('rejects duplicate ids and unregisters by tool', () => {
    const registry = new CommandRegistry();
    const spec = { id: 'a.one', titleKey: 't', params: z.object({}), run: async () => ({ ok: true }) };
    registry.register(spec);
    expect(() => registry.register(spec)).toThrow();
    registry.unregisterTool('a');
    expect(registry.has('a.one')).toBe(false);
  });
});

describe('tool registry', () => {
  it('rejects manifests without self-tests', () => {
    const registry = new ToolRegistry(createServices());
    const tool = createProbeTool();
    (tool.manifest as { selfTests: unknown }).selfTests = [];
    expect(() => registry.register(tool)).toThrow(/manifest invalid/i);
  });

  it('rejects yellow privacy without network declaration', () => {
    const registry = new ToolRegistry(createServices());
    const tool = createProbeTool();
    (tool.manifest as { privacy: unknown }).privacy = {
      level: 'yellow',
      network: [],
      summaryKey: 'x',
    };
    expect(() => registry.register(tool)).toThrow(/manifest invalid/i);
  });

  it('activates a tool and verifies declared commands', async () => {
    const services = createServices();
    const registry = new ToolRegistry(services);
    registry.register(createProbeTool());
    await registry.activate('probe');
    expect(services.commands.has('probe.echo')).toBe(true);
    const result = await services.commands.execute('probe.echo', { text: 'hello' });
    expect(result).toMatchObject({ ok: true, data: 'hello' });
    await registry.deactivate('probe');
    expect(services.commands.has('probe.echo')).toBe(false);
  });

  it('fails activation when a declared command is missing', async () => {
    const services = createServices();
    const registry = new ToolRegistry(services);
    const tool = createProbeTool();
    tool.activate = () => {}; // registers nothing
    registry.register(tool);
    await expect(registry.activate('probe')).rejects.toThrow(/did not register/);
  });

  it('prevents a tool from registering foreign commands', async () => {
    const services = createServices();
    const registry = new ToolRegistry(services);
    const tool = createProbeTool();
    tool.activate = (ctx) => {
      ctx.commands.register({
        id: 'other.steal',
        titleKey: 't',
        params: z.object({}),
        run: async () => ({ ok: true }),
      });
    };
    registry.register(tool);
    await expect(registry.activate('probe')).rejects.toThrow(/foreign command/);
  });
});

describe('diagnostics', () => {
  it('runs tool checks against a scratch backend and renders a report', async () => {
    const services = createServices();
    const checks = buildToolChecks({ factory: createProbeTool }, services);
    const report = await runDiagnostics(checks, {
      appVersion: '0.1.0',
      platform: 'test',
      language: 'en',
      themeId: 'catppuccin-mocha',
      activeTools: ['probe'],
    });
    expect(report.summary.failed).toBe(0);
    expect(report.results.length).toBe(3); // ping + commands + 1 self-test
    const md = renderReportMarkdown(report, (k) => k);
    expect(md).toContain('✅');
    expect(md).toContain('```json');
    // User data untouched: the real backend never saw the probe writes.
    expect(await services.backend.get('probe', 'probe-doc')).toBeNull();
  });

  it('reports failures without aborting the run', async () => {
    const services = createServices();
    const broken = () => {
      const tool = createProbeTool();
      tool.runSelfTest = async () => ({ status: 'fail', detail: 'kaputt' });
      return tool;
    };
    const checks = buildToolChecks({ factory: broken }, services);
    const report = await runDiagnostics(checks, {
      appVersion: '0.1.0',
      platform: 'test',
      language: 'en',
      themeId: 'catppuccin-mocha',
      activeTools: [],
    });
    expect(report.summary.failed).toBe(1);
    expect(report.results.find((r) => r.status === 'fail')?.detail).toBe('kaputt');
  });
});
