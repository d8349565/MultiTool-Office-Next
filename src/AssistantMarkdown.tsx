import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localLink, webLink, type Link } from './assistantState';

/**
 * Shared Markdown renderer for the assistant and the translation preview.
 * `onLink` is optional: the assistant passes it to route local paths through the
 * workspace, while the translation preview omits it and only allows external links.
 */
export function MarkdownView({text,onLink}:{text:string;onLink?:(link:Link)=>void}) {
  return <div className="assistant-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml
    urlTransform={url=>localLink(url)||webLink(url)?url:''}
    components={{
      a:({href,children})=>{
        const link=href?localLink(href):null;
        if(link&&onLink)return <a href={href} title={link.kind==='file'?'在资源管理器中定位文件':undefined} onClick={e=>{e.preventDefault();onLink(link);}}>{children}</a>;
        // A local path with nowhere to navigate stays inert instead of opening a broken link.
        if(link)return <span>{children}</span>;
        return href?<a href={href} target="_blank" rel="noreferrer noopener" onClick={onLink?e=>{e.preventDefault();onLink({kind:'web',target:href,label:href});}:undefined}>{children}</a>:<span>{children}</span>;
      },
      img:({alt})=><span>{alt?`[图片：${alt}]`:'[图片]'}</span>,
      table:({children})=><div className="markdown-table"><table>{children}</table></div>,
    }}>{text}</Markdown></div>;
}

/** Assistant entry point: identical to `MarkdownView` with local-path routing enabled. */
export function AssistantMarkdown({text,onLink}:{text:string;onLink:(link:Link)=>void}) {
  return <MarkdownView text={text} onLink={onLink}/>;
}
