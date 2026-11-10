import { useState, type KeyboardEvent } from 'react';
import { Button } from '@fluentui/react-components';
import { desktop } from './api';
import { defaultShortcuts, keyboardShortcut, shortcutError, shortcutLabels, shortcutText, type ShortcutAction, type ShortcutBindings } from './shortcuts';
import './shortcutSettings.css';

export function ShortcutSettings({ bindings, savedGlobal, globalActive, onChange }:{
  bindings:ShortcutBindings; savedGlobal:string|null; globalActive:boolean|undefined; onChange:(bindings:ShortcutBindings)=>void;
}) {
  const [recording,setRecording]=useState<ShortcutAction|null>(null);
  const [error,setError]=useState<{action:ShortcutAction;text:string}|null>(null);
  function record(event:KeyboardEvent<HTMLButtonElement>,action:ShortcutAction) {
    if(recording!==action||event.key==='Tab')return;
    event.preventDefault();event.stopPropagation();
    if(event.key==='Escape'){setRecording(null);setError(null);return;}
    if(event.repeat||event.nativeEvent.isComposing||['Control','Alt','Shift','Meta'].includes(event.key))return;
    const binding=keyboardShortcut(event.nativeEvent);
    const problem=binding?shortcutError(action,binding,bindings):'请按 Ctrl 或 Alt 加字母、数字组合键。';
    if(problem){setError({action,text:problem});return;}
    onChange({...bindings,[action]:binding});
    setError(null);setRecording(null);
  }
  function row(action:ShortcutAction) {
    const binding=bindings[action], active=recording===action, problem=error?.action===action?error.text:'';
    const unavailable=action==='globalQuick'&&binding&&binding===savedGlobal&&globalActive===false;
    const described=active||problem||unavailable?'shortcut-feedback-'+action:undefined;
    return <div className="shortcut-row" key={action}>
      <span>{shortcutLabels[action]}</span>
      <div className="shortcut-controls">
        <Button type="button" size="small" className="shortcut-capture" aria-pressed={active}
          aria-label={`${active?'取消录入':'更改'}${shortcutLabels[action]}${!active&&binding?'：'+shortcutText(binding):''}`}
          aria-describedby={described} data-recording={active||undefined}
          onClick={()=>{setRecording(active?null:action);setError(null);}} onBlur={()=>setRecording(null)} onKeyDown={event=>record(event,action)}>
          {active?'请按组合键…':binding?<kbd>{shortcutText(binding)}</kbd>:'未设置'}
        </Button>
        <Button type="button" size="small" appearance="subtle" disabled={!binding} aria-label={'停用'+shortcutLabels[action]}
          onClick={()=>{onChange({...bindings,[action]:null});setError(null);}}>停用</Button>
      </div>
      {described&&<p className={problem?'shortcut-error':''} id={described} role={problem?'alert':'status'}>
        {problem||(active?'按下新的组合键，Esc 取消。':'当前组合键未注册，可能被系统或其他程序占用。请更改后保存。')}
      </p>}
    </div>;
  }
  return <>
    <section className="settings-section">
      <div className="shortcut-heading"><h3>切换页面</h3>
        <Button type="button" size="small" onClick={()=>{onChange({...defaultShortcuts,...(!desktop?{globalQuick:bindings.globalQuick}:{})});setRecording(null);setError(null);}}>恢复默认快捷键</Button>
      </div>
      {(['files','tools','ocr','todo'] as const).map(row)}
    </section>
    <section className="settings-section">
      <h3>搜索与快捷面板</h3>
      {row('search')}{row('quick')}{desktop&&row('globalQuick')}
    </section>
    <details className="settings-advanced shortcut-help"><summary>其他常用操作</summary>
      <p><kbd>F2</kbd> 重命名当前文件或目录</p>
      <p><kbd>Ctrl + 左键</kbd> 或 <kbd>Ctrl + 空格</kbd> 增减文件选择</p>
      <p><kbd>Ctrl + 悬停</kbd> 临时预览；<kbd>Ctrl + Enter</kbd> 固定预览</p>
      <p><kbd>Esc</kbd> 关闭弹窗或预览</p>
    </details>
  </>;
}
