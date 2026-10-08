import { useEffect, useRef, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { Check, Trash, X } from '@phosphor-icons/react';
import { IconButton } from './components';
import { normalizeTodos, todoQuadrants } from './todoData';
import { formatTimestamp, localDate } from './todoSchedule';
import type { TodoItem, TodoQuadrant } from './types';

export default function TodoDetailDrawer({ item, initialTitle, saving, onSave, onDelete, onClose }: {
  item: TodoItem; initialTitle?: string; saving: boolean;
  onSave: (item: TodoItem) => Promise<boolean>; onDelete: () => Promise<boolean>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<TodoItem>(() => ({ ...item, title: initialTitle ?? item.title }));
  const [dirty, setDirty] = useState(initialTitle !== undefined && initialTitle !== item.title);
  const [newStep, setNewStep] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => { const current = dialog.current!; current.showModal(); return () => current.close(); }, []);

  const update = (updates: Partial<TodoItem>) => { setDraft(previous => ({ ...previous, ...updates })); setDirty(true); setError(''); };
  const close = () => {
    if (saving || pending.current) return;
    if (dirty || newStep.trim()) { setError('还有未保存的修改，请保存修改，或选择放弃修改并关闭。'); return; }
    onClose();
  };
  const addStep = () => {
    if (!newStep.trim()) return;
    update({ subtasks: [...(draft.subtasks || []), { id: crypto.randomUUID(), title: newStep.trim(), completed: false }] });
    setNewStep('');
  };
  const save = async () => {
    if (pending.current || saving) return;
    let next: TodoItem;
    try {
      const steps = [...(draft.subtasks || []), ...(newStep.trim() ? [{ id: crypto.randomUUID(), title: newStep.trim(), completed: false }] : [])];
      next = normalizeTodos([{ ...draft, title: draft.title.trim(), subtasks: steps.map(s => ({ ...s, title: s.title.trim() })) }])[0];
    } catch { setError('请填写非空标题和步骤，并检查截止日期与时间。'); return; }
    pending.current = true;
    try {
      if (await onSave(next)) { setDraft(next); setDirty(false); setNewStep(''); setError(''); }
      else setError('保存失败，编辑内容仍保留，请重试。');
    } finally { pending.current = false; }
  };

  return <dialog ref={dialog} className="todo-drawer-overlay" aria-label="事项详情与长备忘"
    onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <aside className="todo-detail-drawer">
      <div className="todo-drawer-header">
        <button type="button" className={`todo-checkbox ${draft.completed ? 'checked' : ''}`} disabled={saving}
          aria-label={draft.completed ? '标记为未完成' : '标记为已完成'} aria-pressed={draft.completed}
          onClick={() => update({ completed: !draft.completed, completedAt: !draft.completed ? Date.now() : undefined })}>
          {draft.completed && <Check size={12} weight="bold"/>}
        </button>
        <strong>{draft.type === 'idea' ? '灵感详情' : '待办详情'}</strong>
        <div className="todo-drawer-actions">
          <Button size="small" disabled={saving} onClick={() => update({ type: draft.type === 'todo' ? 'idea' : 'todo' })}>{draft.type === 'idea' ? '转为待办' : '转为灵感'}</Button>
          <IconButton label="关闭详情" disabled={saving} onClick={close}><X size={15}/></IconButton>
        </div>
      </div>
      <div className="todo-drawer-body">
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="todo-drawer-section">
          <label htmlFor="todo-detail-title">事项标题</label>
          <textarea id="todo-detail-title" className="todo-drawer-title-input" aria-label="事项标题" rows={2} autoFocus disabled={saving}
            value={draft.title} onChange={e => update({ title: e.target.value })}/>
        </div>
        <div className="todo-drawer-section">
          <span>截止日期与具体时间</span><div className="todo-date-fields">
            <label>截止日期<input type="date" aria-label="详情截止日期" value={draft.dueDate || ''} disabled={saving}
              onChange={e => update({ dueDate: e.target.value || undefined, dueTime: e.target.value ? draft.dueTime : undefined })}/></label>
            <label>时间（可选）<input type="time" aria-label="详情截止时间" value={draft.dueTime || ''} disabled={!draft.dueDate || saving}
              onChange={e => update({ dueTime: e.target.value || undefined })}/></label>
          </div><div className="todo-date-shortcuts">
            <button type="button" disabled={saving} onClick={() => update({ dueDate: localDate(Date.now()) })}>今天</button>
            <button type="button" disabled={saving} onClick={() => update({ dueDate: localDate(Date.now(), 1) })}>明天</button>
            <button type="button" disabled={saving} onClick={() => update({ dueDate: undefined, dueTime: undefined })}>清除排期</button>
          </div>
        </div>
        <div className="todo-drawer-section">
          <span>所属象限</span><div className="todo-drawer-quadrants" role="group" aria-label="详情所属象限">
            {todoQuadrants.map(q => <button type="button" key={q.value} disabled={saving} aria-pressed={draft.quadrant === q.value}
              onClick={() => update({ quadrant: q.value as TodoQuadrant })}>
              <span>{q.numeral} {q.label}</span><small>{q.description}</small>
            </button>)}
          </div>
        </div>
        <div className="todo-drawer-section">
          <span>分步推进清单（{draft.subtasks?.length || 0}）</span><div className="todo-drawer-steps-list">
            {(draft.subtasks || []).map(step => <div className="todo-drawer-step-row" key={step.id}>
              <input type="checkbox" aria-label={`完成步骤：${step.title}`} disabled={saving} checked={step.completed}
                onChange={() => update({ subtasks: draft.subtasks?.map(s => s.id === step.id ? { ...s, completed: !s.completed } : s) })}/>
              <input type="text" aria-label={`步骤内容：${step.title}`} disabled={saving} value={step.title}
                onChange={e => update({ subtasks: draft.subtasks?.map(s => s.id === step.id ? { ...s, title: e.target.value } : s) })}/>
              <IconButton label={`删除步骤：${step.title}`} disabled={saving} onClick={() => update({ subtasks: draft.subtasks?.filter(s => s.id !== step.id) })}><X size={12}/></IconButton>
            </div>)}
            <form onSubmit={e => { e.preventDefault(); addStep(); }} className="todo-detail-add-step">
              <input type="text" aria-label="详情新步骤内容" placeholder="输入新步骤，按回车加入草稿" disabled={saving} value={newStep} onChange={e => setNewStep(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.repeat)) e.preventDefault(); }}/>
              <Button size="small" type="submit" disabled={saving || !newStep.trim()}>添加步骤</Button>
            </form>
          </div>
        </div>
        <div className="todo-drawer-section">
          <label htmlFor="todo-detail-notes">详细备忘与长说明</label>
          <textarea id="todo-detail-notes" className="todo-drawer-notes" value={draft.notes || ''} disabled={saving}
            onChange={e => update({ notes: e.target.value })}/>
        </div>
      </div>
      <div className="todo-drawer-footer">
        <span>{dirty || newStep.trim() ? '有未保存的修改' : `创建于 ${formatTimestamp(item.createdAt)}`}</span>
        <div className="todo-drawer-actions">
          {dirty || newStep.trim() ? <Button size="small" disabled={saving} onClick={() => { if (!pending.current) onClose(); }}>放弃修改并关闭</Button> :
            <Button size="small" disabled={saving} icon={<Trash size={12}/>} onClick={() => { void onDelete().then(ok => { if (!ok) setError('删除失败，原事项已保留。'); }); }}>删除事项</Button>}
          <Button size="small" appearance="primary" disabled={saving || (!dirty && !newStep.trim())} onClick={() => void save()}>保存修改</Button>
        </div>
      </div>
    </aside>
  </dialog>;
}
