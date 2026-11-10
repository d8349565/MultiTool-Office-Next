import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowUpRight, CaretDown, CaretRight, CaretUp, FolderSimple, MagnifyingGlass, X } from '@phosphor-icons/react';
import { api } from './api';
import { cleanPath, dirname, isWithin } from './domain';
import { IconButton, Modal } from './components';
import { FileIcon } from './FileIcon';
import { getLauncherVisual } from './launcherVisuals';
import type { RecentItem } from './quickHistory';
import type { Entry, Launcher, Results } from './types';

interface Candidate {
  key: string;
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'tool';
  tool?: Launcher;
  invalid?: string;
}

interface QuickPanelProps {
  roots: string[];
  launchers: Launcher[];
  history: RecentItem[];
  historyError: string;
  onRemove: (key: string) => void;
  onClear: () => void;
  onLocate: (path: string, isDir: boolean) => Promise<void>;
  onLaunch: (id: string) => Promise<boolean>;
  onClose: () => void;
}

interface SearchResponse {
  keyword: string;
  roots: string[];
  entries: Entry[];
  limited: boolean;
  error?: string;
}

function ResultLocation({ item }: { item: Candidate }) {
  if (item.invalid) return <small className="quick-location">{item.invalid}</small>;

  const location = item.tool ? item.path : dirname(item.path) || item.path;
  const isUrl = /^https?:\/\//i.test(location);
  const path = isUrl ? location : location.replaceAll('/', '\\').replace(/^[a-z]:$/i, '$&\\');
  const lastSeparator = path.lastIndexOf('\\');
  const keepParent = !item.tool && lastSeparator > 0 && lastSeparator < path.length - 1;
  return <small className="quick-location" title={path}>
    <span className="quick-location-prefix">{keepParent ? path.slice(0, lastSeparator) : path}</span>
    {keepParent && <span className="quick-location-tail">{path.slice(lastSeparator)}</span>}
  </small>;
}

export function QuickPanel({ roots, launchers, history, historyError, onRemove, onClear, onLocate, onLaunch, onClose }: QuickPanelProps) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState('');
  const [activeKey, setActiveKey] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const keyword = query.trim();
  const response = search?.keyword === keyword && search.roots === roots ? search : null;
  const busy = Boolean(keyword && roots.length && !response);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (!keyword || !roots.length) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const values = await Promise.all(['file', 'directory'].map(kind => api<Results>('search', {
          query: { query: keyword.replaceAll('\\', '/'), kind, recursive: true, limit: 8 },
        })));
        if (active) setSearch({
          keyword, roots,
          entries: values.flatMap(value => value.items),
          limited: values.some(value => value.total > value.items.length),
        });
      } catch (reason) {
        if (active) setSearch({ keyword, roots, entries: [], limited: false, error: String(reason) });
      }
    }, 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [keyword, roots]);

  const inWorkspace = (path: string) => roots.some(root => isWithin(path, root));
  const recent: Candidate[] = history.map(item => ({
    ...item,
    invalid: inWorkspace(item.path) ? undefined : '已超出当前工作目录范围',
  }));
  let workspaceMatches: Candidate[] = [];
  let toolMatches: Candidate[] = [];
  if (keyword && !busy) {
    const normalized = keyword.toLowerCase().replaceAll('\\', '/');
    const terms = normalized.split(/\s+/);
    const matches = (name: string, path: string) => {
      const text = (name + '\n' + path).toLowerCase().replaceAll('\\', '/');
      return terms.every(term => text.includes(term));
    };
    const paths = new Map<string, Candidate>();
    for (const item of recent) {
      if (!item.invalid && matches(item.name, item.path)) paths.set(item.key, item);
    }
    for (const entry of response?.entries ?? []) {
      const key = 'path:' + cleanPath(entry.path).toLowerCase();
      paths.set(key, { key, name: entry.name, path: entry.path, kind: entry.isDir ? 'directory' : 'file' });
    }
    const nameRank = (name: string) => {
      const lower = name.toLowerCase();
      if (lower === normalized) return 0;
      return terms.every(term => lower.includes(term)) ? 1 : 2;
    };
    toolMatches = launchers
      .filter(tool => matches(tool.name, tool.path))
      .sort((a, b) => nameRank(a.name) - nameRank(b.name))
      .map(tool => ({ key: 'tool:' + tool.id, name: tool.name, path: tool.path, kind: 'tool', tool }));
    workspaceMatches = [...paths.values()].sort((a, b) => nameRank(a.name) - nameRank(b.name));
  }

  const groups = keyword ? [
    { id: 'workspace', title: '文件和文件夹', items: workspaceMatches, limit: toolMatches.length ? 4 : 6 },
    { id: 'tools', title: '工具', items: toolMatches, limit: workspaceMatches.length ? 2 : 5 },
  ].filter(group => group.items.length) : [
    { id: 'recent', title: '最近打开', items: recent, limit: 5 },
  ];
  const remaining = groups.reduce((count, group) => count + Math.max(0, group.items.length - group.limit), 0);
  const shownGroups = groups.map(group => ({
    ...group,
    options: (expanded ? group.items : group.items.slice(0, group.limit)).map((item, i) => ({
      item, id: 'quick-result-' + group.id + '-' + i,
    })),
  }));
  const options = shownGroups.flatMap(group => group.options);
  const activeIndex = Math.max(0, options.findIndex(option => option.item.key === activeKey));
  const selected = options[activeIndex];
  const selectedKey = selected?.item.key;

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey, expanded]);

  function changeQuery(value: string) {
    if (value.trim() !== keyword) setSearch(null);
    setQuery(value);
    setActiveKey('');
    setExpanded(false);
    setConfirmClear(false);
    setError('');
  }

  async function execute(item: Candidate) {
    if (executing || item.invalid) return;
    setExecuting(true);
    setError('');
    try {
      if (item.tool) {
        if (!await onLaunch(item.tool.id)) {
          setError('启动失败，请检查工具路径后重试。');
          return;
        }
      } else {
        await onLocate(item.path, item.kind === 'directory');
      }
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setExecuting(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || !selected || executing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (activeIndex + step + options.length) % options.length;
      setActiveKey(options[next].item.key);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) void execute(selected.item);
    }
  }

  return <Modal title="快捷面板" className="quick-panel" onClose={onClose}>
    <div className="quick-search">
      <MagnifyingGlass size={20} aria-hidden="true"/>
      <input ref={input} role="combobox" aria-label="按名称或路径搜索文件、文件夹或工具" aria-autocomplete="list"
        aria-expanded={options.length > 0} aria-controls="quick-results" aria-activedescendant={selected?.id}
        value={query} onChange={event => changeQuery(event.target.value)} onKeyDown={keyDown}
        placeholder="搜索文件、文件夹或工具"/>
      {query && <IconButton label="清除关键词" onClick={() => { changeQuery(''); input.current?.focus(); }}><X/></IconButton>}
    </div>
    {(error || response?.error) && <p className="quick-error inline-error" role="alert">{error || response?.error}</p>}
    {!keyword && historyError && <p className="quick-error inline-error" role="alert">{historyError}</p>}
    <div className="quick-results" id="quick-results" role="listbox" aria-label={keyword ? '搜索结果' : '最近打开'} ref={list} aria-busy={busy || executing}>
      {shownGroups.map(group => <div className="quick-group" key={group.id} role="group" aria-labelledby={'quick-group-' + group.id}>
        <h3 className="quick-group-title" id={'quick-group-' + group.id}>{group.title}</h3>
        {group.options.map(({ item, id }) => {
          const Icon = item.tool ? getLauncherVisual(item.tool).icon : FolderSimple;
          return <div className="quick-row" key={item.key} role="presentation">
            <button type="button" id={id} role="option" tabIndex={-1} aria-selected={selected?.id === id}
              aria-disabled={Boolean(item.invalid) || executing} className="quick-option" title={item.path}
              onPointerMove={() => setActiveKey(item.key)} onClick={() => void execute(item)}>
              <span className="quick-item-icon">
                {item.kind === 'file' ? <FileIcon extension={item.name.includes('.') ? item.name.split('.').at(-1)! : ''}/> : <Icon size={21} aria-hidden="true"/>}
              </span>
              <span className="quick-item-text">
                <strong className="quick-item-name">{item.name}</strong>
                <ResultLocation item={item}/>
              </span>
              {item.tool ? <ArrowUpRight className="quick-item-action" aria-hidden="true"/> : <CaretRight className="quick-item-action" aria-hidden="true"/>}
            </button>
            {!keyword && <span className="quick-remove">
              <IconButton label={'移除记录：' + item.name} onClick={() => { onRemove(item.key); input.current?.focus(); }}><X/></IconButton>
            </span>}
          </div>;
        })}
      </div>)}
      {!options.length && <p className="quick-empty" role="status">
        {busy ? '正在搜索工作区…' : keyword ? response?.error ? '修改关键词可重新搜索。' : '没有匹配项，试试更短的名称或路径。' : '打开文件或文件夹后，最近记录会显示在这里。'}
      </p>}
    </div>
    {remaining > 0 && <div className="quick-more">
      <Button size="small" appearance="subtle" icon={expanded ? <CaretUp/> : <CaretDown/>} onClick={() => setExpanded(value => !value)}>
        {expanded ? '收起' : '再显示 ' + remaining + ' 条'}
      </Button>
    </div>}
    <div className="quick-footer">
      {confirmClear ? <>
        <span>清空最近打开记录？</span>
        <Button size="small" onClick={() => { onClear(); setConfirmClear(false); input.current?.focus(); }}>清空</Button>
        <Button size="small" appearance="subtle" onClick={() => { setConfirmClear(false); input.current?.focus(); }}>取消</Button>
      </> : <>
        <span className="quick-status" role="status">
          {executing ? '正在处理…' : response?.limited ? '输入更具体的关键词可缩小范围' : selected ? <>
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            {!selected.item.invalid && <span><kbd>Enter</kbd> {selected.item.tool ? '启动' : '定位'}</span>}
          </> : <span><kbd>Esc</kbd> 关闭</span>}
        </span>
        {!keyword && history.length > 0 && <Button size="small" appearance="subtle" onClick={() => setConfirmClear(true)}>清空记录</Button>}
      </>}
    </div>
  </Modal>;
}
