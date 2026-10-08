import { X, SlidersHorizontal, Sparkle } from '@phosphor-icons/react';
import { IconButton } from './components';
import { billingReasons, costMetrics, money, periodLabels } from './assistantPricing';

export function AssistantCost({cost,onClose,onConfigure,onReview,reviewDisabled}:{cost:ReturnType<typeof costMetrics>;onClose:()=>void;onConfigure:()=>void;onReview:()=>void;reviewDisabled:boolean}){
  return <section id="assistant-cost-panel" className="assistant-cost-panel" aria-label="会话费用明细">
    <header><div><strong>本会话费用</strong><p>按 API 返回用量及请求时单价计算</p></div><IconButton label="关闭费用明细" onClick={onClose}><X/></IconButton></header>
    {!!cost.totals.length&&<div className="assistant-cost-totals">{cost.totals.map(t=><div key={t.currency}><strong>{money(t.total,t.currency)}</strong><span>{t.currency} · {t.requests} 次已计价请求{cost.missing?' · 部分费用':''}</span><dl><div><dt>未缓存输入</dt><dd>{money(t.inputCost,t.currency)}</dd></div><div><dt>缓存输入</dt><dd>{money(t.cachedCost,t.currency)}</dd></div><div><dt>输出</dt><dd>{money(t.outputCost,t.currency)}</dd></div></dl></div>)}</div>}
    {cost.missing>0&&<p className="assistant-cost-notice" role="status">{cost.missing} 次请求无法完整计费：{[...new Set(cost.records.filter(r=>r.status!=='calculated').map(r=>billingReasons[r.reason||'legacy']||'计费资料不足'))].join('；')}。未计入上述金额。</p>}
    {!cost.records.length&&<p className="assistant-cost-notice">发送消息后，这里会显示实际返回的用量和费用。</p>}
    {!!cost.records.length&&<details className="assistant-cost-requests"><summary>查看每次请求与价格快照</summary><ol>{cost.records.map((r,i)=><li key={i}><div><strong>{r.model||'模型请求'}</strong><span>{r.status==='calculated'?money(r.total!,r.currency!):'无法计费'}</span></div>{r.status==='calculated'&&r.rule?<><p>{periodLabels[r.period||'flat']} · {r.requestedAt?new Date(r.requestedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'时间未知'} · 配置版本 {r.revision}</p><p>每百万 token：输入 {r.rule.inputPerMillion} / 缓存 {r.rule.cachedInputPerMillion} / 输出 {r.rule.outputPerMillion} {r.currency}{r.period==='off_peak'?`，乘以空闲折扣 ${r.rule.offPeakDiscount}`:''}</p><p>输入 {r.inputTokens?.toLocaleString()} + 缓存 {r.cachedTokens?.toLocaleString()} + 输出 {r.outputTokens?.toLocaleString()}</p></>:<p>{billingReasons[r.reason||'legacy']||'计费资料不足'}</p>}</li>)}</ol></details>}
    <footer><p>已发生的费用保留当时的价格。此金额供核对，以服务商账单为准；未包含联网搜索等其他服务费用。</p><div className="assistant-cost-actions"><IconButton label="计价配置" onClick={onConfigure}><SlidersHorizontal size={18}/></IconButton><IconButton label="让助手核对最新价格，整理调整建议后由你确认" disabled={reviewDisabled} onClick={onReview}><Sparkle size={18}/></IconButton></div></footer>
  </section>;
}
