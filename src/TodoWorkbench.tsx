import { useState, useEffect, useRef, useCallback, type FormEvent } from 'react';
import { Button, Checkbox } from '@fluentui/react-components';
import { Sparkle, Plus, Trash, Check, SquaresFour, ListBullets, Lightbulb, X, CalendarBlank, CheckSquare, Bell, Notepad, ArrowsOutSimple, MagnifyingGlass } from '@phosphor-icons/react';
import { listen } from '@tauri-apps/api/event';
import { api, desktop } from './api';
import type { TodoItem, TodoQuadrant, TodoAiAssistResult } from './types';
import { Empty, IconButton, Modal, Skeleton } from './components';
import { localDate, validSchedule, compareTodos, dateGroup, dateGroups, matchesTimeFilter, scheduleLabel, formatTimestamp, timeFilters, parseScheduleFromText, type TodoTimeFilter } from './todoSchedule';
import { normalizeTodos, matchesTodoSearch } from './todoData';
import { useTodoDrag } from './useTodoDrag';
import TodoDetailDrawer from './TodoDetailDrawer';


// 时间管理沿用现有办公主题：录入区设置期限，日期筛选统管两种视图，
// 看板保留轻重缓急，清单按到期分组，逾期优先且旧记录保留为未排期。
export default function TodoWorkbench({ visible, reminderRequest }: { visible: boolean; reminderRequest?: { id: string } | null }) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'matrix' | 'list'>('matrix');
  const [entryType, setEntryType] = useState<'todo' | 'idea'>('todo');
  const [titleInput, setTitleInput] = useState('');
  const [selectedQuadrant, setSelectedQuadrant] = useState<TodoQuadrant>(0);
  const [listFilter, setListFilter] = useState<'all' | 'todo' | 'idea'>('all');
  const [timeFilter, setTimeFilter] = useState<TodoTimeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [editing, setEditing] = useState<{ id: string; date: string; time: string } | null>(null);
  const [textEditor, setTextEditor] = useState<{ id: string; stepId?: string; text: string } | null>(null);
  const [stepDraft, setStepDraft] = useState<{ id: string; text: string } | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [showRecovery, setShowRecovery] = useState(false);
  const [selectedDetailId, setSelectedDetailId] = useState<string | null>(null);
  const [maximizedQuadrant, setMaximizedQuadrant] = useState<TodoQuadrant | null>(null);
  const [detailTitleDraft, setDetailTitleDraft] = useState<string | undefined>();
  const [ignoreParsedSchedule, setIgnoreParsedSchedule] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const saveBusy = useRef(false);
  const handledReminder = useRef<typeof reminderRequest>(null);

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
    if (!rawText) return;

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
      if (!matchesTimeFilter(newItem, timeFilter, Date.now())) setTimeFilter('all');
      if (listFilter !== 'all' && listFilter !== newItem.type) setListFilter('all');
      if (!matchesTodoSearch(newItem, searchQuery)) setSearchQuery('');
      setTitleInput('');
      setDueDate('');
      setDueTime('');
      setTriageResult(null);
      setSelectedQuadrant(0);
      setIgnoreParsedSchedule(false);
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

  const saveText = async () => {
    if (!textEditor) return;
    const title = textEditor.text.trim();
    if (!title) { setError('内容不能为空，请填写后保存。'); return; }
    const next = todos.map(t => t.id !== textEditor.id ? t : textEditor.stepId
      ? { ...t, subtasks: t.subtasks?.map(s => s.id === textEditor.stepId ? { ...s, title } : s) }
      : { ...t, title });
    if (await persistTodos(next)) setTextEditor(null);
  };

  const addStep = async () => {
    if (!stepDraft) return;
    const title = stepDraft.text.trim();
    if (!title) { setError('步骤内容不能为空。'); return; }
    const next = todos.map(t => t.id === stepDraft.id ? {
      ...t, subtasks: [...(t.subtasks || []), { id: crypto.randomUUID(), title, completed: false }]
    } : t);
    if (await persistTodos(next)) setStepDraft(null);
  };

  const toggleStep = (id: string, stepId: string) => {
    void persistTodos(todos.map(t => t.id === id ? { ...t, subtasks: t.subtasks?.map(s => s.id === stepId ? { ...s, completed: !s.completed } : s) } : t));
  };

  const deleteStep = (id: string, stepId: string) => {
    void persistTodos(todos.map(t => t.id === id ? { ...t, subtasks: t.subtasks?.filter(s => s.id !== stepId) } : t));
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
    if (await persistTodos(next)) { setTimeFilter('all'); setListFilter('all'); }
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
    } catch {}
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
    } catch {}
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
    } catch {}
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
    } catch {}
    finally {
      setAiBusy(false);
    }
  };

  // 统计数值
  const currentTodos = todos.filter(t => t.deletedAt === undefined);
  const removedTodos = todos.filter(t => t.deletedAt !== undefined).sort((a, b) => b.deletedAt! - a.deletedAt!);
  const selectedDetailItem = todos.find(t => t.id === selectedDetailId && t.deletedAt === undefined) || null;
  const activeCount = currentTodos.filter(t => !t.completed).length;
  const doneCount = currentTodos.filter(t => t.completed).length;
  const sparkCount = currentTodos.filter(t => t.type === 'idea').length;

  const scheduledItems = currentTodos.filter(t => matchesTimeFilter(t, timeFilter, now) && matchesTodoSearch(t, searchQuery)).sort(compareTodos);
  const inboxItems = scheduledItems.filter(t => t.quadrant === 0);
  const q1Items = scheduledItems.filter(t => t.quadrant === 1);
  const q2Items = scheduledItems.filter(t => t.quadrant === 2);
  const q3Items = scheduledItems.filter(t => t.quadrant === 3);
  const q4Items = scheduledItems.filter(t => t.quadrant === 4);

  // 线性列表筛选
  const filteredList = scheduledItems.filter(t => listFilter === 'all' || t.type === listFilter);
  const mutationDisabled = saving || loading || loadFailed;
  const { drag, start: startDrag, suppressClick: suppressDragClick } = useTodoDrag(moveQuadrant, mutationDisabled, visible);
  const draggingId = drag?.id ?? null;
  const dragOverQuadrant = drag?.quadrant ?? null;
  const detectedSchedule = parseScheduleFromText(titleInput, now);
  const openDetail = (id: string, title?: string) => { setDetailTitleDraft(title); setSelectedDetailId(id); };

  useEffect(() => {
    if (!reminderRequest || handledReminder.current === reminderRequest || !visible || loading || loadFailed || saving) return;
    if (selectedDetailId === reminderRequest.id) { handledReminder.current = reminderRequest; return; }
    // 先让用户保存或关闭现有编辑，避免通知覆盖详情、行内标题或步骤草稿。
    if (selectedDetailId || textEditor || stepDraft || editing || showRecovery || modalData || titleInput.trim() || dueDate || dueTime || triageResult) return;
    handledReminder.current = reminderRequest;
    const target = todos.find(t => t.id === reminderRequest.id && t.deletedAt === undefined);
    if (!target) { setError('提醒中的事项已被移除或不存在。'); return; }
    setSearchQuery('');
    setTimeFilter('all');
    setListFilter('all');
    setMaximizedQuadrant(null);
    setDetailTitleDraft(undefined);
    setSelectedDetailId(target.id);
  }, [reminderRequest, visible, loading, loadFailed, saving, todos, selectedDetailId, textEditor, stepDraft, editing, showRecovery, modalData, titleInput, dueDate, dueTime, triageResult]);

  const DragHandle = () => (
    <span className="todo-drag-handle" title="按住拖拽以快速移动至其他象限" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
        <circle cx="5" cy="3.5" r="1.5"/>
        <circle cx="11" cy="3.5" r="1.5"/>
        <circle cx="5" cy="8" r="1.5"/>
        <circle cx="11" cy="8" r="1.5"/>
        <circle cx="5" cy="12.5" r="1.5"/>
        <circle cx="11" cy="12.5" r="1.5"/>
      </svg>
    </span>
  );

  const renderTextEditor = () => textEditor && (
    <form className="todo-text-editor" aria-label={textEditor.stepId ? '修改步骤内容' : '修改事项标题'}
      onSubmit={e => { e.preventDefault(); void saveText(); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (!saving) setTextEditor(null); } }}>
      <textarea
        aria-label={textEditor.stepId ? '步骤内容' : '标题内容'}
        value={textEditor.text}
        autoFocus
        rows={textEditor.stepId ? 2 : 3}
        disabled={mutationDisabled}
        placeholder="输入详细内容，支持按 Enter 快速保存，Shift+Enter 换行…"
        onChange={e => setTextEditor({ ...textEditor, text: e.target.value })}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            void saveText();
          }
        }}
      />
      <div className="todo-text-editor-actions">
        {!textEditor.stepId ? (
          <button
            type="button"
            className="todo-text-editor-more"
            title="打开右侧详情大抽屉，编辑长备忘录、排期与完整分步推进清单"
            onClick={() => {
              const targetId = textEditor.id;
              setTextEditor(null);
              openDetail(targetId, textEditor.text);
            }}
          >
            <Notepad size={13}/>
            <span>打开右侧大抽屉完整编辑…</span>
          </button>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Enter 保存，Esc 取消</span>
        )}
        <div className="todo-text-editor-btns">
          <Button size="small" appearance="primary" type="submit" disabled={mutationDisabled}>保存</Button>
          <Button size="small" type="button" disabled={saving} onClick={() => setTextEditor(null)}>取消</Button>
        </div>
      </div>
    </form>
  );

  const getDropProps = (q: TodoQuadrant) => ({ 'data-todo-quadrant': q });

  const renderFlowStrip = (currentQ: TodoQuadrant) => (
    <div className="todo-flow-strip">
      <span>💡 拖拽卡片至右侧胶囊，可跨象限快速流转：</span>
      {([
        { q: 0 as TodoQuadrant, label: '📥 收集箱' },
        { q: 1 as TodoQuadrant, label: '🔥 Ⅰ 马上执行' },
        { q: 2 as TodoQuadrant, label: '🌱 Ⅱ 重点聚焦' },
        { q: 3 as TodoQuadrant, label: '⚡ Ⅲ 快速响应' },
        { q: 4 as TodoQuadrant, label: '☕ Ⅳ 闲暇清理' }
      ]).filter(target => target.q !== currentQ).map(target => (
        <span
          key={target.q}
          className={`todo-flow-target ${dragOverQuadrant === target.q ? 'drag-over' : ''}`}
          {...getDropProps(target.q)}
        >
          {target.label}
        </span>
      ))}
    </div>
  );

  // 单张卡片渲染（统一高质感排版，胶囊徽章与拖拽支持）
  const renderCard = (t: TodoItem) => {
    const isIdea = t.type === 'idea';
    const steps = t.subtasks || [];
    const stepsExpanded = expandedSteps.has(t.id);
    const visibleSteps = stepsExpanded ? steps : steps.slice(0, 2);
    const group = dateGroup(t, now);
    const isDragging = draggingId === t.id;

    return (
      <div
        className={`todo-item-card ${group === 'overdue' ? 'overdue' : ''} ${t.completed ? 'completed' : ''} ${isDragging ? 'dragging' : ''}`}
        key={t.id}
        data-todo-id={t.id}
        draggable={false}
        onPointerDown={e => { if (textEditor?.id !== t.id) startDrag(e, t.id); }}
        onClickCapture={suppressDragClick}
      >
        <div className="todo-item-main">
          {/* 专属拖拽六点把手 */}
          <DragHandle/>

          <button
            type="button"
            className={`todo-checkbox ${t.completed ? 'checked' : ''}`}
            onClick={() => toggleComplete(t.id)}
            disabled={mutationDisabled}
            aria-pressed={t.completed}
            title={t.completed ? '已完成，点击恢复待办' : '标记为已完成'}
            aria-label={t.completed ? '标记为未完成' : '标记为已完成'}
          >
            {t.completed && <Check size={12} weight="bold" aria-hidden="true"/>}
          </button>

          <div className="todo-item-body">
            <div className="todo-item-title-row">
              {isIdea && <span className="idea-tag"><Lightbulb size={11} weight="fill"/>灵感</span>}
              {textEditor?.id === t.id && !textEditor.stepId ? renderTextEditor() : <>
                <span
                  className={`todo-item-title ${t.completed ? 'completed-text' : ''}`}
                  title="双击直接原地多行修改，或点击右侧详情查看完整备忘"
                  onDoubleClick={() => { if (!mutationDisabled) setTextEditor({ id: t.id, text: t.title }); }}
                >
                  {t.title}
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="todo-title-edit"
                    disabled={mutationDisabled}
                    title="在卡片内展开多行大编辑框"
                    aria-label={`原地修改标题：${t.title}`}
                    onClick={() => setTextEditor({ id: t.id, text: t.title })}
                  >
                    改名
                  </button>
                  <button
                    type="button"
                    className="todo-title-edit"
                    disabled={mutationDisabled}
                    title="打开右侧详情大抽屉（编辑长备忘、分步清单、截止时间）"
                    aria-label={`查看完整详情与备忘：${t.title}`}
                    onClick={() => openDetail(t.id)}
                  >
                    详情
                  </button>
                </div>
              </>}
            </div>

            {/* 高对比胶囊徽章体系（信息降噪，去除冗余创建时间戳） */}
            <div className="todo-item-dates">
              {group === 'overdue' && (
                <button type="button" className="todo-pill pill-overdue" title="点击调整排期" disabled={mutationDisabled}
                  aria-label={`设置截止时间：${t.title}`}
                  onClick={() => setEditing(editing?.id === t.id ? null : { id: t.id, date: t.dueDate || '', time: t.dueTime || '' })}>
                  🔥 {scheduleLabel(t, now)}
                </button>
              )}
              {group === 'today' && (
                <button type="button" className="todo-pill pill-today" title="点击调整排期" disabled={mutationDisabled}
                  aria-label={`设置截止时间：${t.title}`}
                  onClick={() => setEditing(editing?.id === t.id ? null : { id: t.id, date: t.dueDate || '', time: t.dueTime || '' })}>
                  ⏰ 今天 {t.dueTime || '当天结束前'}
                </button>
              )}
              {(group === 'upcoming' || (group === 'completed' && t.dueDate)) && (
                <button type="button" className="todo-pill pill-upcoming" title="点击调整排期" disabled={mutationDisabled}
                  aria-label={`设置截止时间：${t.title}`}
                  onClick={() => setEditing(editing?.id === t.id ? null : { id: t.id, date: t.dueDate || '', time: t.dueTime || '' })}>
                  📅 {scheduleLabel(t, now)}
                </button>
              )}
              {steps.length > 0 && (
                <button type="button" className="todo-pill pill-steps" title="点击打开详情查看全部步骤"
                  onClick={() => openDetail(t.id)}>
                  ✔ {steps.filter(s => s.completed).length}/{steps.length} 步
                </button>
              )}
              {t.notes && (
                <button type="button" className="todo-pill pill-notes" title="含有详细长备忘，点击查看"
                  onClick={() => openDetail(t.id)}>
                  📝 备忘
                </button>
              )}
              {!t.dueDate && (
                <button type="button" className="todo-due-label" disabled={mutationDisabled}
                  aria-label={`设置截止时间：${t.title}`}
                  onClick={() => setEditing(editing?.id === t.id ? null : { id: t.id, date: '', time: '' })}>
                  <CalendarBlank size={13}/><span>未排期</span>
                </button>
              )}
              {!isIdea && t.dueTime && !t.completed && <span className="todo-reminder-label">提前 10 分钟提醒</span>}
              {isIdea && t.dueTime && <span className="todo-reminder-label">灵感不提醒</span>}
              {t.completed && t.completedAt && <span className="todo-record-time">完成于 {formatTimestamp(t.completedAt)}</span>}
            </div>

            {editing?.id === t.id && (
              <form className="todo-date-editor" aria-label={`排期：${t.title}`} onSubmit={e => { e.preventDefault(); void saveSchedule(); }}>
                <div className="todo-date-fields">
                  <label>截止日期<input type="date" aria-label="编辑截止日期" value={editing.date} disabled={saving}
                    onChange={e => setEditing({ ...editing, date: e.target.value, time: e.target.value ? editing.time : '' })}/></label>
                  <label>时间（可选）<input type="time" aria-label="编辑截止时间" value={editing.time} disabled={!editing.date || saving}
                    onChange={e => setEditing({ ...editing, time: e.target.value })}/></label>
                </div>
                <div className="todo-date-shortcuts">
                  <button type="button" disabled={saving} onClick={() => setEditing({ ...editing, date: localDate(now) })}>今天</button>
                  <button type="button" disabled={saving} onClick={() => setEditing({ ...editing, date: localDate(now, 1) })}>明天</button>
                  <button type="button" disabled={saving} onClick={() => setEditing({ ...editing, date: '', time: '' })}>清除排期</button>
                  <Button type="submit" size="small" appearance="primary" disabled={saving}>保存排期</Button>
                  <Button type="button" size="small" disabled={saving} onClick={() => setEditing(null)}>取消</Button>
                </div>
                <small>填写具体时间后，Windows 提前 10 分钟提醒；只填日期，按当天结束前到期。</small>
              </form>
            )}

            {steps.length > 0 && (
              <div className="todo-subtasks">
                <button type="button" className="todo-step-summary" aria-expanded={stepsExpanded}
                  onClick={() => setExpandedSteps(previous => { const next = new Set(previous); if (next.has(t.id)) next.delete(t.id); else next.add(t.id); return next; })}>
                  {steps.length} 项步骤 · 已完成 {steps.filter(s => s.completed).length} 项{steps.length > 2 ? stepsExpanded ? ' · 收起' : ' · 展开' : ''}
                </button>
                {visibleSteps.map(sub => (
                  <div key={sub.id} className="todo-subtask-row">
                    <input type="checkbox" aria-label={`完成步骤：${sub.title}`} checked={sub.completed} disabled={mutationDisabled}
                      onChange={() => toggleStep(t.id, sub.id)}/>
                    {textEditor?.id === t.id && textEditor.stepId === sub.id ? renderTextEditor() : <>
                      <span className={sub.completed ? 'completed-text' : ''}>{sub.title}</span>
                      <button type="button" disabled={mutationDisabled} aria-label={`编辑步骤：${sub.title}`}
                        onClick={() => { setExpandedSteps(previous => new Set(previous).add(t.id)); setTextEditor({ id: t.id, stepId: sub.id, text: sub.title }); }}>编辑</button>
                      <button type="button" disabled={mutationDisabled} aria-label={`删除步骤：${sub.title}`} onClick={() => deleteStep(t.id, sub.id)}>删除</button>
                    </>}
                  </div>
                ))}
              </div>
            )}
            {stepDraft?.id === t.id ? <form className="todo-text-editor" aria-label="添加步骤"
              onSubmit={e => { e.preventDefault(); void addStep(); }}
              onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (!saving) setStepDraft(null); } }}>
              <input aria-label="新步骤内容" value={stepDraft.text} disabled={mutationDisabled} autoFocus
                onChange={e => setStepDraft({ ...stepDraft, text: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault(); }}/>
              <Button size="small" appearance="primary" type="submit" disabled={mutationDisabled}>添加</Button>
              <Button size="small" type="button" disabled={saving} onClick={() => setStepDraft(null)}>取消</Button>
            </form> : <button type="button" className="todo-add-step" disabled={mutationDisabled}
              onClick={() => { setExpandedSteps(previous => new Set(previous).add(t.id)); setStepDraft({ id: t.id, text: '' }); }}>＋ 添加步骤</button>}
          </div>
        </div>

        {/* 悬浮轻操作栏 */}
        <div className="todo-card-actions">
          <div className="todo-ai-actions">
            <button type="button" className="ai-action-btn" disabled={mutationDisabled}
              title="保留日期和象限；灵感不发送提醒" onClick={() => void toggleType(t.id)}>{isIdea ? '转为待办' : '转为灵感'}</button>
            {isIdea ? (
              <button
                type="button"
                className="ai-action-btn"
                onClick={() => void handleAiExpand(t)}
                disabled={aiBusy || mutationDisabled}
                title="AI 启发与落地思路"
              >
                <Sparkle size={12} weight="fill"/><span>启发</span>
              </button>
            ) : (
              <button
                type="button"
                className="ai-action-btn"
                onClick={() => void handleAiBreakdown(t)}
                disabled={aiBusy || mutationDisabled}
                title="AI 任务化整为零微拆解"
              >
                <Sparkle size={12} weight="fill"/><span>拆解</span>
              </button>
            )}
          </div>

          <fieldset className="todo-quadrant-moves" disabled={mutationDisabled} aria-label="移动或删除事项">
            <span className="move-label">移至</span>
            {t.quadrant !== 0 && <button type="button" onClick={() => moveQuadrant(t.id, 0)} title="移至收集箱">箱</button>}
            {t.quadrant !== 1 && <button type="button" className="q-tag-btn q1" onClick={() => moveQuadrant(t.id, 1)} title="移至第Ⅰ象限 (重要且紧急)">Ⅰ</button>}
            {t.quadrant !== 2 && <button type="button" className="q-tag-btn q2" onClick={() => moveQuadrant(t.id, 2)} title="移至第Ⅱ象限 (重要不紧急)">Ⅱ</button>}
            {t.quadrant !== 3 && <button type="button" className="q-tag-btn q3" onClick={() => moveQuadrant(t.id, 3)} title="移至第Ⅲ象限 (紧急不重要)">Ⅲ</button>}
            {t.quadrant !== 4 && <button type="button" className="q-tag-btn q4" onClick={() => moveQuadrant(t.id, 4)} title="移至第Ⅳ象限 (不重要不紧急)">Ⅳ</button>}
            <IconButton label="详情与长备忘" disabled={mutationDisabled} onClick={() => openDetail(t.id)}><Notepad size={13}/></IconButton>
            <IconButton label="删除" disabled={mutationDisabled} onClick={() => deleteItem(t.id)}><Trash size={13}/></IconButton>
          </fieldset>
        </div>
      </div>
    );
  };

  return (
    <div className={`todo-workbench-page ${draggingId ? 'is-dragging-active' : ''}`} hidden={!visible}>
      {/* 页面头部：严格遵循 MultiTool 原生结构 */}
      <div className="page-heading">
        <div>
          <h1>待办事项<span className="heading-dot">/</span><span className="heading-sub">轻重缓急，了然于心。</span></h1>
          <p>按日期安排进度，用四象限分清轻重缓急。</p>
        </div>

        <div className="todo-heading-controls">
          <Button
            appearance="subtle"
            className="ai-focus-trigger"
            icon={<Sparkle weight="fill"/>}
            disabled={aiBusy || mutationDisabled || !currentTodos.some(t => !t.completed && t.type === 'todo')}
            onClick={() => void handleAiDailyFocus()}
          >
            今日 AI 聚焦建议
          </Button>

          <div className="view-switch-group">
            <button
              type="button"
              className={`view-btn ${view === 'matrix' ? 'active' : ''}`}
              onClick={() => setView('matrix')}
              title="四象限看板视图"
              aria-pressed={view === 'matrix'}
            >
              <SquaresFour size={16}/><span>四象限</span>
            </button>
            <button
              type="button"
              className={`view-btn ${view === 'list' ? 'active' : ''}`}
              onClick={() => setView('list')}
              title="单列清单视图"
              aria-pressed={view === 'list'}
            >
              <ListBullets size={16}/><span>清单</span>
            </button>
          </div>
        </div>
      </div>

      {/* AI 每日精力聚焦建议通知条 (按需展示) */}
      {error && <div className="inline-error todo-error" role="alert">{error}{loadFailed && <Button size="small" onClick={() => void loadTodos()}>重新读取</Button>}</div>}
      {focusAdvice && (
        <div className="ai-focus-panel">
          <div className="ai-focus-head">
            <div className="ai-focus-title">
              <Sparkle size={15} weight="fill"/>
              <strong>AI 每日精力分配建议</strong>
              <span>{focusAdvice.advice || '专注高价值主线，保持从容节奏。'}</span>
            </div>
            <IconButton label="关闭建议" onClick={() => setFocusAdvice(null)}><X size={14}/></IconButton>
          </div>
          <div className="ai-focus-grid">
            <div className="focus-grid-item q1">
              <span className="focus-badge">🎯 优先处理</span>
              <p>{focusAdvice.q1Focus || '集中攻坚第 Ⅰ 象限临近截止日期的硬任务。'}</p>
            </div>
            <div className="focus-grid-item q2">
              <span className="focus-badge">🌱 重点推进</span>
              <p>{focusAdvice.q2Focus || '专注推进第 Ⅱ 象限长远核心发展目标。'}</p>
            </div>
            <div className="focus-grid-item q3">
              <span className="focus-badge">⚡ 集中处理</span>
              <p>{focusAdvice.q3Batch || '在实际截止时间前，集中处理第 Ⅲ 象限事务。'}</p>
            </div>
          </div>
        </div>
      )}

      {/* 即时速记录入条 (极简、轻盈、回车即存) */}
      <div className="todo-input-bar">
        <form onSubmit={e => void handleAdd(e)} className="todo-add-form" aria-label="新增事项">
          <button
            type="button"
            className="entry-type-toggle"
            onClick={() => setEntryType(t => t === 'todo' ? 'idea' : 'todo')}
            title="切换记录类型（待办/灵感）"
          >
            {entryType === 'todo' ? <CheckSquare size={16} weight="bold"/> : <Lightbulb size={16} weight="fill"/>}
            <span>{entryType === 'todo' ? '待办' : '灵感'}</span>
          </button>

          <input
            type="text"
            value={titleInput}
            onChange={e => { setTitleInput(e.target.value); setIgnoreParsedSchedule(false); }}
            placeholder={entryType === 'todo' ? '记下一件待办事项…（按 Enter 存入）' : '捕捉此刻一闪而过的念头…（按 Enter 存入）'}
            className="todo-main-input"
            aria-label="事项内容"
            disabled={mutationDisabled}
            autoFocus
          />

          <div className="todo-input-actions">
            {titleInput.trim() && (
              <button
                type="button"
                className="ai-triage-btn"
                disabled={aiBusy}
                onClick={() => void handleAiTriage()}
                title="AI 智能研判所属象限"
              >
                <Sparkle size={13} weight="fill"/>
                <span>{aiBusy ? '研判中…' : 'AI 研判象限'}</span>
              </button>
            )}

            {entryType === 'todo' && (
              <select
                aria-label="选择所属象限"
                value={selectedQuadrant}
                onChange={e => setSelectedQuadrant(parseInt(e.target.value, 10) as TodoQuadrant)}
                className="quadrant-select"
              >
                <option value="2">🌱 Ⅱ 重要不紧急 (排期聚焦)</option>
                <option value="1">🔥 Ⅰ 重要且紧急 (今日必做)</option>
                <option value="3">⚡ Ⅲ 紧急不重要 (快速处理)</option>
                <option value="4">☕ Ⅳ 不重要不紧急 (闲暇琐事)</option>
                <option value="0">📥 闪念收集箱 (暂不归类)</option>
              </select>
            )}

            <Button appearance="primary" size="small" type="submit" disabled={mutationDisabled || !titleInput.trim()} icon={<Plus size={14}/>}>
              存入
            </Button>
          </div>
          <div className="todo-entry-schedule">
            <CalendarBlank size={14}/>
            <label>截止日期<input type="date" aria-label="截止日期" value={dueDate} disabled={mutationDisabled}
              onChange={e => { setDueDate(e.target.value); if (!e.target.value) setDueTime(''); }}/></label>
            <label>时间（可选）<input type="time" aria-label="截止时间" value={dueTime} disabled={!dueDate || mutationDisabled}
              onChange={e => setDueTime(e.target.value)}/></label>
            <div className="todo-date-shortcuts">
              <button type="button" disabled={mutationDisabled} onClick={() => setDueDate(localDate(now))}>今天</button>
              <button type="button" disabled={mutationDisabled} onClick={() => setDueDate(localDate(now, 1))}>明天</button>
              {dueDate && <button type="button" disabled={mutationDisabled} onClick={() => { setDueDate(''); setDueTime(''); }}>清除</button>}
            </div>
            <span className="todo-schedule-hint">{dueDate ? '不填时间，按当天结束前到期' : '不填日期，存为未排期'}</span>
          </div>
        </form>

        {!dueDate && !ignoreParsedSchedule && detectedSchedule.dueDate && <div className="todo-parsed-schedule" role="status">
          识别安排：{detectedSchedule.dueDate} {detectedSchedule.dueTime || '当天结束前'} · 存入时采用
          <button type="button" onClick={() => setIgnoreParsedSchedule(true)}>忽略识别</button>
        </div>}

        {/* AI 象限研判气泡 */}
        {triageResult && (
          <div className="ai-triage-balloon">
            <div className="balloon-text">
              <Sparkle size={14} weight="fill"/>
              <span><strong>AI 研判建议：</strong>{triageResult.reason}</span>
            </div>
            <div className="balloon-actions">
              <Button appearance="primary" size="small" onClick={applyTriage}>采纳推荐</Button>
              <IconButton label="忽略" onClick={() => setTriageResult(null)}><X size={13}/></IconButton>
            </div>
          </div>
        )}
      </div>

      <div className="todo-time-toolbar">
        <label className="search-field todo-search-field"><MagnifyingGlass size={16}/>
          <input id="todo-search" aria-label="待办搜索" placeholder="搜索标题、备忘或步骤…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}/>
          {searchQuery && <IconButton label="清除待办搜索" onClick={() => setSearchQuery('')}><X size={14}/></IconButton>}
        </label>
        <div className="todo-current-day"><CalendarBlank size={16}/><time dateTime={localDate(now)}>{new Date(now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time></div>
        <div className="todo-time-filters" role="group" aria-label="按到期时间筛选">
          {timeFilters.map(filter => <button type="button" key={filter.value} aria-pressed={timeFilter === filter.value}
            className={timeFilter === filter.value ? 'active' : ''} onClick={() => { setTimeFilter(filter.value); setEditing(null); }}>
            {filter.label}<span>{currentTodos.filter(t => matchesTimeFilter(t, filter.value, now)).length}</span>
          </button>)}
        </div>
      </div>

      {/* 状态微统计与操作行 */}
      <div className={`todo-reminder-status ${reminderError ? 'failed' : ''}`} role={reminderError ? 'alert' : undefined}>
        <Bell size={13} aria-hidden="true"/>
        <span>{desktop ? reminderError ? `提醒暂不可用：${reminderError}` : 'Windows 提醒 · 设置具体时间后提前 10 分钟通知；关闭窗口后在托盘继续运行，托盘“退出”后停止。' : '桌面版可在具体时间前 10 分钟通过 Windows 提醒。'}</span>
      </div>
      <div className="todo-summary-row">
        <div className="summary-badges">
          <span>进行中 <strong>{activeCount}</strong></span>
          <span className="stat-divider"/>
          <span>已完成 <strong>{doneCount}</strong></span>
          <span className="stat-divider"/>
          <span>闪念灵感 <strong>{sparkCount}</strong></span>
        </div>

        <div className="summary-actions">
          {saving && <span role="status">正在保存…</span>}
          {removedTodos.length > 0 && <button type="button" className="text-action-btn" onClick={() => setShowRecovery(true)}>恢复已移除（{removedTodos.length}）</button>}
          {doneCount > 0 && (
            <button type="button" className="text-action-btn" disabled={mutationDisabled} onClick={clearCompleted}>
              清理已完成
            </button>
          )}
        </div>
      </div>

      {showRecovery && <Modal title="恢复已移除事项" onClose={() => setShowRecovery(false)}>
        <p>删除与清理的事项保留在这里，恢复后仍保留原来的日期、象限和步骤。未完成待办恢复后按原时间继续提醒。</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="todo-recovery-list">
          {removedTodos.length ? removedTodos.map(t => <div className="todo-recovery-item" key={t.id}>
            <div><strong>{t.title}</strong><small>{t.completed ? '已完成' : t.type === 'idea' ? '灵感' : '待办'} · 移除于 {formatTimestamp(t.deletedAt!)}</small></div>
            <Button size="small" disabled={mutationDisabled} onClick={() => void restoreItem(t.id)} aria-label={`恢复事项：${t.title}`}>恢复</Button>
          </div>) : <Empty title="没有待恢复的事项"/>}
        </div>
      </Modal>}

      {/* 主展示区 */}
      {loading ? (
        <Skeleton/>
      ) : view === 'matrix' ? (
        <div className={`todo-matrix-layout ${maximizedQuadrant !== null ? 'has-maximized' : ''}`}>
          {/* 左侧：收集箱与灵感闪念抽屉 */}
          {(maximizedQuadrant === null || maximizedQuadrant === 0) && (
            <section
              className={`panel todo-inbox-panel ${maximizedQuadrant === 0 ? 'maximized' : ''} ${dragOverQuadrant === 0 ? 'drag-over' : ''}`}
              aria-label="闪念与收集箱"
              {...getDropProps(0)}
            >
              <div className="panel-head">
                <div className="panel-title">
                  <span className="inbox-icon"><Lightbulb size={16} weight="duotone"/></span>
                  <h2>闪念与收集箱</h2>
                  <span className="count">{inboxItems.length}</span>
                </div>
                <button
                  type="button"
                  className="panel-maximize-btn"
                  title={maximizedQuadrant === 0 ? '还原标准看板' : '最大化聚焦此面板'}
                  onClick={() => setMaximizedQuadrant(maximizedQuadrant === 0 ? null : 0)}
                >
                  <ArrowsOutSimple size={13}/>
                  <span>{maximizedQuadrant === 0 ? '还原' : '聚焦'}</span>
                </button>
              </div>
              <div className="panel-parent">随时倾倒想法，支持鼠标拖拽卡片归类</div>
              {maximizedQuadrant === 0 && renderFlowStrip(0)}

              <div className="todo-card-scroll" {...getDropProps(0)}>
                {!inboxItems.length ? (
                  <Empty title="当前筛选下暂无事项" detail="上方输入框随时记录待办或灵感，或直接拖拽卡片至此"/>
                ) : (
                  inboxItems.map(renderCard)
                )}
              </div>
            </section>
          )}

          {/* 右侧：四象限看板 */}
          {maximizedQuadrant !== 0 && (
            <div className={`todo-matrix-grid ${maximizedQuadrant !== null ? 'has-maximized' : ''}`}>
              {/* 象限 Ⅰ */}
              {(maximizedQuadrant === null || maximizedQuadrant === 1) && (
                <section
                  className={`panel quadrant-panel q1 ${maximizedQuadrant === 1 ? 'maximized' : ''} ${dragOverQuadrant === 1 ? 'drag-over' : ''}`}
                  aria-label="第Ⅰ象限"
                  {...getDropProps(1)}
                >
                  <div className="panel-head">
                    <div className="panel-title">
                      <span className="q-dot q1"/>
                      <h2>第 Ⅰ 象限 · 马上执行</h2>
                      <span className="q-sub">重要且紧急</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="count">{q1Items.length}</span>
                      <button
                        type="button"
                        className="panel-maximize-btn"
                        title={maximizedQuadrant === 1 ? '还原标准看板' : '最大化聚焦此象限'}
                        onClick={() => setMaximizedQuadrant(maximizedQuadrant === 1 ? null : 1)}
                      >
                        <ArrowsOutSimple size={13}/>
                        <span>{maximizedQuadrant === 1 ? '还原' : '聚焦'}</span>
                      </button>
                    </div>
                  </div>
                  {maximizedQuadrant === 1 && renderFlowStrip(1)}
                  <div className="todo-card-scroll" {...getDropProps(1)}>
                    {!q1Items.length ? <Empty title="当前筛选下暂无事项"/> : q1Items.map(renderCard)}
                  </div>
                </section>
              )}

              {/* 象限 Ⅱ (核心高价值象限) */}
              {(maximizedQuadrant === null || maximizedQuadrant === 2) && (
                <section
                  className={`panel quadrant-panel q2 highlight ${maximizedQuadrant === 2 ? 'maximized' : ''} ${dragOverQuadrant === 2 ? 'drag-over' : ''}`}
                  aria-label="第Ⅱ象限"
                  {...getDropProps(2)}
                >
                  <div className="panel-head">
                    <div className="panel-title">
                      <span className="q-dot q2"/>
                      <h2>第 Ⅱ 象限 · 重点聚焦</h2>
                      <span className="q-sub">重要不紧急</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="count">{q2Items.length}</span>
                      <button
                        type="button"
                        className="panel-maximize-btn"
                        title={maximizedQuadrant === 2 ? '还原标准看板' : '最大化聚焦此象限'}
                        onClick={() => setMaximizedQuadrant(maximizedQuadrant === 2 ? null : 2)}
                      >
                        <ArrowsOutSimple size={13}/>
                        <span>{maximizedQuadrant === 2 ? '还原' : '聚焦'}</span>
                      </button>
                    </div>
                  </div>
                  {maximizedQuadrant === 2 && renderFlowStrip(2)}
                  <div className="todo-card-scroll" {...getDropProps(2)}>
                    {!q2Items.length ? <Empty title="当前筛选下暂无事项"/> : q2Items.map(renderCard)}
                  </div>
                </section>
              )}

              {/* 象限 Ⅲ */}
              {(maximizedQuadrant === null || maximizedQuadrant === 3) && (
                <section
                  className={`panel quadrant-panel q3 ${maximizedQuadrant === 3 ? 'maximized' : ''} ${dragOverQuadrant === 3 ? 'drag-over' : ''}`}
                  aria-label="第Ⅲ象限"
                  {...getDropProps(3)}
                >
                  <div className="panel-head">
                    <div className="panel-title">
                      <span className="q-dot q3"/>
                      <h2>第 Ⅲ 象限 · 快速响应</h2>
                      <span className="q-sub">紧急不重要</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="count">{q3Items.length}</span>
                      <button
                        type="button"
                        className="panel-maximize-btn"
                        title={maximizedQuadrant === 3 ? '还原标准看板' : '最大化聚焦此象限'}
                        onClick={() => setMaximizedQuadrant(maximizedQuadrant === 3 ? null : 3)}
                      >
                        <ArrowsOutSimple size={13}/>
                        <span>{maximizedQuadrant === 3 ? '还原' : '聚焦'}</span>
                      </button>
                    </div>
                  </div>
                  {maximizedQuadrant === 3 && renderFlowStrip(3)}
                  <div className="todo-card-scroll" {...getDropProps(3)}>
                    {!q3Items.length ? <Empty title="当前筛选下暂无事项"/> : q3Items.map(renderCard)}
                  </div>
                </section>
              )}

              {/* 象限 Ⅳ */}
              {(maximizedQuadrant === null || maximizedQuadrant === 4) && (
                <section
                  className={`panel quadrant-panel q4 ${maximizedQuadrant === 4 ? 'maximized' : ''} ${dragOverQuadrant === 4 ? 'drag-over' : ''}`}
                  aria-label="第Ⅳ象限"
                  {...getDropProps(4)}
                >
                  <div className="panel-head">
                    <div className="panel-title">
                      <span className="q-dot q4"/>
                      <h2>第 Ⅳ 象限 · 闲暇清理</h2>
                      <span className="q-sub">不重要不紧急</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="count">{q4Items.length}</span>
                      <button
                        type="button"
                        className="panel-maximize-btn"
                        title={maximizedQuadrant === 4 ? '还原标准看板' : '最大化聚焦此象限'}
                        onClick={() => setMaximizedQuadrant(maximizedQuadrant === 4 ? null : 4)}
                      >
                        <ArrowsOutSimple size={13}/>
                        <span>{maximizedQuadrant === 4 ? '还原' : '聚焦'}</span>
                      </button>
                    </div>
                  </div>
                  {maximizedQuadrant === 4 && renderFlowStrip(4)}
                  <div className="todo-card-scroll" {...getDropProps(4)}>
                    {!q4Items.length ? <Empty title="当前筛选下暂无事项"/> : q4Items.map(renderCard)}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      ) : (
        /* 单列清单视图 */
        <section className="panel todo-list-panel" aria-label="待办清单">
          <div className="panel-head">
            <div className="panel-title">
              <span className="inbox-icon"><ListBullets size={16}/></span>
              <h2>到期时间清单</h2>
              <span className="count">{filteredList.length}</span>
            </div>

            <div className="list-filter-tabs">
              <button
                type="button"
                className={listFilter === 'all' ? 'active' : ''}
                onClick={() => setListFilter('all')}
              >
                全部
              </button>
              <button
                type="button"
                className={listFilter === 'todo' ? 'active' : ''}
                onClick={() => setListFilter('todo')}
              >
                仅待办
              </button>
              <button
                type="button"
                className={listFilter === 'idea' ? 'active' : ''}
                onClick={() => setListFilter('idea')}
              >
                仅灵感
              </button>
            </div>
          </div>

          <div className="todo-linear-scroll">
            {!filteredList.length ? (
              <Empty title="暂无匹配事项" detail="输入新待办或清除筛选条件"/>
            ) : (
              dateGroups.map(group => {
                const items = filteredList.filter(t => dateGroup(t, now) === group.value);
                return items.length ? <section className="todo-date-group" aria-label={group.label} key={group.value}>
                  <h3>{group.label}<span>{items.length}</span></h3>{items.map(renderCard)}
                </section> : null;
              })
            )}
          </div>
        </section>
      )}

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
      {selectedDetailItem && <TodoDetailDrawer key={selectedDetailItem.id} item={selectedDetailItem} initialTitle={detailTitleDraft}
        saving={saving} onClose={() => setSelectedDetailId(null)}
        onSave={item => persistTodos(todos.map(t => t.id === item.id ? item : t))}
        onDelete={async () => { const ok = await persistTodos(todos.map(t => t.id === selectedDetailItem.id ? { ...t, deletedAt: Date.now() } : t)); if (ok) setSelectedDetailId(null); return ok; }}/>}

    </div>
  );
}
