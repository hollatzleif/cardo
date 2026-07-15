import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  ToolStorage,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  buildBookmarksContext,
  domainOf,
  folderToken,
  groupByFolder,
  letterAvatar,
  makeLink,
  topLinks,
  validateUrl,
  type LinkDoc,
} from './logic';

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryLinksIn(storage: ToolStorage): Promise<LinkDoc[]> {
  return storage.query<LinkDoc>({ where: [{ field: 'type', op: '=', value: 'link' }] });
}

/** `url` MUST already be validateUrl()-normalized – commands enforce that. */
async function addLinkIn(
  storage: ToolStorage,
  input: { url: string; title: string; folder?: string },
): Promise<LinkDoc> {
  const link = makeLink(input);
  await storage.set(link.id, link);
  return link;
}

/** The ONLY navigation path: re-validated URL, isolated opener. */
function openLink(url: string): void {
  const safe = validateUrl(url);
  if (safe) window.open(safe, '_blank', 'noopener,noreferrer');
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function useLinks(): LinkDoc[] {
    const [links, setLinks] = useState<LinkDoc[]>([]);
    const reload = useCallback(async () => {
      if (!ctx) return;
      setLinks(await queryLinksIn(ctx.storage));
    }, []);
    useEffect(() => {
      let mounted = true;
      const safeReload = () => {
        if (mounted) void reload();
      };
      safeReload();
      const unsub = ctx?.storage.subscribe(safeReload);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [reload]);
    return links;
  }

  function Avatar(props: { link: LinkDoc; size: number }) {
    const token = folderToken(props.link.folder);
    return (
      <span
        aria-hidden
        style={{
          width: props.size,
          height: props.size,
          borderRadius: 999,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: props.size * 0.45,
          fontWeight: 600,
          background: `color-mix(in srgb, var(--${token}) 25%, var(--bg-widget))`,
          border: `1px solid var(--${token})`,
        }}
      >
        {letterAvatar(props.link.title)}
      </span>
    );
  }

  function DeleteButton(props: { link: LinkDoc }) {
    return (
      <button
        className="c-btn c-btn--ghost"
        aria-label={t('tool.bookmarks.widget.delete', { title: props.link.title })}
        title={t('tool.bookmarks.widget.delete', { title: props.link.title })}
        style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
        onClick={(e) => {
          e.stopPropagation();
          void ctx?.storage.delete(props.link.id);
        }}
      >
        ×
      </button>
    );
  }

  function AddForm() {
    const [url, setUrl] = useState('');
    const [title, setTitle] = useState('');
    const [folder, setFolder] = useState('');
    const [invalid, setInvalid] = useState(false);

    async function addLink() {
      if (!ctx || !url.trim()) return;
      // Route through the registered command – same path the assistant uses.
      const result = await ctx.commands.execute('bookmarks.add', {
        url,
        title: title.trim() || domainOf(validateUrl(url) ?? '') || url.trim(),
        ...(folder.trim() ? { folder: folder.trim() } : {}),
      });
      setInvalid(!result.ok);
      if (result.ok) {
        setUrl('');
        setTitle('');
        setFolder('');
      }
    }

    const onEnter = (e: { key: string }) => {
      if (e.key === 'Enter') void addLink();
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
          <input
            className="c-input"
            style={{ flex: '2 1 120px', ...(invalid ? { borderColor: 'var(--danger)' } : {}) }}
            value={url}
            placeholder={t('tool.bookmarks.widget.urlPlaceholder')}
            aria-label={t('tool.bookmarks.widget.urlPlaceholder')}
            aria-invalid={invalid}
            onChange={(e) => {
              setUrl(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={onEnter}
          />
          <input
            className="c-input"
            style={{ flex: '1 1 90px' }}
            value={title}
            placeholder={t('tool.bookmarks.widget.titlePlaceholder')}
            aria-label={t('tool.bookmarks.widget.titlePlaceholder')}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={onEnter}
          />
          <input
            className="c-input"
            style={{ flex: '1 1 80px' }}
            value={folder}
            placeholder={t('tool.bookmarks.widget.folderPlaceholder')}
            aria-label={t('tool.bookmarks.widget.folderPlaceholder')}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={onEnter}
          />
          <button
            className="c-btn c-btn--primary"
            aria-label={t('tool.bookmarks.widget.add')}
            title={t('tool.bookmarks.widget.add')}
            style={{ flexShrink: 0 }}
            onClick={() => void addLink()}
          >
            +
          </button>
        </div>
        {invalid ? (
          <span style={{ fontSize: '0.75em', color: 'var(--danger)' }}>
            {t('tool.bookmarks.msg.invalidUrl')}
          </span>
        ) : null}
      </div>
    );
  }

  function FolderHeading(props: { folder: string }) {
    return (
      <div
        style={{
          fontSize: '0.75em',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--text-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {props.folder === '' ? t('tool.bookmarks.widget.unsorted') : props.folder}
      </div>
    );
  }

  function GridTile(props: { link: LinkDoc; editing: boolean; big: boolean }) {
    const { link, editing, big } = props;
    return (
      <div
        role="link"
        tabIndex={0}
        aria-label={t('tool.bookmarks.widget.open', { title: link.title })}
        title={link.url}
        onClick={() => openLink(link.url)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openLink(link.url);
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-1)',
          padding: big ? 'var(--space-3)' : 'var(--space-2)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
          cursor: 'pointer',
          minWidth: 0,
          textAlign: 'center',
          position: 'relative',
        }}
      >
        <Avatar link={link} size={big ? 44 : 28} />
        <span
          style={{
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: big ? '0.9em' : '0.8em',
          }}
        >
          {link.title}
        </span>
        <span
          className="c-muted"
          style={{
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '0.7em',
          }}
        >
          {domainOf(link.url)}
        </span>
        {editing ? (
          <span style={{ position: 'absolute', top: 2, right: 2 }}>
            <DeleteButton link={link} />
          </span>
        ) : null}
      </div>
    );
  }

  function ListRow(props: { link: LinkDoc; editing: boolean }) {
    const { link, editing } = props;
    return (
      <div
        role="link"
        tabIndex={0}
        aria-label={t('tool.bookmarks.widget.open', { title: link.title })}
        title={link.url}
        onClick={() => openLink(link.url)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openLink(link.url);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-1)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          minWidth: 0,
        }}
      >
        <Avatar link={link} size={24} />
        <span
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {link.title}
        </span>
        <span className="c-muted" style={{ fontSize: '0.75em', flexShrink: 0 }}>
          {domainOf(link.url)}
        </span>
        {editing ? <DeleteButton link={link} /> : null}
      </div>
    );
  }

  function Widget(props: WidgetProps) {
    const links = useLinks();
    const empty =
      links.length === 0 ? (
        <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
          {t('tool.bookmarks.widget.empty')}
        </div>
      ) : null;

    let body;
    if (props.variant === 'speed-dial') {
      body = (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
            gap: 'var(--space-2)',
            alignContent: 'start',
          }}
        >
          {links.length === 0 ? <div style={{ gridColumn: '1 / -1' }}>{empty}</div> : null}
          {topLinks(links).map((link) => (
            <GridTile key={link.id} link={link} editing={props.editing} big />
          ))}
        </div>
      );
    } else if (props.variant === 'list') {
      body = (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
          }}
        >
          {empty}
          {groupByFolder(links).map((group) => (
            <div key={group.folder} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <FolderHeading folder={group.folder} />
              {group.links.map((link) => (
                <ListRow key={link.id} link={link} editing={props.editing} />
              ))}
            </div>
          ))}
        </div>
      );
    } else {
      // Default variant: folder-grouped tile grid.
      body = (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {empty}
          {groupByFolder(links).map((group) => (
            <div key={group.folder} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <FolderHeading folder={group.folder} />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
                  gap: 'var(--space-1)',
                }}
              >
                {group.links.map((link) => (
                  <GridTile key={link.id} link={link} editing={props.editing} big={false} />
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
        }}
      >
        <AddForm />
        {body}
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    async activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'bookmarks.add',
        titleKey: 'tool.bookmarks.command.add',
        descriptionKey: 'tool.bookmarks.command.addDesc',
        icon: 'bookmark',
        params: z.object({
          url: z.string().min(1),
          title: z.string().min(1),
          folder: z.string().optional(),
        }),
        selfTestParams: { url: 'https://example.com/selftest', title: 'Cardo self-test link' },
        async run({ url, title, folder }): Promise<CommandResult> {
          const safe = validateUrl(url);
          if (!safe) return { ok: false, messageKey: 'tool.bookmarks.msg.invalidUrl' };
          const link = await addLinkIn(context.storage, {
            url: safe,
            title,
            ...(folder ? { folder } : {}),
          });
          return { ok: true, data: link, messageKey: 'tool.bookmarks.msg.added' };
        },
      });

      // Assistant "current state" provider – see todo.context for the contract.
      context.commands.register({
        id: 'bookmarks.context',
        titleKey: 'tool.bookmarks.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const links = await queryLinksIn(context.storage);
          return {
            ok: true,
            data: { contextText: buildBookmarksContext(links, context.i18n.language) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const url = validateUrl('https://selftest.example.com:8443/path');
          if (!url) return { status: 'fail', detail: 'validateUrl rejected a valid https URL' };
          const link = await addLinkIn(testCtx.storage, { url, title: 'selftest crud', folder: 'Selftest' });
          const back = await testCtx.storage.get<LinkDoc>(link.id);
          await testCtx.storage.delete(link.id);
          const gone = await testCtx.storage.get<LinkDoc>(link.id);
          if (!back || back.url !== url || back.title !== 'selftest crud' || back.folder !== 'Selftest') {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'link still present after delete' };
          return { status: 'pass', detail: 'create → read → delete roundtrip ok' };
        }
        case 'url-validation': {
          const rejected = [
            'javascript:alert(1)',
            'JavaScript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'vbscript:msgbox(1)',
            'file:///etc/passwd',
            'ftp://example.com/x',
            '',
            'not a url',
          ];
          for (const raw of rejected) {
            if (validateUrl(raw) !== null) {
              return { status: 'fail', detail: `validateUrl must reject "${raw}"` };
            }
          }
          if (validateUrl('https://example.com') !== 'https://example.com/') {
            return { status: 'fail', detail: 'validateUrl must accept plain https URLs' };
          }
          if (validateUrl('example.com') !== 'https://example.com/') {
            return { status: 'fail', detail: 'validateUrl must upgrade scheme-less input to https' };
          }
          return { status: 'pass', detail: `${rejected.length} malicious/invalid inputs rejected` };
        }
        case 'render':
          return typeof Widget === 'function' && Widget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
