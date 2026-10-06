import type { TodoItem } from './types';

export type TodoTimeFilter = 'all' | 'today' | 'week' | 'overdue' | 'unscheduled' | 'completed';
export type TodoDateGroup = 'overdue' | 'today' | 'upcoming' | 'unscheduled' | 'completed';

export const timeFilters: { value: TodoTimeFilter; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'today', label: '今天到期' },
  { value: 'week', label: '近七天' }, { value: 'overdue', label: '已逾期' },
  { value: 'unscheduled', label: '未排期' }, { value: 'completed', label: '已完成' },
];
export const dateGroups: { value: TodoDateGroup; label: string }[] = [
  { value: 'overdue', label: '已逾期 · 优先处理' }, { value: 'today', label: '今天到期' },
  { value: 'upcoming', label: '后续安排' }, { value: 'unscheduled', label: '未排期' },
  { value: 'completed', label: '已完成' },
];

export function localDate(now: number, offset = 0): string {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function validSchedule(date: string, time: string): boolean {
  if (!date) return !time;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return false;
  const parsed = new Date(`${date}T${time || '00:00'}:00`);
  return Number.isFinite(parsed.getTime()) && localDate(parsed.getTime()) === date &&
    (!time || `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}` === time);
}

export function dueTimestamp(item: TodoItem): number | undefined {
  const date = item.dueDate || '', time = item.dueTime || '';
  if (!date || !validSchedule(date, time)) return undefined;
  const due = new Date(`${date}T${time || '00:00'}:00`);
  if (!time) { due.setDate(due.getDate() + 1); return due.getTime() - 1; }
  return due.getTime();
}

export function dateGroup(item: TodoItem, now: number): TodoDateGroup {
  if (item.completed) return 'completed';
  const due = dueTimestamp(item);
  if (due === undefined) return 'unscheduled';
  if (due < now) return 'overdue';
  return item.dueDate === localDate(now) ? 'today' : 'upcoming';
}

export function matchesTimeFilter(item: TodoItem, filter: TodoTimeFilter, now: number): boolean {
  if (filter === 'all') return true;
  if (filter === 'completed') return item.completed;
  if (item.completed) return false;
  const due = dueTimestamp(item);
  if (filter === 'unscheduled') return due === undefined;
  if (filter === 'overdue') return due !== undefined && due < now;
  if (filter === 'today') return due !== undefined && item.dueDate === localDate(now);
  // 含今天及后六个日历日；今天已过时的事项仍属于近七天。
  return due !== undefined && item.dueDate! >= localDate(now) && item.dueDate! <= localDate(now, 6);
}

export function compareTodos(a: TodoItem, b: TodoItem): number {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  if (a.completed) return (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt);
  return (dueTimestamp(a) ?? Infinity) - (dueTimestamp(b) ?? Infinity) || b.createdAt - a.createdAt;
}

export function scheduleLabel(item: TodoItem, now: number): string {
  if (dueTimestamp(item) === undefined) return '未排期';
  const day = item.dueDate === localDate(now) ? '今天' : item.dueDate === localDate(now, 1) ? '明天' : item.dueDate!;
  const label = `${day} ${item.dueTime || '当天结束前'}`;
  return dateGroup(item, now) === 'overdue' ? `已逾期 · ${label}` : label;
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export interface ParsedSchedule {
  cleanTitle: string;
  dueDate?: string;
  dueTime?: string;
}

export function parseScheduleFromText(text: string, now: number): ParsedSchedule {
  let dueDate: string | undefined;
  let dueTime: string | undefined;
  let remaining = text.trim();

  // 先识别完整日期，保留用户写明的年份；无效日期不擅自改排今天。
  const explicitDate = remaining.match(/(?<!\d)(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]|(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (explicitDate) {
    const year = explicitDate[1] || explicitDate[4] || String(new Date(now).getFullYear());
    const month = (explicitDate[2] || explicitDate[5]).padStart(2, '0');
    const day = (explicitDate[3] || explicitDate[6]).padStart(2, '0');
    const candidate = `${year}-${month}-${day}`;
    if (!validSchedule(candidate, '')) return { cleanTitle: remaining };
    dueDate = candidate;
    remaining = remaining.replace(explicitDate[0], ' ');
  }

  // 匹配相对日期：今天、明天、后天、大后天
  const relativeDateMatch = remaining.match(/(大后天|后天|明天|今天)/);
  if (!dueDate && relativeDateMatch) {
    const word = relativeDateMatch[1];
    const offset = word === '今天' ? 0 : word === '明天' ? 1 : word === '后天' ? 2 : 3;
    dueDate = localDate(now, offset);
    remaining = remaining.replace(word, ' ');
  }

  // 星期按本地日历计算；未指定本周/下周时取最近一次，不改变明确日期的优先级。
  const weekdayMatch = remaining.match(/(?<![上下本每])(本|下)?(?:周|星期)([一二三四五六日天])/);
  if (!dueDate && weekdayMatch && !/每(?:个)?(?:周|星期)/.test(remaining)) {
    const today = (new Date(now).getDay() + 6) % 7;
    const weekday = '一二三四五六日'.indexOf(weekdayMatch[2] === '天' ? '日' : weekdayMatch[2]);
    let offset = weekday - today;
    if (weekdayMatch[1] === '下') offset += 7;
    else if (!weekdayMatch[1] && offset < 0) offset += 7;
    dueDate = localDate(now, offset);
    remaining = remaining.replace(weekdayMatch[0], ' ');
  }

  // 周期、尚未支持的日期和时间段完整保留，不能只取其中一个时间再补成今天。
  if (/每(?:个)?(?:天|日|周|星期|月|年)|(?:上|本|下)(?:个)?(?:周|星期|月|季度|年)|(?:周|星期)[\d一二三四五六七八九日天末]|明年|后年|去年|月[底末]|[\d一二两三四五六七八九十]+(?:天|周|星期|个月|月|年)后|过[\d一二两三四五六七八九十]+天|工作日|下班前/.test(remaining)) {
    return { cleanTitle: text.trim() };
  }

  // 匹配时间，如：下午2点、14:30、晚上8点半、上午9点15分
  const timeMatches = [...remaining.matchAll(/(?<![\d:：.])(?:(上午|下午|晚上|中午)\s*)?(\d{1,2})(?:点半|[点时](\d{1,2})?分?|[:：](\d{2}))(?![\d:：])/g)];
  if (timeMatches.length > 1) return { cleanTitle: text.trim() };
  const timeMatch = timeMatches[0];
  if (timeMatch) {
    const period = timeMatch[1] || '';
    let hour = parseInt(timeMatch[2], 10);
    const isHalf = timeMatch[0].includes('半');
    const minute = isHalf ? 30 : parseInt(timeMatch[3] || timeMatch[4] || '0', 10);
    const afterTime = remaining.slice(timeMatch.index + timeMatch[0].length);
    const beforeTime = remaining.slice(0, timeMatch.index);
    // “几点意见/建议”是数量；不因小时恰好落在办公时间内而当作排期。
    const isCount = !period && timeMatch[0].includes('点') && (
      /(?:有|共|这|那|以下|上述)\s*$/.test(beforeTime) ||
      /^[\s的]*(?:修改意见|意见|建议|要求|内容|说明|原因|问题|注意事项|[个项条]|[万千百]?元)/.test(afterTime)
    );

    if (period === '下午' || period === '晚上') {
      if (hour < 12) hour += 12;
    } else if (period === '中午' && hour === 12) {
      // 12点保持
    } else if (period === '上午' && hour === 12) {
      hour = 0;
    }

    if (!isCount && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      dueTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      remaining = remaining.replace(timeMatch[0] + (afterTime.startsWith('前') ? '前' : ''), ' ');
    }
  }

  // 如果提取到了具体时间但没有日期，默认安排在今天
  if (dueTime && !dueDate) {
    dueDate = localDate(now);
  }

  // 清洗多余空格
  const cleanTitle = remaining.replace(/\s+/g, ' ').trim() || text.trim();
  return { cleanTitle, dueDate, dueTime };
}
