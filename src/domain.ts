export const cleanPath = (path: string) => path.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/$/, '');
export const samePath = (a: string, b: string) => cleanPath(a).toLowerCase() === cleanPath(b).toLowerCase();
export const basename = (p: string) => cleanPath(p).split('/').at(-1) || p;
export const dirname = (p: string) => { const path = cleanPath(p); const index = path.lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index) || '/'; };
export function isWithin(path: string, root: string) { const p = cleanPath(path).toLowerCase(); const r = cleanPath(root).toLowerCase(); return p === r || p.startsWith(r + '/'); }
export function selectLevel(trail: string[], level: number, path: string) { return [...trail.slice(0, level), path]; }
export function locateTrail(root: string, parent: string) {
  if (!isWithin(parent, root)) throw new Error('文件不在此工作目录内');
  const r = cleanPath(root), relative = cleanPath(parent).slice(r.length).replace(/^\//, '');
  if (!relative) return [];
  let path = r; return relative.split('/').map(part => path += '/' + part);
}
export function relativePath(path: string, root: string) { return isWithin(path, root) ? cleanPath(path).slice(cleanPath(root).length).replace(/^\//, '') : cleanPath(path); }
export function sizeLabel(n: number) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`; }

// Local paths are case-insensitive; URL paths and query values are not.
export function openActionKey(target: string, reveal = false) {
  const raw = target.trim();
  const key = /^https?:\/\//i.test(raw) ? new URL(raw).href : cleanPath(raw.replace(/^\\\\\?\\UNC\\/i, '\\\\')).toLowerCase();
  return `${reveal ? 'reveal' : 'open'}:${key}`;
}
