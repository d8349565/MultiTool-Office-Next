import './fileIcon.css';

const icons = import.meta.glob<string>('./assets/file-icons/*.svg', { eager: true, query: '?url', import: 'default' });

const fileTypes = [
  { kind: 'pdf', extensions: ['pdf'], label: 'PDF 文档' },
  { kind: 'ofd', extensions: ['ofd'], label: 'OFD 文档' },
  { kind: 'word', extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt', 'wps', 'pages'], label: '文字文档' },
  { kind: 'excel', extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'csv', 'tsv', 'ods', 'et', 'numbers'], label: '电子表格' },
  { kind: 'slides', extensions: ['ppt', 'pptx', 'pptm', 'pot', 'potx', 'potm', 'pps', 'ppsx', 'ppsm', 'odp', 'dps', 'key', 'keynote'], label: '演示文稿' },
  { kind: 'text', extensions: ['txt', 'text', 'log', 'md', 'markdown', 'rst', 'nfo'], label: '文本文件' },
  { kind: 'image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico', 'psd', 'ai', 'eps'], label: '图片与设计文件' },
  { kind: 'archive', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'iso'], label: '压缩包与镜像' },
  { kind: 'audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'opus', 'aiff', 'mid', 'midi'], label: '音频' },
  { kind: 'video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'webm', 'm4v', 'flv', 'mpg', 'mpeg', 'm2ts', '3gp'], label: '视频' },
  { kind: 'code', extensions: ['html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte', 'py', 'pyw', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'swift', 'kt', 'ipynb', 'sql', 'ps1', 'bat', 'cmd', 'sh'], label: '代码与脚本' },
  { kind: 'config', extensions: ['json', 'jsonc', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'properties'], label: '配置文件' },
  { kind: 'cad', extensions: ['dwg', 'dxf', 'dgn', 'ifc', 'step', 'stp', 'iges', 'igs', 'stl', 'obj', 'skp', 'blend'], label: 'CAD 与三维模型' },
  { kind: 'mail', extensions: ['eml', 'msg', 'emlx', 'mbox', 'oft'], label: '邮件' },
  { kind: 'database', extensions: ['db', 'sqlite', 'sqlite3', 'accdb', 'mdb', 'dbf', 'parquet', 'arrow', 'feather'], label: '数据库与数据文件' },
  { kind: 'app', extensions: ['exe', 'msi', 'msix', 'appx', 'apk', 'dmg', 'pkg', 'lnk', 'url', 'desktop'], label: '应用与快捷方式' },
  { kind: 'font', extensions: ['ttf', 'otf', 'woff', 'woff2', 'eot'], label: '字体' },
];

export function FileIcon({ extension }: { extension: string }) {
  const normalized = extension.trim().replace(/^\./, '').toLowerCase();
  const type = fileTypes.find(item => item.extensions.includes(normalized));
  const label = normalized ? `${normalized.toUpperCase()} · ${type?.label || '文件'}` : '文件';
  return <span className={`file-icon file-icon-${type?.kind || 'other'}`} role="img" aria-label={label} title={label}>
    <img src={icons[`./assets/file-icons/${type?.kind || 'other'}.svg`]} alt="" aria-hidden="true" width={32} height={40} draggable={false} />
  </span>;
}
