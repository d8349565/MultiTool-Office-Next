import type { ComponentType } from 'react';
import type { IconProps } from '@phosphor-icons/react';
import {
  AppWindow,
  FileCode,
  TerminalWindow,
  FileXls,
  FileDoc,
  Presentation,
  FilePdf,
  FileText,
  FolderSimple,
  Globe,
  Archive,
  Image,
  File,
} from '@phosphor-icons/react';
import type { Launcher } from './types';
import { basename, cleanPath } from './domain';

export type LauncherKind =
  | 'python'
  | 'app'
  | 'script'
  | 'excel'
  | 'word'
  | 'ppt'
  | 'pdf'
  | 'markdown'
  | 'web'
  | 'folder'
  | 'archive'
  | 'media'
  | 'generic';

export interface LauncherTheme {
  primary: string;
  subtle: string;
  border: string;
  badgeBg: string;
  badgeText: string;
}

export interface LauncherVisual {
  kind: LauncherKind;
  label: string;
  badge: string;
  icon: ComponentType<IconProps>;
  theme: LauncherTheme;
  subtitle: string;
}

/**
 * 依据路径和名称智能推导工具类型与视觉元数据
 */
export function getLauncherVisual(launcher: Launcher): LauncherVisual {
  const rawPath = launcher.path?.trim() || '';
  const lowerPath = rawPath.toLowerCase();

  // 1. 网址入口 (http:// 或 https://)
  if (/^https?:\/\//i.test(lowerPath)) {
    let domain = '在线网页';
    try {
      const url = new URL(rawPath);
      domain = url.hostname;
    } catch {
      domain = rawPath.replace(/^https?:\/\//i, '').split('/')[0] || '在线服务';
    }
    return {
      kind: 'web',
      label: '网页入口',
      badge: 'WEB',
      icon: Globe,
      theme: {
        primary: '#0284c7',
        subtle: 'rgba(2, 132, 199, 0.1)',
        border: 'rgba(2, 132, 199, 0.28)',
        badgeBg: 'rgba(2, 132, 199, 0.14)',
        badgeText: '#0369a1',
      },
      subtitle: domain,
    };
  }

  // 提取文件后缀（如果无后缀或路径以斜杠结尾，则可能是文件夹）
  const parts = cleanPath(rawPath).split('/');
  const lastSegment = parts.at(-1) || '';
  const dotIndex = lastSegment.lastIndexOf('.');
  const ext = dotIndex > 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : '';

  // 2. Python 自动化脚本与 Notebook
  if (['py', 'pyw', 'ipynb'].includes(ext)) {
    const badge = ext === 'ipynb' ? 'NOTE' : ext.toUpperCase();
    return {
      kind: 'python',
      label: 'Python 脚本',
      badge,
      icon: FileCode,
      theme: {
        primary: '#2b7489',
        subtle: 'rgba(43, 116, 137, 0.12)',
        border: 'rgba(43, 116, 137, 0.3)',
        badgeBg: 'rgba(43, 116, 137, 0.16)',
        badgeText: '#1f5767',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 3. 命令行与系统终端脚本
  if (['bat', 'cmd', 'ps1', 'sh', 'vbs'].includes(ext)) {
    return {
      kind: 'script',
      label: '终端脚本',
      badge: ext.toUpperCase(),
      icon: TerminalWindow,
      theme: {
        primary: '#475569',
        subtle: 'rgba(71, 85, 105, 0.12)',
        border: 'rgba(71, 85, 105, 0.28)',
        badgeBg: 'rgba(71, 85, 105, 0.15)',
        badgeText: '#334155',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 4. 可执行应用程序与安装包
  if (['exe', 'msi', 'com'].includes(ext)) {
    return {
      kind: 'app',
      label: '应用程序',
      badge: ext.toUpperCase(),
      icon: AppWindow,
      theme: {
        primary: '#2563eb',
        subtle: 'rgba(37, 99, 235, 0.1)',
        border: 'rgba(37, 99, 235, 0.26)',
        badgeBg: 'rgba(37, 99, 235, 0.14)',
        badgeText: '#1d4ed8',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 5. 快捷方式 (.lnk / .url)
  if (ext === 'lnk' || ext === 'url') {
    return {
      kind: 'app',
      label: '快捷方式',
      badge: 'LNK',
      icon: AppWindow,
      theme: {
        primary: '#4338ca',
        subtle: 'rgba(67, 56, 202, 0.1)',
        border: 'rgba(67, 56, 202, 0.26)',
        badgeBg: 'rgba(67, 56, 202, 0.14)',
        badgeText: '#3730a3',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 6. 电子表格与数据文件
  if (['xlsx', 'xls', 'csv', 'tsv', 'xlsm'].includes(ext)) {
    return {
      kind: 'excel',
      label: '电子表格',
      badge: ext.toUpperCase(),
      icon: FileXls,
      theme: {
        primary: '#16a34a',
        subtle: 'rgba(22, 163, 74, 0.11)',
        border: 'rgba(22, 163, 74, 0.28)',
        badgeBg: 'rgba(22, 163, 74, 0.15)',
        badgeText: '#15803d',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 7. 办公文字文档
  if (['docx', 'doc', 'wps', 'odt', 'rtf'].includes(ext)) {
    return {
      kind: 'word',
      label: '办公文档',
      badge: ext.toUpperCase(),
      icon: FileDoc,
      theme: {
        primary: '#2563eb',
        subtle: 'rgba(37, 99, 235, 0.11)',
        border: 'rgba(37, 99, 235, 0.28)',
        badgeBg: 'rgba(37, 99, 235, 0.15)',
        badgeText: '#1d4ed8',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 8. 演示幻灯片
  if (['pptx', 'ppt', 'dps', 'odp'].includes(ext)) {
    return {
      kind: 'ppt',
      label: '演示幻灯',
      badge: ext.toUpperCase(),
      icon: Presentation,
      theme: {
        primary: '#ea580c',
        subtle: 'rgba(234, 88, 12, 0.11)',
        border: 'rgba(234, 88, 12, 0.28)',
        badgeBg: 'rgba(234, 88, 12, 0.15)',
        badgeText: '#c2410c',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 9. PDF 报表与电子书
  if (ext === 'pdf') {
    return {
      kind: 'pdf',
      label: 'PDF 文档',
      badge: 'PDF',
      icon: FilePdf,
      theme: {
        primary: '#dc2626',
        subtle: 'rgba(220, 38, 38, 0.11)',
        border: 'rgba(220, 38, 38, 0.28)',
        badgeBg: 'rgba(220, 38, 38, 0.15)',
        badgeText: '#b91c1c',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 10. Markdown 与文本笔记
  if (['md', 'markdown', 'txt', 'log'].includes(ext)) {
    return {
      kind: 'markdown',
      label: '文稿笔记',
      badge: ext.toUpperCase(),
      icon: FileText,
      theme: {
        primary: '#0d9488',
        subtle: 'rgba(13, 148, 136, 0.11)',
        border: 'rgba(13, 148, 136, 0.28)',
        badgeBg: 'rgba(13, 148, 136, 0.15)',
        badgeText: '#0f766e',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 11. 压缩归档文件
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return {
      kind: 'archive',
      label: '压缩归档',
      badge: ext.toUpperCase(),
      icon: Archive,
      theme: {
        primary: '#b45309',
        subtle: 'rgba(180, 83, 9, 0.11)',
        border: 'rgba(180, 83, 9, 0.28)',
        badgeBg: 'rgba(180, 83, 9, 0.15)',
        badgeText: '#92400e',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 12. 图像多媒体
  if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'mp4', 'mov'].includes(ext)) {
    return {
      kind: 'media',
      label: '多媒体',
      badge: ext.toUpperCase(),
      icon: Image,
      theme: {
        primary: '#9333ea',
        subtle: 'rgba(147, 51, 234, 0.11)',
        border: 'rgba(147, 51, 234, 0.28)',
        badgeBg: 'rgba(147, 51, 234, 0.15)',
        badgeText: '#7e22ce',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 13. 工作目录与文件夹（无后缀或以斜杠结尾）
  if (!ext || rawPath.endsWith('/') || rawPath.endsWith('\\')) {
    return {
      kind: 'folder',
      label: '工作目录',
      badge: 'DIR',
      icon: FolderSimple,
      theme: {
        primary: '#ca8a04',
        subtle: 'rgba(202, 138, 4, 0.12)',
        border: 'rgba(202, 138, 4, 0.3)',
        badgeBg: 'rgba(202, 138, 4, 0.16)',
        badgeText: '#a16207',
      },
      subtitle: formatParentPath(rawPath, lastSegment),
    };
  }

  // 14. 通用未知文件
  return {
    kind: 'generic',
    label: '本地文件',
    badge: (ext || 'FILE').toUpperCase().slice(0, 4),
    icon: File,
    theme: {
      primary: '#526652',
      subtle: 'rgba(82, 102, 82, 0.11)',
      border: 'rgba(82, 102, 82, 0.26)',
      badgeBg: 'rgba(82, 102, 82, 0.14)',
      badgeText: '#3a4a3a',
    },
    subtitle: formatParentPath(rawPath, lastSegment),
  };
}

/**
 * 辅助生成更直观的所在目录或辅助说明
 */
function formatParentPath(rawPath: string, lastSegment: string): string {
  const cleaned = cleanPath(rawPath);
  const parent = cleaned.slice(0, cleaned.length - lastSegment.length).replace(/\/$/, '');
  if (!parent) return basename(rawPath);
  // 返回父目录的名称，例如 "D:/Work/Project" 返回 "Project · 上级目录"
  return `${basename(parent)} / ${lastSegment}`;
}

/**
 * 类别统计与过滤辅助
 */
export interface CategoryCount {
  key: string;
  label: string;
  count: number;
}

export function computeCategoryCounts(launchers: Launcher[]): {
  typeCounts: CategoryCount[];
  groupCounts: CategoryCount[];
} {
  const typeMap = new Map<string, { label: string; count: number }>();
  const groupMap = new Map<string, number>();

  for (const l of launchers) {
    const visual = getLauncherVisual(l);
    const existing = typeMap.get(visual.kind);
    if (existing) {
      existing.count += 1;
    } else {
      typeMap.set(visual.kind, { label: visual.label, count: 1 });
    }

    const group = l.group?.trim() || '未分组';
    groupMap.set(group, (groupMap.get(group) || 0) + 1);
  }

  const typeCounts: CategoryCount[] = Array.from(typeMap.entries()).map(([key, val]) => ({
    key,
    label: val.label,
    count: val.count,
  }));

  const groupCounts: CategoryCount[] = Array.from(groupMap.entries()).map(([key, count]) => ({
    key,
    label: key,
    count,
  }));

  return { typeCounts, groupCounts };
}
