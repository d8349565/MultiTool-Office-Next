import { CaretRight } from '@phosphor-icons/react';
import type { DeliveryTable } from './types';

// 任务字段结果是正文答案的佐证，不是主角：默认收起成一行，长路径单行省略。
// 展开后行数多时内部滚动，不再把整条对话往下顶。
export function AssistantDelivery({delivery}:{delivery?:DeliveryTable|null}){
  if(!delivery)return null;
  if(!delivery.rows.length)return <div className="assistant-delivery"><p>共 {delivery.total} 项，当前范围没有匹配的记录。</p></div>;
  const summary=`${delivery.columns.map(c=>c.label).join('、')} · 共 ${delivery.total} 项，当前展示 ${delivery.rows.length} 项`;
  return <div className="assistant-results"><details className="assistant-result-group assistant-delivery" aria-label="任务字段结果">
    <summary><CaretRight size={14} aria-hidden="true"/>任务字段结果 <span>{summary}</span><span className="assistant-result-toggle" aria-hidden="true"/></summary>
    <div className="markdown-table"><table>
      <thead><tr>{delivery.columns.map(c=><th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
      <tbody>{delivery.rows.map(r=><tr key={r.path} title={r.path}>{r.values.map((value,i)=><td key={delivery.columns[i]?.key||i} title={value}>{value}</td>)}{r.notice&&<td>{r.notice}</td>}</tr>)}</tbody>
    </table></div>
  </details></div>;
}
