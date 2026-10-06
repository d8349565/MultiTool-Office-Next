import type { TodoItem, TodoSubtask } from './types';
import { validSchedule } from './todoSchedule';

export function matchesTodoSearch(item: TodoItem, query: string): boolean {
  const text = [item.title, item.notes, item.aiNote, ...(item.subtasks || []).map(step => step.title)].join('\n').toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
}

// 读取时兼容旧字符串步骤；首次编辑时保存新版结构，标识在刷新前后保持一致。
export function normalizeTodos(data: unknown): TodoItem[] {
  if (!Array.isArray(data)) throw new Error('待办数据格式异常');
  const ids = new Set<string>();
  return data.map(value => {
    if (!value || typeof value !== 'object') throw new Error('待办数据格式异常');
    const t = value as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id || ids.has(t.id) || typeof t.title !== 'string' || !t.title.trim() ||
      !['todo', 'idea'].includes(String(t.type)) || ![0, 1, 2, 3, 4].includes(t.quadrant as number) ||
      typeof t.completed !== 'boolean' || typeof t.createdAt !== 'number' || !Number.isFinite(t.createdAt) ||
      (t.schemaVersion !== undefined && t.schemaVersion !== 1 && t.schemaVersion !== 2) ||
      (t.dueDate !== undefined && typeof t.dueDate !== 'string') ||
      (t.dueTime !== undefined && typeof t.dueTime !== 'string') ||
      !validSchedule((t.dueDate as string) || '', (t.dueTime as string) || '')) throw new Error('待办数据格式异常');
    ids.add(t.id);
    for (const field of ['completedAt', 'deletedAt']) {
      if (t[field] !== undefined && (typeof t[field] !== 'number' || !Number.isFinite(t[field]))) throw new Error('待办时间格式异常');
    }
    if (t.notes !== undefined && typeof t.notes !== 'string') throw new Error('备忘内容格式异常');
    let subtasks: TodoSubtask[] | undefined;
    if (t.subtasks !== undefined) {
      if (!Array.isArray(t.subtasks)) throw new Error('步骤数据格式异常');
      const stepIds = new Set<string>();
      for (const step of t.subtasks) {
        if (typeof step === 'string') continue;
        if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !step.id || stepIds.has(step.id) ||
          typeof step.title !== 'string' || !step.title.trim() || typeof step.completed !== 'boolean') throw new Error('步骤数据格式异常');
        stepIds.add(step.id);
      }
      subtasks = t.subtasks.map((step, index) => {
        if (typeof step !== 'string') return { ...step } as TodoSubtask;
        if (!step.trim()) throw new Error('步骤内容不能为空');
        let id = `${t.id}:legacy:${index}`;
        while (stepIds.has(id)) id += ':old';
        stepIds.add(id);
        return { id, title: step, completed: false };
      });
    }
    return { ...t, schemaVersion: 2, ...(subtasks !== undefined ? { subtasks } : {}) } as unknown as TodoItem;
  });
}
