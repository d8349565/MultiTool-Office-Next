import { useState, type ReactNode } from 'react';
import { Button } from '@fluentui/react-components';
import { api } from './api';

export function OfficialLink({url,children}:{url:string;children:ReactNode}){
  const [error,setError]=useState('');
  return <><Button type="button" size="small" onClick={()=>{setError('');void api('open_web_url',{url}).catch(e=>setError(String(e)));}}>{children} ↗</Button>{error&&<span className="inline-error" role="alert">{error}</span>}</>;
}
export function KeyGuide({service,open=false}:{service:'deepseek'|'tavily';open?:boolean}){
  const deepseek=service==='deepseek';
  return <details className="service-guide" open={open||undefined}>
    <summary>{deepseek?'如何获取 DeepSeek API Key？':'如何获取 Tavily API Key？'}</summary>
    <p>{deepseek?'DeepSeek 为助手、翻译、待办辅助和 AI 配置生成提供模型能力。':'Tavily 负责查询公开互联网资料。它使用独立 Key，与 DeepSeek 的 Key 不通用。'}</p>
    <ol><li>打开下方官方平台，注册或登录自己的账号。</li><li>{deepseek?'进入 API keys，创建 API Key，并复制完整密钥。':'在 Dashboard 中找到 API Keys，创建或复制自己的密钥。'}</li><li>返回本窗口，粘贴 Key，点击测试；成功后再启用对应配置。</li></ol>
    <div className="button-row"><OfficialLink url={deepseek?'https://platform.deepseek.com/api_keys':'https://app.tavily.com/'}>打开{deepseek?' DeepSeek':' Tavily'} 官方平台</OfficialLink><OfficialLink url={deepseek?'https://api-docs.deepseek.com/zh-cn/':'https://docs.tavily.com/documentation/quickstart'}>官方使用说明</OfficialLink></div>
    <p className="muted">软件免费，外部 API 的费用及额度以服务商账户为准。测试也可能消耗额度。Key 只保存在 Windows 凭据管理器，请勿填写到聊天或角色文件中。</p>
  </details>;
}
