import { z } from 'zod';
import {
  ToolManifestSchema,
  type CardoTool,
  type SelfTestResult,
  type ToolContext,
} from '@cardo/plugin-api';
import { AssistantWidget } from './AssistantWidget';
import { buildCommandCatalog } from './catalog';
import { parseProposals } from './proposals';

/**
 * Assistant pseudo-tool: a core feature packaged as a CardoTool so it gets
 * the same manifest transparency, privacy declaration, self-tests and
 * widget plumbing as every market tool.
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
  widgets: [{ id: 'main', defaultSize: { w: 5, h: 6 }, minSize: { w: 3, h: 4 } }],
  commands: [],
  selfTests: [
    { id: 'catalog-build', titleKey: 'tool.assistant.test.catalogBuild' },
    { id: 'proposal-validate', titleKey: 'tool.assistant.test.proposalValidate' },
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
      '```json\n{"reply":"Alles klar!","proposals":[{"command":"todo.create","params":{"title":"Milch kaufen"},"summary":"Erstellt das To-do „Milch kaufen"."}],"memory":["kauft freitags ein"]}\n```',
      has,
    );
    if (valid.parseError || valid.proposals.length !== 1 || valid.memory.length !== 1) {
      return { status: 'fail', detail: `valid sample rejected: ${JSON.stringify(valid)}` };
    }

    const hostile = parseProposals(
      '{"reply":"ok","proposals":[{"command":"system.wipeEverything","params":{},"summary":"…"},{"command":42},"nope"],"memory":[{"not":"a string"}]}',
      has,
    );
    if (hostile.parseError || hostile.proposals.length !== 0 || hostile.memory.length !== 0) {
      return { status: 'fail', detail: `hostile input not filtered: ${JSON.stringify(hostile)}` };
    }

    const garbage = parseProposals('Sorry, as a language model I cannot…', has);
    if (!garbage.parseError || garbage.proposals.length !== 0) {
      return { status: 'fail', detail: `garbage not flagged: ${JSON.stringify(garbage)}` };
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
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
