import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  SearchRegistry,
  ToolRegistry,
  createEventBus,
  createMemoryBackend,
  type HostServices,
} from '@cardo/core';
import { toolFactories } from '../host/tools';
import { parseProposals } from './proposals';

/**
 * The user-facing guarantee behind the assistant: EVERY first-party tool
 * can be driven through the Command API – the exact same path a Ja-click
 * on a proposal card takes (parse → validate → commands.execute).
 */

function makeMemoryFiles() {
  const files = new Map<string, string>();
  return {
    pickFolder: async () => '/scratch',
    getFolder: async () => '/scratch',
    ensureDefaultFolder: async () => '/scratch',
    setFolder: async (p: string) => p,
    list: async () =>
      [...files.entries()].map(([name, c]) => ({ name, modifiedMs: 0, size: c.length })),
    read: async (name: string) => {
      const c = files.get(name);
      if (c === undefined) throw new Error('not found');
      return c;
    },
    write: async (name: string, content: string) => {
      files.set(name, content);
    },
    rename: async (from: string, to: string) => {
      const c = files.get(from);
      if (c === undefined) throw new Error('not found');
      files.delete(from);
      files.set(to, c);
    },
    delete: async (name: string) => {
      files.delete(name);
    },
    reveal: async () => {},
    browse: async () => [],
    readDataUrl: async () => '',
    openExternal: async () => {},
  };
}

function makeScratchHost() {
  const commands = new CommandRegistry();
  const services: HostServices = {
    backend: createMemoryBackend(),
    events: createEventBus(),
    commands,
    notifications: { notify: async () => {} },
    scheduler: { scheduleAt: async () => 'x', cancel: async () => {}, list: async () => [] },
    i18n: { t: (k: string) => k, language: 'en' },
    search: new SearchRegistry(),
    files: makeMemoryFiles(),
  };
  return { commands, registry: new ToolRegistry(services) };
}

describe('assistant can drive every tool via commands', () => {
  it('activates all tools and executes every self-testable command through the proposal pipeline', async () => {
    const { commands, registry } = makeScratchHost();

    for (const factory of Object.values(toolFactories)) {
      registry.register(factory());
    }
    for (const id of Object.keys(toolFactories)) {
      await registry.activate(id);
    }

    const specs = commands.list().filter((c) => c.selfTestParams !== undefined);
    expect(specs.length).toBeGreaterThan(20);

    const failures: string[] = [];
    for (const spec of specs) {
      // Exactly what a Ja-click does: raw model JSON → parse → execute.
      const raw = JSON.stringify({
        reply: 'ok',
        proposals: [{ command: spec.id, params: spec.selfTestParams, summary: 's' }],
        memory: [],
      });
      const parsed = parseProposals(raw, (id) => commands.has(id));
      if (parsed.proposals.length !== 1) {
        failures.push(`${spec.id}: proposal filtered out`);
        continue;
      }
      const proposal = parsed.proposals[0]!;
      const result = await commands.execute(proposal.command, proposal.params);
      if (typeof result.ok !== 'boolean') failures.push(`${spec.id}: no result`);
      if (result.ok === false) failures.push(`${spec.id}: ok=false (${result.messageKey})`);
    }
    expect(failures).toEqual([]);
  });

  it('every tool with declared commands is reachable for the assistant', async () => {
    const { commands, registry } = makeScratchHost();
    for (const factory of Object.values(toolFactories)) registry.register(factory());
    for (const id of Object.keys(toolFactories)) await registry.activate(id);

    for (const [toolId, factory] of Object.entries(toolFactories)) {
      const declared = factory().manifest.commands;
      for (const commandId of declared) {
        expect(commands.has(commandId), `${toolId} → ${commandId} must be registered`).toBe(true);
      }
    }
  });
});
