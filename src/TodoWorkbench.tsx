import { useState, useEffect, useRef, useCallback, type FormEvent } from 'react';
import { Button, Checkbox, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider, MenuGroup, MenuGroupHeader, Popover, PopoverTrigger, PopoverSurface } from '@fluentui/react-components';
import { Sparkle, Plus, Trash, Check, SquaresFour, ListBullets, Lightbulb, X, CalendarBlank, CheckSquare, Bell, Notepad, ArrowsOutSimple, MagnifyingGlass, DotsThree, DotsSixVertical, CaretDown, CaretLeft, CaretRight, Clock, ArrowCounterClockwise } from '@phosphor-icons/react';
import { listen } from '@tauri-apps/api/event';
import { api, desktop } from './api';
import type { TodoItem, TodoQuadrant, TodoAiAssistResult } from './types';
import { Empty, IconButton, Modal, Skeleton } from './components';
import { localDate, validSchedule, compareTodos, dateGroup, dateGroups, matchesTimeFilter, scheduleLabel, formatTimestamp, timeFilters, parseScheduleFromText, type TodoTimeFilter } from './todoSchedule';
import { normalizeTodos, matchesTodoSearch, todoQuadrants } from './todoData';
import { useTodoDrag } from './useTodoDrag';
import TodoDetailDrawer from './TodoDetailDrawer';


// 时间管理沿用现有办公主题：录入区设置期限，日期筛选统管两种视图，
// 看板保留轻重缓急，清单按到期分组，逾期优先且旧记录保留为未排期。
export default function TodoWorkbench({ visible, reminderRequest }: { visible: boolean; reminderRequest?: { id: string } | null }) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'matrix' | 'list'>('list');
  const [entryType, setEntryType] = useState<'todo' | 'idea'>('todo');
  const [titleInput, setTitleInput] = useState('');
  const [selectedQuadrant, setSelectedQuadrant] = useState<TodoQuadrant>(0);
  const [listFilter, setListFilter] = useState<'all' | 'todo' | 'idea'>('all');
  const [timeFilter, setTimeFilter] = useState<TodoTimeFilter>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [editing, setEditing] = useState<{ id: string; date: string; time: string } | null>(null);
  const [entryOptionsOpen, setEntryOptionsOpen] = useState(false);
  const [inboxCollapsed, setInboxCollapsed] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [showRecovery, setShowRecovery] = useState(false);
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
  const [maximizedQuadrant, setMaximizedQuadrant] = useState<TodoQuadrant | null>(null);
  const [ignoreParsedSchedule, setIgnoreParsedSchedule] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const saveBusy = useRef(false);
  const handledReminder = useRef<typeof reminderRequest>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const focusAfterAdd = useRef(false);
  const composing = useRef(false);
  const scheduleTrigger = useRef<HTMLButtonElement | null>(null);

  // AI 状态
  const [aiBusy, setAiBusy] = useState(false);
  const [triageResult, setTriageResult] = useState<{ quadrant: TodoQuadrant; reason: string } | null>(null);
  const [focusAdvice, setFocusAdvice] = useState<{ q1Focus?: string; q2Focus?: string; q3Batch?: string; advice?: string } | null>(null);
  const [modalData, setModalData] = useState<{
    target: TodoItem;
    type: 'breakdown' | 'expand';
    items: string[];
    expandDetail?: { scenario: string; tech: string; firstStep: string };
  } | null>(null);

  const isMounted = useRef(true);

  // 加载数据
  const loadTodos = useCallback(async () => {
    try {
      setLoading(true);
      setLoadFailed(false);
      setError('');
      const data = normalizeTodos(await api<unknown>('get_todos'));
      if (isMounted.current) {
        setTodos(data);
      }
    } catch {
      if (isMounted.current) {
        setLoadFailed(true);
        setError('待办读取失败，请重试后再编辑，避免覆盖原有记录。');
      }
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    void loadTodos();
    return () => { isMounted.current = false; };
  }, [loadTodos]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await listen<string | null>('todo-reminder-status', event => {
          if (!cancelled) setReminderError(event.payload);
        });
        if (cancelled) { stop(); return; }
        unlisten = stop;
        const status = await api<string | null>('get_todo_reminder_status');
        if (!cancelled) setReminderError(status);
      } catch {
        if (!cancelled) setReminderError('无法读取提醒状态，请重新打开工作台。');
      }
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [visible]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!selectedDetailId && maximizedQuadrant !== null) {
          setMaximizedQuadrant(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedDetailId, maximizedQuadrant]);

  useEffect(() => {
    if (!saving && visible && focusAfterAdd.current) {
      focusAfterAdd.current = false;
      titleField.current?.focus();
    }
  }, [saving, visible, titleInput]);

  useEffect(() => {
    if (!editing && !saving && scheduleTrigger.current) {
      scheduleTrigger.current.focus();
      scheduleTrigger.current = null;
    }
  }, [editing, saving]);

  // 持久化保存
  const persistTodos = useCallback(async (next: TodoItem[]) => {
    if (saveBusy.current || loading || loadFailed) return false;
    saveBusy.current = true;
    setSaving(true);
    setError('');
    const previous = todos;
    setTodos(next);
    try {
      await api('save_todos', { todos: next });
      return true;
    } catch {
      setTodos(previous);
      setError('保存失败，本次修改未写入。请重试；原有记录已保留。');
      return false;
    } finally {
      saveBusy.current = false;
      setSaving(false);
    }
  }, [todos, loading, loadFailed]);

  // 快速添加（集成自然语言日期与时间自动嗅探）
  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    const rawText = titleInput.trim();
    if (!rawText || composing.current || saveBusy.current || loading || loadFailed) return;

    // 自然语言时间解析提取
    const parsed = parseScheduleFromText(rawText, now);
    const finalDueDate = dueDate || (!ignoreParsedSchedule ? parsed.dueDate : undefined);
    const finalDueTime = dueDate ? dueTime || undefined : !ignoreParsedSchedule ? parsed.dueTime : undefined;
    const finalTitle = dueDate || ignoreParsedSchedule ? rawText : parsed.cleanTitle || rawText;

    if (!validSchedule(finalDueDate || '', finalDueTime || '')) {
      setError('请先选择有效的截止日期，再填写时间。');
      return;
    }

    const newItem: TodoItem = {
      id: crypto.randomUUID(),
      title: finalTitle,
      type: entryType,
      quadrant: entryType === 'idea' ? 0 : selectedQuadrant,
      completed: false,
      createdAt: Date.now(),
      schemaVersion: 2,
      dueDate: finalDueDate,
      dueTime: finalDueTime,
    };

    const next = [newItem, ...todos];
    if (await persistTodos(next)) {
      if (!matchesTimeFilter(newItem, timeFilter, Date.now())) setTimeFilter('active');
      if (listFilter !== 'all' && listFilter !== newItem.type) setListFilter('all');
      if (!matchesTodoSearch(newItem, searchQuery)) setSearchQuery('');
      setTitleInput('');
      setDueDate('');
      setDueTime('');
      setTriageResult(null);
      setSelectedQuadrant(0);
      setIgnoreParsedSchedule(false);
      setEntryOptionsOpen(false);
      focusAfterAdd.current = true;
    }
  };

  const saveSchedule = async () => {
    if (!editing) return;
    if (!validSchedule(editing.date, editing.time)) {
      setError('请先选择有效的截止日期，再填写时间。');
      return;
    }
    const next = todos.map(t => t.id === editing.id ? { ...t, dueDate: editing.date || undefined, dueTime: editing.date && editing.time ? editing.time : undefined } : t);
    if (await persistTodos(next)) setEditing(null);
  };

  const toggleStep = (id: string, stepId: string) => {
    void persistTodos(todos.map(t => t.id === id ? { ...t, subtasks: t.subtasks?.map(s => s.id === stepId ? { ...s, completed: !s.completed } : s) } : t));
  };

  const toggleType = async (id: string) => {
    if (await persistTodos(todos.map(t => t.id === id ? { ...t, type: t.type === 'todo' ? 'idea' : 'todo' } : t))) setListFilter('all');
  };

  // 切换完成状态
  const toggleComplete = (id: string) => {
    const next = todos.map(t => {
      if (t.id !== id) return t;
      return {
        ...t,
        completed: !t.completed,
        completedAt: !t.completed ? Date.now() : undefined
      };
    });
    void persistTodos(next);
  };

  // 移动象限
  const moveQuadrant = (id: string, q: TodoQuadrant) => {
    const target = todos.find(t => t.id === id && t.deletedAt === undefined);
    if (!target || target.quadrant === q) return;
    const next = todos.map(t => (t.id === id ? { ...t, quadrant: q } : t));
    void persistTodos(next);
  };

  // 删除与清理保留原记录，恢复入口在重启后仍然可用。
  const deleteItem = (id: string) => {
    const next = todos.map(t => t.id === id ? { ...t, deletedAt: Date.now() } : t);
    void persistTodos(next);
  };

  // 清除已完成
  const clearCompleted = () => {
    const removedAt = Date.now();
    const next = todos.map(t => t.completed && t.deletedAt === undefined ? { ...t, deletedAt: removedAt } : t);
    void persistTodos(next);
  };

  const restoreItem = async (id: string) => {
    const next = todos.map(t => {
      if (t.id !== id) return t;
      const { deletedAt: _removedAt, ...restored } = t;
      return restored;
    });
    if (await persistTodos(next)) { setTimeFilter('all'); setListFilter('all'); setSearchQuery(''); }
  };

  // AI 智能研判象限
  const handleAiTriage = async () => {
    const text = titleInput.trim();
    if (!text || aiBusy) return;
    setAiBusy(true);
    try {
      const res = await api<TodoAiAssistResult>('todo_ai_assist', {
        action: 'triage',
        text: `${text}${dueDate ? `\n到期安排：${dueDate} ${dueTime || '当天结束前'}；当前本地时间：${formatTimestamp(Date.now())}` : ''}`
      });
      if (res.triage) {
        setTriageResult(res.triage);
      }
    } catch { setError('AI 分类暂不可用，请检查模型配置后重试。'); }
    finally {
      setAiBusy(false);
    }
  };

  // 采纳 AI 象限研判
  const applyTriage = () => {
    if (triageResult) {
      setSelectedQuadrant(triageResult.quadrant);
      setTriageResult(null);
    }
  };

  // AI 任务拆解
  const handleAiBreakdown = async (target: TodoItem) => {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      const res = await api<TodoAiAssistResult>('todo_ai_assist', {
        action: 'breakdown',
        text: target.title
      });
      if (res.breakdown) {
        setModalData({
          target,
          type: 'breakdown',
          items: res.breakdown
        });
      }
    } catch { setError('AI 拆解暂不可用，请检查模型配置后重试。'); }
    finally {
      setAiBusy(false);
    }
  };

  // AI 灵感启发
  const handleAiExpand = async (target: TodoItem) => {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      const res = await api<TodoAiAssistResult>('todo_ai_assist', {
        action: 'expand',
        text: target.title
      });
      if (res.expand) {
        setModalData({
          target,
          type: 'expand',
          items: [],
          expandDetail: res.expand
        });
      }
    } catch { setError('AI 灵感拓展暂不可用，请检查模型配置后重试。'); }
    finally {
      setAiBusy(false);
    }
  };

  // 确认弹窗采纳
  const confirmModalAction = async (selectedSteps: string[]) => {
    if (!modalData) return;
    const { target, type } = modalData;
    let next: TodoItem[];
    if (type === 'breakdown') {
      next = todos.map(t => {
        if (t.id !== target.id) return t;
        const currentSubtasks = t.subtasks || [];
        return {
          ...t,
          subtasks: [...currentSubtasks, ...selectedSteps.map(title => ({ id: crypto.randomUUID(), title, completed: false }))]
        };
      });
    } else {
      next = todos.map(t => {
        if (t.id !== target.id) return t;
        return {
          ...t,
          type: 'todo',
          quadrant: t.quadrant
        };
      });
    }
    if (await persistTodos(next)) setModalData(null);
  };

  // AI 今日聚焦规划
  const handleAiDailyFocus = async () => {
    if (aiBusy) return;
    setAiBusy(true);
    try {
      const currentTime = Date.now();
      const uncompleted = todos.filter(t => t.deletedAt === undefined && !t.completed && t.type === 'todo').sort(compareTodos).map(t =>
        `${t.title}（第${t.quadrant}象限；${scheduleLabel(t, currentTime)}）`);
      const res = await api<TodoAiAssistResult>('todo_ai_assist', {
        action: 'focus',
        items: [`当前本地时间：${formatTimestamp(currentTime)}。优先处理逾期和今天到期事项；后续排期不要当作今天必须完成。`, ...uncompleted]
      });
      if (res.focus) {
        setFocusAdvice(res.focus);
      }
    } catch { setError('AI 聚焦建议暂不可用，请检查模型配置后重试。'); }
    finally {
      setAiBusy(false);
    }
  };

  const currentTodos = todos.filter(t => t.deletedAt === undefined);
  const removedTodos = todos.filter(t => t.deletedAt !== undefined).sort((a, b) => b.deletedAt! - a.deletedAt!);
  const selectedDetailItem = currentTodos.find(t => t.id === selectedDetailId) || null;
  const doneCount = currentTodos.filter(t => t.completed).length;
  const searchItems = currentTodos.filter(t => (listFilter === 'all' || t.type === listFilter) && matchesTodoSearch(t, searchQuery));
  const filteredItems = searchItems.filter(t => matchesTimeFilter(t, timeFilter, now)).sort(compareTodos);
  const inboxItems = filteredItems.filter(t => t.quadrant === 0);
  const mutationDisabled = saving || loading || loadFailed;
  const { drag, start: startDrag, suppressClick: suppressDragClick } = useTodoDrag(moveQuadrant, mutationDisabled, visible && view === 'matrix');
  const draggingId = drag?.id ?? null;
  const dragOverQuadrant = drag?.quadrant ?? null;
  const detectedSchedule = parseScheduleFromText(titleInput, now);
  const entryDate = dueDate || (!ignoreParsedSchedule ? detectedSchedule.dueDate : undefined);
  const entryTime = dueDate ? dueTime : !ignoreParsedSchedule ? detectedSchedule.dueTime : undefined;
  const entryQuadrant = todoQuadrants[entryType === 'idea' ? 0 : selectedQuadrant];
  const entrySummary = [entryDate ? scheduleLabel({ dueDate: entryDate, dueTime: entryTime } as TodoItem, now) : '未排期',
    entryQuadrant.numeral || entryQuadrant.label].join(' · ');
  const filterLabel = timeFilter === 'all' ? '全部记录' : timeFilter === 'active' ? '全部未完成' : timeFilters.find(f => f.value === timeFilter)!.label;
  const hasFilters = searchQuery.trim() || listFilter !== 'all' || timeFilter !== 'active';
  const openDetail = (id: string) => setSelectedDetailId(id);
  const resetFilters = () => { setSearchQuery(''); setListFilter('all'); setTimeFilter('active'); };
  const getDropProps = (q: TodoQuadrant) => ({ 'data-todo-quadrant': q });

  useEffect(() => {
    if (!reminderRequest || handledReminder.current === reminderRequest || !visible || loading || loadFailed || saving) return;
    if (selectedDetailId === reminderRequest.id) { handledReminder.current = reminderRequest; return; }
    // 通知等用户保存或关闭已有草稿后再打开详情。
    if (selectedDetailId || editing || showRecovery || modalData || titleInput.trim() || dueDate || dueTime || triageResult) return;
    handledReminder.current = reminderRequest;
    const target = todos.find(t => t.id === reminderRequest.id && t.deletedAt === undefined);
    if (!target) { setError('提醒中的事项已被移除或不存在。'); return; }
    setSearchQuery('');
    setTimeFilter('all');
    setListFilter('all');
    setMaximizedQuadrant(null);
    setSelectedDetailId(target.id);
  }, [reminderRequest, visible, loading, loadFailed, saving, todos, selectedDetailId, editing, showRecovery, modalData, titleInput, dueDate, dueTime, triageResult]);

  const renderEmpty = (title: string) => <div className="todo-empty">
    <span>{title}</span>
    {hasFilters ? <button type="button" className="todo-text-button" onClick={resetFilters}>清除筛选</button> :
      view === 'list' && <button type="button" className="todo-text-button" onClick={() => titleField.current?.focus()}>记录一件新事项</button>}
  </div>;

  const renderFlowStrip = (currentQ: TodoQuadrant) => <div className="todo-flow-strip">
    <span>拖到目标区域重新归类</span>
    {todoQuadrants.filter(q => q.value !== currentQ).map(q => <button key={q.value} type="button"
      className={'todo-flow-target ' + (dragOverQuadrant === q.value ? 'drag-over' : '')}
      title={q.description} {...getDropProps(q.value)} disabled={mutationDisabled}
      onClick={() => setMaximizedQuadrant(q.value)}>{q.numeral} {q.label}</button>)}
  </div>;

  const renderCard = (t: TodoItem) => {
    const isIdea = t.type === 'idea';
    const steps = t.subtasks || [];
    const stepsExpanded = expandedSteps.has(t.id);
    const group = dateGroup(t, now);
    const quadrant = todoQuadrants[t.quadrant];
    const reminder = t.dueTime && !t.completed ? isIdea ? '灵感不提醒' : '提前 10 分钟提醒' : '';
    return <div key={t.id} data-todo-id={t.id} draggable={false}
      className={'todo-item-card ' + (view === 'list' ? 'todo-list-item ' : 'todo-board-item ') +
        (group === 'overdue' ? 'overdue ' : '') + (t.completed ? 'completed ' : '') + (draggingId === t.id ? 'dragging' : '')}
      onPointerDown={e => { if (view === 'matrix') startDrag(e, t.id); }} onClickCapture={suppressDragClick}>
      <div className="todo-item-main">
        {view === 'matrix' && <span className="todo-drag-handle" title="拖动归类，也可使用更多菜单移动" aria-hidden="true"><DotsSixVertical size={16}/></span>}
        <button type="button" className={'todo-checkbox ' + (t.completed ? 'checked' : '')} disabled={mutationDisabled}
          aria-pressed={t.completed} aria-label={(t.completed ? '标记为未完成：' : '标记为已完成：') + t.title}
          onClick={() => toggleComplete(t.id)}>{t.completed && <Check size={12} weight="bold" aria-hidden="true"/>}</button>
        <div className="todo-item-body">
          <button type="button" className={'todo-item-title ' + (t.completed ? 'completed-text' : '')}
            aria-label={'查看事项详情：' + t.title} onClick={() => openDetail(t.id)}>{t.title}</button>
          <div className="todo-item-meta">
            {isIdea && <span className="todo-idea-tag"><Lightbulb size={13} aria-hidden="true"/>灵感</span>}
            <button type="button" className={'todo-date-chip ' + (t.completed ? '' : 'is-' + group)} disabled={mutationDisabled}
              aria-label={'调整排期：' + t.title + '，' + scheduleLabel(t, now) + (reminder ? '，' + reminder : '')}
              title={reminder || '点击调整排期'}
              onClick={e => { scheduleTrigger.current = e.currentTarget; setEditing(editing?.id === t.id ? null : { id: t.id, date: t.dueDate || '', time: t.dueTime || '' }); }}>
              {group === 'overdue' ? <Clock size={13} aria-hidden="true"/> : <CalendarBlank size={13} aria-hidden="true"/>}
              {scheduleLabel(t, now)}{t.dueTime && !isIdea && !t.completed && <Bell size={12} aria-hidden="true"/>}
            </button>
            {view === 'list' && <span className={'todo-quadrant-tag q' + t.quadrant} title={quadrant.description}>
              {quadrant.numeral && <span aria-hidden="true">{quadrant.numeral}</span>}{quadrant.label}
            </span>}
            {steps.length > 0 && <button type="button" className="todo-step-toggle" aria-expanded={stepsExpanded}
              aria-controls={'todo-steps-' + t.id} aria-label={'展开或收起步骤：' + t.title}
              onClick={() => setExpandedSteps(previous => { const next = new Set(previous); if (next.has(t.id)) next.delete(t.id); else next.add(t.id); return next; })}>
              <ListBullets size={13} aria-hidden="true"/>{steps.filter(s => s.completed).length}/{steps.length}
              <CaretDown size={11} className={stepsExpanded ? 'expanded' : ''} aria-hidden="true"/>
            </button>}
            {t.notes && <button type="button" className="todo-notes-trigger" aria-label={'查看备忘：' + t.title}
              onClick={() => openDetail(t.id)}><Notepad size={14} aria-hidden="true"/><span className="sr-only">备忘</span></button>}
            {t.completedAt && t.completed && <span className="todo-record-time">完成于 {formatTimestamp(t.completedAt)}</span>}
          </div>
        </div>
        <Menu positioning="below-end">
          <MenuTrigger disableButtonEnhancement><button type="button" className="todo-icon-button todo-more-trigger"
            aria-label={'更多事项操作：' + t.title} disabled={mutationDisabled}><DotsThree size={20} weight="bold" aria-hidden="true"/></button></MenuTrigger>
          <MenuPopover><MenuList>
            <MenuItem icon={<Notepad/>} onClick={() => openDetail(t.id)}>编辑详情与步骤</MenuItem>
            <MenuGroup><MenuGroupHeader>移到</MenuGroupHeader>
              {todoQuadrants.filter(q => q.value !== t.quadrant).map(q => <MenuItem key={q.value}
                onClick={() => moveQuadrant(t.id, q.value)}>{q.numeral} {q.label}</MenuItem>)}
            </MenuGroup>
            <MenuDivider/>
            <MenuItem icon={isIdea ? <CheckSquare/> : <Lightbulb/>} onClick={() => void toggleType(t.id)}>{isIdea ? '转为待办' : '转为灵感'}</MenuItem>
            <MenuItem icon={<Sparkle/>} disabled={aiBusy} onClick={() => void (isIdea ? handleAiExpand(t) : handleAiBreakdown(t))}>
              {isIdea ? 'AI 灵感拓展' : 'AI 拆解步骤'}</MenuItem>
            <MenuDivider/>
            <MenuItem icon={<Trash/>} onClick={() => deleteItem(t.id)}>删除事项</MenuItem>
          </MenuList></MenuPopover>
        </Menu>
      </div>
      {editing?.id === t.id && <form className="todo-date-editor" aria-label={'排期：' + t.title}
        onSubmit={e => { e.preventDefault(); void saveSchedule(); }}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (!saving) setEditing(null); } }}>
        <div className="todo-date-fields">
          <label>截止日期<input type="date" value={editing.date} disabled={saving}
            onChange={e => setEditing({ ...editing, date: e.target.value, time: e.target.value ? editing.time : '' })}/></label>
          <label>时间（可选）<input type="time" value={editing.time} disabled={!editing.date || saving}
            onChange={e => setEditing({ ...editing, time: e.target.value })}/></label>
        </div>
        <div className="todo-date-shortcuts">
          <button type="button" disabled={saving} onClick={() => setEditing({ ...editing, date: localDate(now) })}>今天</button>
          <button type="button" disabled={saving} onClick={() => setEditing({ ...editing, date: localDate(now, 1) })}>明天</button>
          <button type="button" disabled={saving} onClick={() => setEditing({ ...editing, date: '', time: '' })}>清除排期</button>
          <Button type="submit" size="small" appearance="primary" disabled={saving}>保存排期</Button>
          <Button type="button" size="small" disabled={saving} onClick={() => setEditing(null)}>取消</Button>
        </div>
        <small>{isIdea ? '灵感保留排期，不发送提醒。' : '设置具体时间后，桌面版提前 10 分钟提醒；只填日期，按当天结束前到期。'}</small>
      </form>}
      {stepsExpanded && steps.length > 0 && <div className="todo-subtasks" id={'todo-steps-' + t.id}>
        {steps.map(step => <label key={step.id} className="todo-subtask-row">
          <input type="checkbox" checked={step.completed} disabled={mutationDisabled} onChange={() => toggleStep(t.id, step.id)}/>
          <span className={step.completed ? 'completed-text' : ''}>{step.title}</span>
        </label>)}
        <button type="button" className="todo-text-button" onClick={() => openDetail(t.id)}>编辑或添加步骤</button>
      </div>}
    </div>;
  };

  return <div className={'todo-workbench-page ' + (draggingId ? 'is-dragging-active' : '')} hidden={!visible}>
    <div className="page-heading todo-heading">
      <div className="todo-heading-title"><h1>待办事项</h1>
        <time dateTime={localDate(now)}>{new Date(now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time>
      </div>
      <div className="todo-heading-controls">
        <Button appearance="subtle" size="small" className="ai-focus-trigger" icon={<Sparkle/>}
          disabled={aiBusy || mutationDisabled || !currentTodos.some(t => !t.completed && t.type === 'todo')}
          onClick={() => void handleAiDailyFocus()}>{aiBusy ? 'AI 处理中…' : 'AI 聚焦建议'}</Button>
        <div className="view-switch-group" role="group" aria-label="待办视图">
          <button type="button" className={'view-btn ' + (view === 'list' ? 'active' : '')} aria-pressed={view === 'list'}
            onClick={() => { setView('list'); setMaximizedQuadrant(null); }}><ListBullets size={16} aria-hidden="true"/>清单</button>
          <button type="button" className={'view-btn ' + (view === 'matrix' ? 'active' : '')} aria-pressed={view === 'matrix'}
            onClick={() => setView('matrix')}><SquaresFour size={16} aria-hidden="true"/>四象限</button>
        </div>
        <Popover positioning="below-end" withArrow>
          <PopoverTrigger disableButtonEnhancement><button type="button" className="todo-icon-button" aria-label="提醒说明"><Bell size={18} aria-hidden="true"/></button></PopoverTrigger>
          <PopoverSurface><div className="todo-reminder-help"><strong>到期提醒</strong>
            <p>{desktop ? '待办设置具体日期和时间后，Windows 会在到期前 10 分钟通知。关闭窗口后，应用在托盘继续运行；托盘“退出”后停止提醒。' : '桌面版的待办可在具体到期时间前 10 分钟通过 Windows 提醒。'}</p>
            <p>只填日期，按当天结束前到期；灵感保留排期，不发送提醒。</p>
          </div></PopoverSurface>
        </Popover>
        <Menu positioning="below-end">
          <MenuTrigger disableButtonEnhancement><button type="button" className={'todo-icon-button ' + (timeFilter === 'all' ? 'active' : '')}
            aria-label="更多待办操作"><DotsThree size={20} weight="bold" aria-hidden="true"/></button></MenuTrigger>
          <MenuPopover><MenuList>
            <MenuItem onClick={() => setTimeFilter('all')}>全部记录（{searchItems.length}）</MenuItem>
            <MenuItem icon={<ArrowCounterClockwise/>} onClick={() => setShowRecovery(true)}>恢复已移除（{removedTodos.length}）</MenuItem>
            <MenuDivider/>
            <MenuItem icon={<Trash/>} disabled={mutationDisabled || !doneCount} onClick={clearCompleted}>清理全部已完成（{doneCount}）</MenuItem>
          </MenuList></MenuPopover>
        </Menu>
      </div>
    </div>

    {error && <div className="inline-error todo-error" role="alert">{error}
      {loadFailed && <Button size="small" onClick={() => void loadTodos()}>重新读取</Button>}
      {!loadFailed && <IconButton label="关闭错误提示" onClick={() => setError('')}><X size={14}/></IconButton>}
    </div>}
    {reminderError && <div className="todo-reminder-error" role="alert"><Bell size={15} aria-hidden="true"/>提醒暂不可用：{reminderError}</div>}

    <div className="todo-input-bar">
      <form onSubmit={e => void handleAdd(e)} className="todo-add-form" aria-label="新增事项"
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={e => {
          if (e.key !== 'Enter') return;
          if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.repeat || mutationDisabled || saveBusy.current) { e.preventDefault(); return; }
          if (!e.altKey && !e.shiftKey && !e.metaKey && (e.ctrlKey || e.target === titleField.current)) {
            e.preventDefault(); if (titleInput.trim()) e.currentTarget.requestSubmit();
          }
        }}>
        <div className="todo-entry-main">
          <button type="button" className="entry-type-toggle" disabled={mutationDisabled}
            aria-label="切换录入类型" title="切换待办或灵感" onClick={() => setEntryType(t => t === 'todo' ? 'idea' : 'todo')}>
            {entryType === 'todo' ? <CheckSquare size={17} aria-hidden="true"/> : <Lightbulb size={17} aria-hidden="true"/>}
            {entryType === 'todo' ? '待办' : '灵感'}
          </button>
          <label htmlFor="todo-new-title" className="sr-only">事项标题</label>
          <input ref={titleField} id="todo-new-title" type="text" value={titleInput} disabled={mutationDisabled}
            onChange={e => { setTitleInput(e.target.value); setIgnoreParsedSchedule(false); }}
            placeholder={entryType === 'todo' ? '记录一件待办，例如「明天 10 点开会」' : '捕捉一个想法，稍后再整理'}
            className="todo-main-input" aria-describedby="todo-entry-shortcut"/>
          <button type="button" className={'todo-entry-options-trigger ' + (entryOptionsOpen ? 'active' : '')}
            aria-label="排期与归类" aria-expanded={entryOptionsOpen} aria-controls="todo-entry-options"
            title={entrySummary} disabled={mutationDisabled} onClick={() => setEntryOptionsOpen(open => !open)}>
            <CalendarBlank size={15} aria-hidden="true"/><span>{entrySummary}</span><CaretDown size={12} aria-hidden="true"/>
          </button>
          <span id="todo-entry-shortcut" className="todo-entry-shortcut">Ctrl+Enter</span>
          <Button appearance="primary" size="small" type="submit" disabled={mutationDisabled || !titleInput.trim()} icon={<Plus size={16}/>}>
            {saving ? '保存中' : '添加'}
          </Button>
        </div>
        {entryOptionsOpen && <div id="todo-entry-options" className="todo-entry-options">
          <div className="todo-entry-schedule">
            <label>截止日期<input type="date" value={dueDate} disabled={mutationDisabled}
              onChange={e => { setDueDate(e.target.value); if (!e.target.value) setDueTime(''); }}/></label>
            <label>时间（可选）<input type="time" value={dueTime} disabled={!dueDate || mutationDisabled}
              onChange={e => setDueTime(e.target.value)}/></label>
            <div className="todo-date-shortcuts">
              <button type="button" disabled={mutationDisabled} onClick={() => setDueDate(localDate(now))}>今天</button>
              <button type="button" disabled={mutationDisabled} onClick={() => setDueDate(localDate(now, 1))}>明天</button>
              {dueDate && <button type="button" disabled={mutationDisabled} onClick={() => { setDueDate(''); setDueTime(''); }}>清除排期</button>}
            </div>
          </div>
          <div className="todo-entry-classify">
            {entryType === 'todo' ? <label>归类<select value={selectedQuadrant} disabled={mutationDisabled}
              onChange={e => setSelectedQuadrant(Number(e.target.value) as TodoQuadrant)}>
              {todoQuadrants.map(q => <option value={q.value} key={q.value}>{q.numeral} {q.label}{q.value ? ' · ' + q.description : ''}</option>)}
            </select></label> : <span>灵感先放入收集箱，随时可通过更多菜单归类。</span>}
            {entryType === 'todo' && <Button type="button" size="small" appearance="subtle" icon={<Sparkle/>}
              disabled={aiBusy || mutationDisabled || !titleInput.trim()} onClick={() => void handleAiTriage()}>AI 分类</Button>}
          </div>
          <span className="todo-schedule-hint">{entryType === 'idea' ? '灵感保留排期，不发送提醒。' : dueDate ? '只填日期按当天结束前到期，具体时间提前 10 分钟提醒。' : '不填日期存为未排期，也可直接在标题中输入时间。'}</span>
        </div>}
      </form>
      {!dueDate && !ignoreParsedSchedule && detectedSchedule.dueDate && <div className="todo-parsed-schedule" role="status">
        <CalendarBlank size={14} aria-hidden="true"/><span>已识别：{detectedSchedule.dueDate} {detectedSchedule.dueTime || '当天结束前'}</span>
        <button type="button" className="todo-text-button" disabled={mutationDisabled} onClick={() => setIgnoreParsedSchedule(true)}>忽略识别</button>
      </div>}
      {triageResult && <div className="ai-triage-balloon">
        <Sparkle size={15} aria-hidden="true"/><span>{triageResult.reason}</span>
        <Button appearance="primary" size="small" disabled={mutationDisabled} onClick={applyTriage}>采纳分类</Button>
        <IconButton label="关闭分类建议" onClick={() => setTriageResult(null)}><X size={14}/></IconButton>
      </div>}
    </div>

    <div className="todo-time-toolbar">
      <label className="todo-search-field"><MagnifyingGlass size={16} aria-hidden="true"/>
        <input id="todo-search" aria-label="待办搜索" placeholder="搜索事项、备忘或步骤" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}/>
        {searchQuery && <IconButton label="清除待办搜索" onClick={() => setSearchQuery('')}><X size={13}/></IconButton>}
      </label>
      <div className="todo-time-filters" role="group" aria-label="按到期时间筛选">
        {timeFilters.map(filter => <button type="button" key={filter.value} aria-pressed={timeFilter === filter.value}
          className={timeFilter === filter.value ? 'active' : ''} onClick={() => setTimeFilter(filter.value)}>
          {filter.label}<span>{searchItems.filter(t => matchesTimeFilter(t, filter.value, now)).length}</span>
        </button>)}
      </div>
      <label className="todo-type-filter"><span className="sr-only">事项类型</span><select aria-label="事项类型" value={listFilter}
        onChange={e => setListFilter(e.target.value as 'all' | 'todo' | 'idea')}>
        <option value="all">全部类型</option><option value="todo">仅待办</option><option value="idea">仅灵感</option>
      </select></label>
      {saving && <span role="status" className="todo-save-status">正在保存…</span>}
    </div>

    {focusAdvice && <div className="ai-focus-panel">
      <div className="ai-focus-head"><div className="ai-focus-title"><Sparkle size={16} aria-hidden="true"/><strong>今日聚焦建议</strong></div>
        <IconButton label="关闭聚焦建议" onClick={() => setFocusAdvice(null)}><X size={14}/></IconButton>
      </div>
      {focusAdvice.advice && <p className="ai-focus-summary">{focusAdvice.advice}</p>}
      <div className="ai-focus-grid">
        <div><strong>优先处理</strong><p>{focusAdvice.q1Focus || '先处理逾期与今天到期的重要事项。'}</p></div>
        <div><strong>重点推进</strong><p>{focusAdvice.q2Focus || '为重要目标留出明确的推进时间。'}</p></div>
        <div><strong>集中响应</strong><p>{focusAdvice.q3Batch || '按截止时间集中处理协作事务。'}</p></div>
      </div>
    </div>}

    {showRecovery && <Modal title="恢复已移除事项" onClose={() => setShowRecovery(false)}>
      <p>恢复后保留原日期、象限、步骤和备忘；未完成待办恢复原有提醒安排。</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="todo-recovery-list">{removedTodos.length ? removedTodos.map(t => <div className="todo-recovery-item" key={t.id}>
        <div><strong>{t.title}</strong><small>{t.completed ? '已完成' : t.type === 'idea' ? '灵感' : '待办'} · 移除于 {formatTimestamp(t.deletedAt!)}</small></div>
        <Button size="small" disabled={mutationDisabled} onClick={() => void restoreItem(t.id)} aria-label={'恢复事项：' + t.title}>恢复</Button>
      </div>) : <Empty title="没有待恢复的事项"/>}</div>
    </Modal>}

    {loading ? <Skeleton/> : view === 'list' ? <section className="panel todo-list-panel" aria-label="待办清单">
      <div className="todo-list-heading"><div><ListBullets size={16} aria-hidden="true"/><h2>{filterLabel}</h2><span>{filteredItems.length} 项</span></div>
        <span className="todo-list-sort">按到期时间排列</span>
      </div>
      <div className="todo-linear-scroll">
        {!filteredItems.length ? renderEmpty(loadFailed ? '读取后即可查看事项' : hasFilters ? '没有匹配的事项' : '未完成事项已清空') :
          dateGroups.map(group => {
            const items = filteredItems.filter(t => dateGroup(t, now) === group.value);
            return items.length ? <section className={'todo-date-group ' + group.value} aria-label={group.label} key={group.value}>
              <h3>{group.label}<span>{items.length}</span></h3>{items.map(renderCard)}
            </section> : null;
          })}
      </div>
    </section> : <div className={'todo-matrix-layout ' + (maximizedQuadrant !== null ? 'has-maximized ' : '') + (inboxCollapsed ? 'inbox-collapsed' : '')}>
      {(maximizedQuadrant === null || maximizedQuadrant === 0) && <section aria-label="闪念与收集箱" {...getDropProps(0)}
        className={'panel todo-inbox-panel ' + (maximizedQuadrant === 0 ? 'maximized ' : '') + (dragOverQuadrant === 0 ? 'drag-over' : '')}>
        {inboxCollapsed && maximizedQuadrant === null ? <button type="button" className="todo-inbox-rail" aria-label="展开收集箱" onClick={() => setInboxCollapsed(false)}>
          <Lightbulb size={19} aria-hidden="true"/><span>收集箱</span><b>{inboxItems.length}</b><CaretRight size={16} aria-hidden="true"/>
        </button> : <>
          <div className="todo-panel-heading"><div><Lightbulb size={17} aria-hidden="true"/><h2>收集箱</h2><span>{inboxItems.length}</span></div>
            <div className="todo-panel-actions">
              {maximizedQuadrant === null && <button type="button" className="todo-icon-button" aria-label="收起收集箱" onClick={() => setInboxCollapsed(true)}><CaretLeft size={15} aria-hidden="true"/></button>}
              <button type="button" className="todo-icon-button" aria-label={maximizedQuadrant === 0 ? '还原看板' : '聚焦收集箱'}
                onClick={() => setMaximizedQuadrant(maximizedQuadrant === 0 ? null : 0)}><ArrowsOutSimple size={15} aria-hidden="true"/></button>
            </div>
          </div>
          <p className="todo-inbox-caption">待办与灵感，稍后再归类</p>
          {maximizedQuadrant === 0 && renderFlowStrip(0)}
          <div className="todo-card-scroll" {...getDropProps(0)}>{inboxItems.length ? inboxItems.map(renderCard) : renderEmpty('随时记录，稍后归类')}</div>
        </>}
      </section>}
      {maximizedQuadrant !== 0 && <div className={'todo-matrix-grid ' + (maximizedQuadrant !== null ? 'has-maximized' : '')}>
        {todoQuadrants.slice(1).filter(q => maximizedQuadrant === null || maximizedQuadrant === q.value).map(q => {
          const items = filteredItems.filter(t => t.quadrant === q.value);
          return <section key={q.value} aria-label={q.label + '，' + q.description} {...getDropProps(q.value)}
            className={'panel quadrant-panel q' + q.value + (maximizedQuadrant === q.value ? ' maximized' : '') + (dragOverQuadrant === q.value ? ' drag-over' : '')}>
            <div className="todo-panel-heading"><div className="todo-quadrant-heading">
              <h2><span className={'q-dot q' + q.value} aria-hidden="true"/>{q.numeral} {q.label}<span className="todo-panel-count">{items.length}</span></h2>
              <p>{q.description}</p>
            </div>
              <button type="button" className="todo-icon-button" aria-label={maximizedQuadrant === q.value ? '还原看板' : '聚焦' + q.label}
                onClick={() => setMaximizedQuadrant(maximizedQuadrant === q.value ? null : q.value)}><ArrowsOutSimple size={15} aria-hidden="true"/></button>
            </div>
            {maximizedQuadrant === q.value && renderFlowStrip(q.value)}
            <div className="todo-card-scroll" {...getDropProps(q.value)}>{items.length ? items.map(renderCard) : renderEmpty('暂无事项，可拖入或在录入时归类')}</div>
          </section>;
        })}
      </div>}
    </div>}

      {/* AI 模态弹窗：微行动拆解与灵感启发 (统一使用原生 Modal 组件) */}
      {modalData && (
        <Modal
          title={modalData.type === 'breakdown' ? `✨ AI 任务智能微拆解：${modalData.target.title}` : `✨ AI 灵感落地思路：${modalData.target.title}`}
          onClose={() => setModalData(null)}
        >
          {modalData.type === 'breakdown' ? (
            <div className="ai-breakdown-modal">
              <p className="modal-lead">AI 建议将此大任务化整为零，拆分为可在短时间内完成的微行动：</p>
              <div className="breakdown-list">
                {modalData.items.map((step, idx) => (
                  <label key={idx} className="breakdown-item">
                    <Checkbox defaultChecked id={`step-${idx}`}/>
                    <span>{step}</span>
                  </label>
                ))}
              </div>
              <div className="dialog-actions">
                <Button onClick={() => setModalData(null)}>取消</Button>
                <Button
                  appearance="primary"
                  disabled={mutationDisabled}
                  onClick={() => {
                    const checkedSteps = modalData.items.filter((_, i) => {
                      const input = document.getElementById(`step-${i}`) as HTMLInputElement | null;
                      return input ? input.checked : true;
                    });
                    void confirmModalAction(checkedSteps);
                  }}
                >
                  写入子行动清单
                </Button>
              </div>
            </div>
          ) : (
            <div className="ai-expand-modal">
              <p className="modal-lead">根据你的灵感闪念，AI 梳理了以下落地切入点：</p>
              {modalData.expandDetail && (
                <div className="expand-cards">
                  <div className="expand-card">
                    <strong>1. 核心应用场景</strong>
                    <p>{modalData.expandDetail.scenario}</p>
                  </div>
                  <div className="expand-card">
                    <strong>2. 极简技术实现</strong>
                    <p>{modalData.expandDetail.tech}</p>
                  </div>
                  <div className="expand-card">
                    <strong>3. 第一步尝试</strong>
                    <p>{modalData.expandDetail.firstStep}</p>
                  </div>
                </div>
              )}
              <div className="dialog-actions">
                <Button onClick={() => setModalData(null)}>关闭</Button>
                <Button appearance="primary" disabled={mutationDisabled} onClick={() => void confirmModalAction([])}>
                  转为待办（保留原安排）
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}

    {drag && <div className="todo-drag-preview" aria-hidden="true" style={{ left: drag.x + 12, top: drag.y + 12 }}>
      {todos.find(t => t.id === drag.id)?.title} · {drag.quadrant === null ? '移到目标象限后松开' : '松开移入目标象限'}
    </div>}
    {selectedDetailItem && <TodoDetailDrawer key={selectedDetailItem.id} item={selectedDetailItem} saving={saving}
      onClose={() => setSelectedDetailId(null)} onSave={item => persistTodos(todos.map(t => t.id === item.id ? item : t))}
      onDelete={async () => { const ok = await persistTodos(todos.map(t => t.id === selectedDetailItem.id ? { ...t, deletedAt: Date.now() } : t)); if (ok) setSelectedDetailId(null); return ok; }}/>}
  </div>;
}
