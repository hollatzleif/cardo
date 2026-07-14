import { z } from 'zod';
import {
  ToolManifestSchema,
  type CardoTool,
  type SelfTestResult,
  type ToolContext,
} from '@cardo/plugin-api';
import { createMemoryBackend } from '@cardo/core';
import { AssistantWidget } from './AssistantWidget';
import { buildCommandCatalog } from './catalog';
import { executeProposals, parseProposals, type AssistantProposal } from './proposals';
import { MODEL_CATALOG } from './models';
import { createMemoryDocStore } from './api';
import { createProfilesStore, modelCompetences, SHARED_MEMORY_ID } from './profiles';
import { parseRouterAnswer } from './routing';

/**
 * Assistant pseudo-tool: a core feature packaged as a CardoTool so it gets
 * the same manifest transparency, privacy declaration, self-tests and
 * widget plumbing as every market tool. All self-tests run offline against
 * in-memory stores.
 */

const manifest = ToolManifestSchema.parse({
  id: 'assistant',
  nameKey: 'tool.assistant.name',
  descriptionKey: 'tool.assistant.description',
  version: '1.0.0',
  minAppVersion: '0.1.0',
  permissions: ['network', 'notifications'],
  privacy: {
    level: 'yellow',
    network: [{ host: 'huggingface.co', dataKey: 'tool.assistant.privacy.download' }],
    summaryKey: 'tool.assistant.privacy.summary',
  },
  widgets: [
    {
      id: 'main',
      defaultSize: { w: 5, h: 6 },
      minSize: { w: 3, h: 4 },
      variants: ['classic', 'messenger'],
    },
  ],
  commands: [],
  selfTests: [
    { id: 'catalog-build', titleKey: 'tool.assistant.test.catalogBuild' },
    { id: 'proposal-validate', titleKey: 'tool.assistant.test.proposalValidate' },
    { id: 'profile-crud', titleKey: 'tool.assistant.test.profileCrud' },
    { id: 'model-competences', titleKey: 'tool.assistant.test.modelCompetences' },
    { id: 'router-parse', titleKey: 'tool.assistant.test.routerParse' },
    { id: 'template-known', titleKey: 'tool.assistant.test.templateKnown' },
    { id: 'catalog-sane', titleKey: 'tool.assistant.test.catalogSane' },
    { id: 'scope-enforcement', titleKey: 'tool.assistant.test.scopeEnforcement' },
    { id: 'claude-catalog', titleKey: 'tool.assistant.test.claudeCatalog' },
  ],
  tourSteps: [
    {
      anchor: 'widget:assistant:main',
      titleKey: 'tool.assistant.tour.title',
      bodyKey: 'tool.assistant.tour.body',
    },
  ],
});

export function createAssistantTool(): CardoTool {
  let ctx: ToolContext | null = null;

  function testCatalogBuild(t: (key: string) => string): SelfTestResult {
    const specs = [
      {
        id: 'probe.create',
        titleKey: 'tool.assistant.name',
        params: z.object({
          title: z.string(),
          count: z.number().optional(),
          done: z.boolean().default(false),
        }) as z.ZodType,
      },
      {
        id: 'probe.hidden',
        titleKey: 'tool.assistant.name',
        params: z.object({}) as z.ZodType,
        palette: false,
      },
    ];
    const entries = buildCommandCatalog(specs, t);
    const first = entries[0];
    if (entries.length !== 1 || !first || first.id !== 'probe.create') {
      return { status: 'fail', detail: `unexpected entries: ${JSON.stringify(entries)}` };
    }
    const shape = first.params.map((p) => `${p.name}:${p.kind}:${p.required}`).join(',');
    const expected = 'title:string:true,count:number:false,done:boolean:false';
    if (shape !== expected) {
      return { status: 'fail', detail: `expected "${expected}", got "${shape}"` };
    }
    if (first.title === '') return { status: 'fail', detail: 'title not translated' };
    return { status: 'pass' };
  }

  function testProposalValidate(): SelfTestResult {
    const has = (id: string) => id === 'todo.create';

    const valid = parseProposals(
      '```json\n{"reply":"Alles klar!","proposals":[{"command":"todo.create","params":{"title":"Milch kaufen"},"summary":"Erstellt das To-do „Milch kaufen“."}],"memory":["kauft freitags ein"]}\n```',
      has,
    );
    if (valid.parseError || valid.proposals.length !== 1 || valid.memory.length !== 1) {
      return { status: 'fail', detail: `valid sample rejected: ${JSON.stringify(valid)}` };
    }

    const hostile = parseProposals(
      '{"reply":"ok","proposals":[{"command":"system.wipeEverything","params":{},"summary":"…"},{"command":42},"nope"],"memory":[{"not":"a string"}],"delegate":[{"to":"evil-profile","reason":"x"}]}',
      has,
      ['known-profile'],
    );
    if (
      hostile.parseError ||
      hostile.proposals.length !== 0 ||
      hostile.memory.length !== 0 ||
      hostile.delegate.length !== 0
    ) {
      return { status: 'fail', detail: `hostile input not filtered: ${JSON.stringify(hostile)}` };
    }

    const garbage = parseProposals('Sorry, as a language model I cannot…', has);
    if (!garbage.parseError || garbage.proposals.length !== 0) {
      return { status: 'fail', detail: `garbage not flagged: ${JSON.stringify(garbage)}` };
    }

    return { status: 'pass' };
  }

  async function testProfileCrud(): Promise<SelfTestResult> {
    // Fully isolated store: in-memory backend + doc store, no Tauri.
    const docs = createMemoryDocStore();
    const store = createProfilesStore({
      backend: createMemoryBackend(),
      docs,
      migrateNative: async () => false,
      listModels: async () => [],
    });
    await store.init();

    const initial = store.getState();
    if (!initial.loaded || initial.profiles.length !== 0) {
      return {
        status: 'fail',
        detail: 'fresh install must not get a migrated default profile',
      };
    }

    const first = await store.createProfile({
      name: 'Erste',
      emoji: '🤖',
      color: 'accent-1',
      modelId: 'qwen3-4b',
      memoryChoice: { share: SHARED_MEMORY_ID },
      toolScope: null,
      personality: '',
      instructions: '',
    });
    if (!store.getState().memories.some((m) => m.id === SHARED_MEMORY_ID)) {
      return { status: 'fail', detail: 'first creation must ensure the shared memory' };
    }
    if (first.memoryId !== SHARED_MEMORY_ID) {
      return { status: 'fail', detail: 'first profile could not share the shared memory' };
    }

    const created = await store.createProfile({
      name: 'Probe',
      emoji: '🧪',
      color: 'accent-2',
      modelId: 'qwen3-4b',
      memoryChoice: { own: 'Probe-Gedächtnis' },
      toolScope: ['todo'],
      personality: 'PERS',
      instructions: 'INST',
    });
    const personality = await docs.read('profile', created.id, 'personality');
    if (personality !== 'PERS') {
      return { status: 'fail', detail: 'personality doc not written' };
    }
    if (store.getState().profiles.length !== 2) {
      return { status: 'fail', detail: 'profile not added to state' };
    }

    await store.deleteProfile(created.id);
    if (store.getState().profiles.length !== 1) {
      return { status: 'fail', detail: 'profile not deleted' };
    }
    if ((await docs.read('profile', created.id, 'personality')) !== '') {
      return { status: 'fail', detail: 'profile docs not deleted' };
    }
    if (!store.getState().memories.some((m) => m.name === 'Probe-Gedächtnis')) {
      return { status: 'fail', detail: 'memory must survive profile deletion' };
    }

    const last = store.getState().profiles[0];
    const guard = await store
      .deleteProfile(last?.id ?? '')
      .then(() => false)
      .catch(() => true);
    if (!guard) return { status: 'fail', detail: 'last profile was deletable' };

    return { status: 'pass' };
  }

  /** Every catalog model must resolve non-empty competences in en + de. */
  function testModelCompetences(): SelfTestResult {
    for (const model of MODEL_CATALOG) {
      for (const language of ['en', 'de'] as const) {
        const text = modelCompetences(model.id, language);
        if (!text.trim()) {
          return { status: 'fail', detail: `${model.id} (${language}): empty competences` };
        }
        if (text.includes('assistant.model.')) {
          return { status: 'fail', detail: `${model.id} (${language}): unresolved i18n key` };
        }
      }
    }
    if (modelCompetences('no-such-model', 'de') !== '') {
      return { status: 'fail', detail: 'unknown model id must yield ""' };
    }
    return { status: 'pass' };
  }

  function testRouterParse(): SelfTestResult {
    const members = ['p-writer', 'p-coder'];
    const cases: Array<[string, string]> = [
      ['p-coder', 'p-coder'],
      ['  "p-writer"  ', 'p-writer'],
      ['Ich wähle p-coder, weil…', 'p-coder'],
      ['keine Ahnung', 'p-writer'],
    ];
    for (const [raw, expected] of cases) {
      const got = parseRouterAnswer(raw, members, 'p-writer');
      if (got !== expected) {
        return { status: 'fail', detail: `"${raw}" → "${got}", expected "${expected}"` };
      }
    }
    return { status: 'pass' };
  }

  function testTemplateKnown(): SelfTestResult {
    const known = new Set(['chatml', 'gemma', 'llama3', 'phi']);
    for (const m of MODEL_CATALOG) {
      if (!known.has(m.template)) {
        return { status: 'fail', detail: `${m.id}: unknown template "${m.template}"` };
      }
    }
    return { status: 'pass' };
  }

  function testCatalogSane(): SelfTestResult {
    const ids = new Set<string>();
    for (const m of MODEL_CATALOG) {
      if (ids.has(m.id)) return { status: 'fail', detail: `duplicate id ${m.id}` };
      ids.add(m.id);
      // Download/size invariants only apply to local models – claude
      // entries are cloud-backed (sizeBytes 0, url informational only)
      // and get their own 'claude-catalog' self-test.
      if (m.provider === 'local') {
        if (!m.url.startsWith('https://huggingface.co/')) {
          return { status: 'fail', detail: `${m.id}: non-huggingface url` };
        }
        if (!(m.ramNeedMb > 0)) return { status: 'fail', detail: `${m.id}: ramNeedMb` };
        if (!(m.sizeBytes > 0)) return { status: 'fail', detail: `${m.id}: sizeBytes` };
      }
      if (!m.license.url.startsWith('https://')) {
        return { status: 'fail', detail: `${m.id}: license url` };
      }
    }
    return { status: 'pass' };
  }

  /** Claude entries: offline catalog invariants only – no CLI call. */
  function testClaudeCatalog(): SelfTestResult {
    const expected = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
    const claude = MODEL_CATALOG.filter((m) => m.provider === 'claude');
    if (claude.map((m) => m.id).join(',') !== expected.join(',')) {
      return {
        status: 'fail',
        detail: `expected [${expected.join(', ')}], got [${claude.map((m) => m.id).join(', ')}]`,
      };
    }
    for (const m of claude) {
      if (typeof m.cliModel !== 'string' || m.cliModel === '') {
        return { status: 'fail', detail: `${m.id}: cliModel missing` };
      }
      if (m.sizeBytes !== 0 || m.ramNeedMb !== 0) {
        return { status: 'fail', detail: `${m.id}: cloud entries must not claim size/RAM` };
      }
      if (m.license.notice !== 'claude-account') {
        return { status: 'fail', detail: `${m.id}: license notice must be 'claude-account'` };
      }
    }
    return { status: 'pass' };
  }

  async function testScopeEnforcement(): Promise<SelfTestResult> {
    const executed: string[] = [];
    const proposals: AssistantProposal[] = [
      { command: 'todo.create', params: { title: 'ok' }, summary: 's' },
      { command: 'system.wipeEverything', params: {}, summary: 'evil' },
    ];
    const outcome = await executeProposals(proposals, {
      toolScope: ['todo'],
      execute: async (p) => {
        executed.push(p.command);
        return { ok: true };
      },
    });
    if (
      outcome.executed.length !== 1 ||
      outcome.blocked.length !== 1 ||
      executed.join(',') !== 'todo.create' ||
      outcome.blocked[0]?.command !== 'system.wipeEverything'
    ) {
      return { status: 'fail', detail: `scope not enforced: ${JSON.stringify(outcome)}` };
    }
    return { status: 'pass' };
  }

  return {
    manifest,
    activate(context) {
      // Kept for i18n/commands/events access – the widget itself goes
      // through getHost(), but self-tests prefer the scratch context.
      ctx = context;
    },
    deactivate() {
      ctx = null;
    },
    Widget: AssistantWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'catalog-build': {
          const context = ctx ?? testCtx;
          return testCatalogBuild((key) => context.i18n.t(key));
        }
        case 'proposal-validate':
          return testProposalValidate();
        case 'profile-crud':
          return testProfileCrud();
        case 'model-competences':
          return testModelCompetences();
        case 'router-parse':
          return testRouterParse();
        case 'template-known':
          return testTemplateKnown();
        case 'catalog-sane':
          return testCatalogSane();
        case 'scope-enforcement':
          return testScopeEnforcement();
        case 'claude-catalog':
          return testClaudeCatalog();
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
