import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TodoQuadrant } from './types';

// 内部卡片移动使用指针事件，避免 Windows 原生文件拖放拦截网页拖拽。
export function useTodoDrag(move: (id: string, quadrant: TodoQuadrant) => void, disabled: boolean, visible: boolean) {
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; quadrant: TodoQuadrant | null } | null>(null);
  const gesture = useRef<{ id: string; pointer: number; x: number; y: number; active: boolean; element: HTMLElement } | null>(null);
  const suppressClick = useRef(false);
  const moveRef = useRef(move);
  moveRef.current = move;

  useEffect(() => {
    const targetAt = (x: number, y: number): TodoQuadrant | null => {
      const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-todo-quadrant]');
      if (!target) return null;
      const q = Number(target.dataset.todoQuadrant);
      return [0, 1, 2, 3, 4].includes(q) ? q as TodoQuadrant : null;
    };
    const cancel = () => {
      const current = gesture.current;
      gesture.current = null;
      if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
      setDrag(null);
    };
    const onMove = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointer) return;
      if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
      if (!current.active) current.element.setPointerCapture(current.pointer);
      current.active = true;
      suppressClick.current = true;
      event.preventDefault();
      setDrag({ id: current.id, x: event.clientX, y: event.clientY, quadrant: targetAt(event.clientX, event.clientY) });
    };
    const onUp = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointer) return;
      const target = current.active ? targetAt(event.clientX, event.clientY) : null;
      cancel();
      if (target !== null) moveRef.current(current.id, target);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', onKey, true);
      const current = gesture.current;
      gesture.current = null;
      if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
    };
  }, []);

  useEffect(() => {
    if (disabled || !visible) {
      const current = gesture.current;
      gesture.current = null;
      if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
      setDrag(null);
    }
  }, [disabled, visible]);

  return {
    drag,
    start: (event: ReactPointerEvent<HTMLElement>, id: string) => {
      suppressClick.current = false;
      if (disabled || !visible || event.button !== 0 || !event.isPrimary) return;
      const target = event.target as HTMLElement;
      if (target.closest('button,input,textarea,select,a,form,[contenteditable]')) return;
      if (event.pointerType === 'touch' && !target.closest('.todo-drag-handle')) return;
      gesture.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, element: event.currentTarget };
    },
    suppressClick: (event: React.MouseEvent) => {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
    },
  };
}
