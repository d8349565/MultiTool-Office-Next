import { useState, useMemo, useEffect, type CSSProperties, type KeyboardEvent } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import {
  MagnifyingGlass,
  Plus,
  SquaresFour,
  ListBullets,
  ArrowUpRight,
  FolderOpen,
  Copy,
  X,
  GearSix,
  Sparkle,
} from '@phosphor-icons/react';
import type { Launcher } from './types';
import { getLauncherVisual, computeCategoryCounts } from './launcherVisuals';
import { basename } from './domain';
import { Empty } from './components';

export interface ToolsWorkbenchProps {
  launchers: Launcher[];
  onLaunch: (id: string) => void;
  onOpenFolder?: (id: string) => void;
  onCopyPath: (path: string) => void;
  onOpenSettings: (tab?: string) => void;
}

export function ToolsWorkbench({
  launchers,
  onLaunch,
  onOpenFolder,
  onCopyPath,
  onOpenSettings,
}: ToolsWorkbenchProps) {
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | string>('all');
  const [filterMode, setFilterMode] = useState<'type' | 'group'>('type');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try {
      return (localStorage.getItem('office-tools-view') as 'grid' | 'list') || 'grid';
    } catch {
      return 'grid';
    }
  });

  const { typeCounts, groupCounts } = useMemo(() => computeCategoryCounts(launchers), [launchers]);
  useEffect(() => {
    const categories = filterMode === 'type' ? typeCounts : groupCounts;
    if (activeFilter !== 'all' && !categories.some(category => category.key === activeFilter)) setActiveFilter('all');
  }, [activeFilter, filterMode, typeCounts, groupCounts]);

  const toggleViewMode = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    try {
      localStorage.setItem('office-tools-view', mode);
    } catch {}
  };

  function launchFromKeyboard(event: KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) onLaunch(id);
  }
  // 过滤结果
  const filteredLaunchers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return launchers.filter(l => {
      // 关键词筛选
      if (q) {
        const visual = getLauncherVisual(l);
        const matchName = l.name.toLowerCase().includes(q);
        const matchPath = l.path.toLowerCase().includes(q);
        const matchGroup = (l.group || '').toLowerCase().includes(q);
        const matchLabel = visual.label.toLowerCase().includes(q);
        const matchBadge = visual.badge.toLowerCase().includes(q);
        if (!matchName && !matchPath && !matchGroup && !matchLabel && !matchBadge) {
          return false;
        }
      }

      // 标签筛选
      if (activeFilter !== 'all') {
        if (filterMode === 'type') {
          const visual = getLauncherVisual(l);
          if (visual.kind !== activeFilter) return false;
        } else {
          const group = l.group?.trim() || '未分组';
          if (group !== activeFilter) return false;
        }
      }

      return true;
    });
  }, [launchers, search, activeFilter, filterMode]);

  // 如果没有添加任何工具
  if (!launchers.length) {
    return (
      <div className="tools-workbench-page">
        <div className="page-heading">
          <div>
            <h1>
              常用工具<span className="heading-dot">/</span>
              <span className="heading-sub">你的工作捷径。</span>
            </h1>
            <p>把每天都会用到的程序、Python 脚本与文件，放在一起。</p>
          </div>
          <Button icon={<GearSix />} onClick={() => onOpenSettings('tools')}>
            管理工具
          </Button>
        </div>
        <Empty
          title="常用的，放在手边"
          detail="添加桌面软件、Python 脚本、Excel 表格、工作目录或网址，一键即达。"
          action={
            <Button appearance="primary" icon={<Plus />} onClick={() => onOpenSettings('tools')}>
              添加第一个常用工具
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="tools-workbench-page">
      {/* 头部标题区 */}
      <div className="page-heading">
        <div>
          <h1>
            常用工具<span className="heading-dot">/</span>
            <span className="heading-sub">你的工作捷径。</span>
          </h1>
          <p>智能识别文件类型与脚本，分类直观，快速呼出。</p>
        </div>
        <div className="tools-header-actions">
          <Button icon={<Plus />} onClick={() => onOpenSettings('tools')}>
            添加工具
          </Button>
          <Button icon={<GearSix />} appearance="subtle" onClick={() => onOpenSettings('tools')}>
            管理与排序
          </Button>
        </div>
      </div>

      {/* 控制条：即时检索、分类胶囊、模式切换 */}
      <div className="tools-control-bar">
        {/* 搜索框 */}
        <label className="tools-search-field">
          <MagnifyingGlass size={16} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="按名称、类型、后缀或路径搜索…"
            aria-label="搜索常用工具"
          />
          {search && (
            <button
              type="button"
              className="tools-clear-btn"
              onClick={() => setSearch('')}
              aria-label="清空搜索"
            >
              <X size={14} />
            </button>
          )}
        </label>

        {/* 分类模式切换（按类型 / 按分组） */}
        <div className="tools-filter-mode-toggle">
          <button
            type="button"
            className={filterMode === 'type' ? 'active' : ''}
            onClick={() => {
              setFilterMode('type');
              setActiveFilter('all');
            }}
          >
            按类型
          </button>
          <button
            type="button"
            className={filterMode === 'group' ? 'active' : ''}
            onClick={() => {
              setFilterMode('group');
              setActiveFilter('all');
            }}
          >
            按分组
          </button>
        </div>

        {/* 视图模式切换 */}
        <div className="tools-view-toggle">
          <Tooltip content="卡片看板网格" relationship="label">
            <button
              type="button"
              className={viewMode === 'grid' ? 'active' : ''}
              onClick={() => toggleViewMode('grid')}
              aria-label="网格视图"
            >
              <SquaresFour size={16} weight={viewMode === 'grid' ? 'fill' : 'regular'} />
            </button>
          </Tooltip>
          <Tooltip content="紧凑行式清单" relationship="label">
            <button
              type="button"
              className={viewMode === 'list' ? 'active' : ''}
              onClick={() => toggleViewMode('list')}
              aria-label="清单视图"
            >
              <ListBullets size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* 分类筛选胶囊标签条 */}
      <div className="tools-pills-bar" role="tablist" aria-label="工具分类筛选">
        <button
          type="button"
          className={`tools-pill ${activeFilter === 'all' ? 'active' : ''}`}
          onClick={() => setActiveFilter('all')}
        >
          全部 <span>{launchers.length}</span>
        </button>

        {filterMode === 'type'
          ? typeCounts.map(tc => (
              <button
                type="button"
                key={tc.key}
                className={`tools-pill ${activeFilter === tc.key ? 'active' : ''}`}
                onClick={() => setActiveFilter(activeFilter === tc.key ? 'all' : tc.key)}
              >
                {tc.label} <span>{tc.count}</span>
              </button>
            ))
          : groupCounts.map(gc => (
              <button
                type="button"
                key={gc.key}
                className={`tools-pill ${activeFilter === gc.key ? 'active' : ''}`}
                onClick={() => setActiveFilter(activeFilter === gc.key ? 'all' : gc.key)}
              >
                {gc.label} <span>{gc.count}</span>
              </button>
            ))}
      </div>

      {/* 列表主体 */}
      <div className="tools-content-scroll">
        {!filteredLaunchers.length ? (
          <div className="tools-empty-search">
            <Sparkle size={28} weight="duotone" />
            <p>{search.trim() ? `没有找到与“${search.trim()}”匹配的工具` : '当前分类下没有工具'}</p>
            <Button size="small" appearance="subtle" onClick={() => { setSearch(''); setActiveFilter('all'); }}>
              清除筛选条件
            </Button>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="tools-grid-layout">
            {filteredLaunchers.map(launcher => {
              const visual = getLauncherVisual(launcher);
              const IconComp = visual.icon;
              const isWeb = visual.kind === 'web';

              return (
                <div
                  key={launcher.id}
                  className="tool-card"
                  style={
                    {
                      '--tool-primary': visual.theme.primary,
                      '--tool-subtle': visual.theme.subtle,
                      '--tool-border': visual.theme.border,
                      '--tool-badge-bg': visual.theme.badgeBg,
                      '--tool-badge-text': visual.theme.badgeText,
                    } as CSSProperties
                  }
                  title={launcher.path}
                >
                  {/* 卡片头部：左侧彩色徽章 + 右侧类型/分组胶囊 */}
                  <div className="tool-card-head">
                    <div className="tool-badge-icon" aria-hidden="true">
                      <IconComp size={22} weight="duotone" />
                      <span className="tool-badge-format">{visual.badge}</span>
                    </div>

                    <div className="tool-card-tags">
                      <span className="tool-type-tag">{visual.label}</span>
                      {launcher.group && launcher.group !== '未分组' && (
                        <span className="tool-group-tag">{launcher.group}</span>
                      )}
                    </div>
                  </div>

                  {/* 卡片主体：标题与副标题 */}
                  <div className="tool-card-body" onClick={() => onLaunch(launcher.id)} onKeyDown={event => launchFromKeyboard(event, launcher.id)} role="button" tabIndex={0} aria-label={`打开 ${launcher.name}`}>
                    <strong className="tool-card-title">{launcher.name}</strong>
                    <span className="tool-card-sub" title={launcher.path}>
                      {visual.subtitle}
                    </span>
                  </div>

                  {/* 卡片底部操作栏 */}
                  <div className="tool-card-footer">
                    <div className="tool-card-actions">
                      {!isWeb && onOpenFolder && (
                        <Tooltip content="在资源管理器中定位" relationship="label">
                          <button
                            type="button"
                            className="tool-action-btn"
                            onClick={e => {
                              e.stopPropagation();
                              onOpenFolder(launcher.id);
                            }}
                            aria-label="打开所在目录"
                          >
                            <FolderOpen size={14} />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content="复制路径" relationship="label">
                        <button
                          type="button"
                          className="tool-action-btn"
                          onClick={e => {
                            e.stopPropagation();
                            onCopyPath(launcher.path);
                          }}
                          aria-label="复制路径"
                        >
                          <Copy size={14} />
                        </button>
                      </Tooltip>
                    </div>

                    <button
                      type="button"
                      className="tool-launch-btn"
                      onClick={() => onLaunch(launcher.id)}
                      aria-label={`启动 ${launcher.name}`}
                    >
                      <span>打开</span>
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* 紧凑清单视图 */
          <div className="tools-list-layout">
            {filteredLaunchers.map(launcher => {
              const visual = getLauncherVisual(launcher);
              const IconComp = visual.icon;
              const isWeb = visual.kind === 'web';

              return (
                <div
                  key={launcher.id}
                  className="tool-list-row"
                  style={
                    {
                      '--tool-primary': visual.theme.primary,
                      '--tool-subtle': visual.theme.subtle,
                      '--tool-border': visual.theme.border,
                      '--tool-badge-bg': visual.theme.badgeBg,
                      '--tool-badge-text': visual.theme.badgeText,
                    } as CSSProperties
                  }
                  title={launcher.path}
                  onClick={() => onLaunch(launcher.id)}
                  onKeyDown={event => launchFromKeyboard(event, launcher.id)}
                  aria-label={`打开 ${launcher.name}`}
                  role="button"
                  tabIndex={0}
                >
                  <div className="tool-list-icon">
                    <IconComp size={18} weight="duotone" />
                  </div>

                  <div className="tool-list-content">
                    <div className="tool-list-main">
                      <strong className="tool-list-name">{launcher.name}</strong>
                      <span className="tool-list-badge">{visual.badge}</span>
                      <span className="tool-list-type">{visual.label}</span>
                      {launcher.group && launcher.group !== '未分组' && (
                        <span className="tool-list-group">{launcher.group}</span>
                      )}
                    </div>
                    <span className="tool-list-path">{visual.subtitle}</span>
                  </div>

                  <div className="tool-list-actions" onClick={e => e.stopPropagation()}>
                    {!isWeb && onOpenFolder && (
                      <Tooltip content="在资源管理器中定位" relationship="label">
                        <button
                          type="button"
                          className="tool-action-btn"
                          onClick={() => onOpenFolder(launcher.id)}
                          aria-label="打开所在目录"
                        >
                          <FolderOpen size={14} />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content="复制路径" relationship="label">
                      <button
                        type="button"
                        className="tool-action-btn"
                        onClick={() => onCopyPath(launcher.path)}
                        aria-label="复制路径"
                      >
                        <Copy size={14} />
                      </button>
                    </Tooltip>
                    <button
                      type="button"
                      className="tool-launch-btn-compact"
                      onClick={() => onLaunch(launcher.id)}
                      aria-label="启动"
                    >
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
