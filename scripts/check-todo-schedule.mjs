import assert from 'node:assert/strict';
import { matchesTimeFilter, dateGroup, compareTodos, localDate } from '../src/todoSchedule.ts';

const now = new Date('2026-10-08T12:00:00').getTime();
const todo = { id: 'todo', title: '整理会议资料', type: 'todo', quadrant: 0, completed: false, createdAt: now };
const idea = { ...todo, id: 'idea', type: 'idea' };
const completed = { ...todo, id: 'done', completed: true, completedAt: now };
const overdue = { ...todo, id: 'overdue', dueDate: localDate(now, -1) };
const today = { ...todo, id: 'today', dueDate: localDate(now), dueTime: '15:00' };
const upcoming = { ...todo, id: 'upcoming', dueDate: localDate(now, 3) };

for (const item of [todo, idea, overdue, today, upcoming]) assert.equal(matchesTimeFilter(item, 'active', now), true);
for (const type of ['todo', 'idea']) assert.equal(matchesTimeFilter({ ...completed, type }, 'active', now), false);
assert.equal(matchesTimeFilter(completed, 'all', now), true);
assert.equal(matchesTimeFilter(completed, 'completed', now), true);
assert.equal(matchesTimeFilter(idea, 'completed', now), false);
assert.equal(matchesTimeFilter(todo, 'unscheduled', now), true);
assert.equal(matchesTimeFilter(completed, 'unscheduled', now), false);
assert.equal(matchesTimeFilter(overdue, 'overdue', now), true);
assert.equal(matchesTimeFilter(today, 'today', now), true);
assert.equal(matchesTimeFilter(upcoming, 'week', now), true);
assert.deepEqual([todo, upcoming, today, overdue, completed].sort(compareTodos).map(item => dateGroup(item, now)),
  ['overdue', 'today', 'upcoming', 'unscheduled', 'completed']);
console.log('待办筛选与时间分组检查通过');
