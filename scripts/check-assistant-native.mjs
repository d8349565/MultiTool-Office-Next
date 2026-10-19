import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import ts from 'typescript';
import { build as bundle } from 'esbuild';

// 独立 bundle identifier、数据目录、WebView2 配置和回环服务；不加载主界面或生产配置。
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=join(root,'test-results');mkdirSync(base,{recursive:true});
const folder=mkdtempSync(join(base,'assistant-native-'));
const data=join(folder,'data'),workspace=join(folder,'workspace');
mkdirSync(data);mkdirSync(workspace);mkdirSync(join(folder,'webview'));
const source='这是完全虚构的助理流程验证资料，编号 AUDIT-2026。';
writeFileSync(join(workspace,'audit-source.txt'),source);
writeFileSync(join(workspace,'keep.txt'),'既有虚构文件，不得覆盖。');
const moduleCode=ts.transpileModule(readFileSync(join(root,'src/officeAgent.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
writeFileSync(join(folder,'officeAgent.mjs'),moduleCode);
const {createOfficeAgent}=await import(pathToFileURL(join(folder,'officeAgent.mjs')).href);
const uiBundle=await bundle({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{FluentProvider,webLightTheme}from'@fluentui/react-components';import{AssistantFileApprovals}from'./src/AssistantFileApprovals';function Audit(){React.useEffect(()=>{window.__auditUIReady=true},[]);return <FluentProvider theme={webLightTheme} className="office-app"><aside inert aria-hidden="true"><AssistantFileApprovals taskId="" open={false} onSelectTask={()=>{}}/></aside></FluentProvider>}document.body.innerHTML='<div id="root"></div>';createRoot(document.getElementById('root')).render(<Audit/>);`,resolveDir:root,sourcefile:'assistant-audit-ui.tsx',loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const requests=new Map(),results=[];let child,childExit,cdp;
const documentCases=['pdf','docx','xlsx','pptx','html','create','resume-create','reject','cancel','collision','read','read-reject','read-changed','collapsed','revoke','after-revoke'];
function frames(response,message,finish='stop'){
  response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  response.write('data: '+JSON.stringify({model:'MiniMax-M3.1-Flash-Preview',choices:[{index:0,delta:message}]})+'\n\n');
  response.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}]})+'\n\n');
  response.end('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:30,total_tokens:1030}})+'\n\ndata: [DONE]\n\n');
}
function tools(response,name,args){frames(response,{tool_calls:[{index:0,id:'audit-'+crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');}
const server=http.createServer(async(request,response)=>{
  if(request.url==='/audit-ui.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end(uiBundle.outputFiles[0].contents);return;}
  if(request.method==='GET'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><title>Isolated assistant workflow audit</title><p>Virtual data only.</p>');return;}
  try{
    let raw='';for await(const chunk of request){raw+=chunk;if(raw.length>2_000_000)throw new Error('fixture request too large');}
    const body=JSON.parse(raw);
    const names=(body.messages||[]).flatMap(m=>typeof m.content==='string'?[...m.content.matchAll(/AUDIT_CASE:([a-z-]+)/g)].map(m=>m[1]):[]);
    const name=names.at(-1);assert.ok(name,'Missing synthetic case marker');
    const rows=requests.get(name)||[];rows.push(body);requests.set(name,rows);
    if(body.tools?.length===1&&body.tools[0].function.name==='interpret_task'){
      const document=documentCases.includes(name);
      tools(response,'interpret_task',{relation:'new',goal:'虚构流程验证 AUDIT_CASE:'+name,operation:document?'document':'chat',scope:'current',delivery:document&&!name.startsWith('read')?'file':'answer',needsTools:document});return;
    }
    const round=rows.filter(row=>row.tools?.[0]?.function.name!=='interpret_task').length;
    if(name==='stream-error'){
      response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({error:{code:'E_AUDIT',type:'server_error',message:'synthetic error sk-audit-secret'},request_id:'audit-request-1'})+'\n\n');return;
    }
    if(name==='bad-finish'){
      response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'未确认完整的虚构回复'}}]})+'\n\ndata: [DONE]\n\n');return;
    }
    if(name==='multiline'){
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      response.end('data: {"model":"audit-model",\ndata: "choices":[{"index":0,"delta":{"content":"多行事件已完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');return;
    }
    if(name==='context'&&round===1){response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{code:'context_length_exceeded',message:'synthetic maximum context length'}}));return;}
    if(name==='cancel-stream'){
      response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'可保留的虚构流式内容'}}]})+'\n\n');return;
    }
    if(round===1&&documentCases.includes(name)){
      if(name.startsWith('read')){tools(response,'workspace_read_file',{filename:'audit-source.txt'});return;}
      const format=['pdf','docx','xlsx','pptx','html'].includes(name)?name:'txt';
      const content=format==='pptx'?{slides:[{title:'虚构测试页',bullets:['中文排版','不含业务资料']}]}:{...(format!=='xlsx'?{paragraphs:['仅用于隔离模拟测试，不含业务数据。']}:{}),columns:['项目','结果'],rows:[['中文排版','虚构测试']]};
      tools(response,'document_create',{filename:name==='collision'?'keep.txt':'audit-'+name+'.'+format,format,title:'流程验证虚构文档',...content});return;
    }
    if(name==='resume-create'){response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: {"error":{"code":"E_AFTER_SAVE","message":"synthetic failure after save"}}\n\n');return;}
    frames(response,{content:'虚构任务已完成。'});
  }catch(error){response.writeHead(500);response.end(JSON.stringify({error:{message:String(error)}}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const portPicker=http.createServer();await new Promise(resolve=>portPicker.listen(0,'127.0.0.1',resolve));
const debugPort=portPicker.address().port;await new Promise(resolve=>portPicker.close(resolve));
const settings={schemaVersion:1,revision:0,roots:[],theme:'light',recursive:true,filter:'',launchers:[],modelUrl:origin+'/v1',modelId:'MiniMax-M3.1-Flash-Preview',jevEnabled:false,modelContextTokens:128000,assistantOutputTokens:4096,modelRequestTimeoutSecs:10,modelFirstResponseTimeoutSecs:10,modelIdleTimeoutSecs:10,modelRetryCount:0,assistantTaskTimeoutSecs:45};
writeFileSync(join(data,'settings.json'),JSON.stringify(settings));
const env={...process.env,RUSTUP_TOOLCHAIN:'stable-x86_64-pc-windows-gnu',CARGO_NET_OFFLINE:'true',PATH:join(root,'.tools/mingw64/bin')+';'+process.env.PATH,TAURI_CONFIG:JSON.stringify({identifier:'com.multitool.office.next.audit',productName:'Assistant Workflow Audit',build:{devUrl:origin+'/audit.html'}}),OFFICE_NEXT_TEST_DATA_DIR:data,OFFICE_NEXT_TEST_MODEL:'1',OFFICE_NEXT_TEST_WINDOW_HIDDEN:'1',WEBVIEW2_USER_DATA_FOLDER:join(folder,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-address=127.0.0.1 --remote-debugging-port='+debugPort,NO_PROXY:'127.0.0.1,localhost',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:''};
class CDP{
  constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();socket.addEventListener('message',event=>{const packet=JSON.parse(event.data);if(!packet.id)return;const waiter=this.pending.get(packet.id);if(!waiter)return;this.pending.delete(packet.id);clearTimeout(waiter.timer);packet.error?waiter.reject(new Error(packet.error.message)):waiter.resolve(packet.result);});socket.addEventListener('close',()=>{for(const waiter of this.pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('Owned audit WebView closed'));}this.pending.clear();});}
  call(method,params={}){return new Promise((resolve,reject)=>{const id=++this.id;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timed out: '+method));},60_000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const result=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.exception?.value||result.exceptionDetails.text);return result.result.value;}
  invoke(command,args={}){return this.evaluate('window.__TAURI_INTERNALS__.invoke('+JSON.stringify(command)+','+JSON.stringify(args)+')');}
}
async function task(name,{sessionId=crypto.randomUUID(),action,approve=true,cancel=false,beforeApproval,observe,respondOnly=false}={}){
  const id=crypto.randomUUID();let settled=false,value,error,agent;
  const history=name==='context'?[{role:'assistant',content:'虚构历史资料。'.repeat(2000)}]:[];
  const result=cdp.invoke('ai_task',{id,kind:'agent',text:'执行虚构任务 AUDIT_CASE:'+name,context:{sessionId,action,history,respondOnly,view:{page:'files',root:'',currentDirectory:''},localTime:new Date().toString(),timeZone:'Asia/Shanghai'}}).then(v=>{value=v;settled=true;},e=>{error=e;settled=true;});
  const started=Date.now(),deadline=started+55_000;let diagnostic=false;
  while(!settled&&Date.now()<deadline){
    const network=await cdp.invoke('network_status');
    for(const pending of network.pending){assert.equal(pending.grant.service,origin);await cdp.invoke('network_decide',{id:pending.id,approve:true});}
    const snapshot=await cdp.invoke('task_status',{id}).catch(()=>null);
    if(observe)await observe(snapshot,id);
    if(!agent&&snapshot?.piRuntime){agent=createOfficeAgent(snapshot.piRuntime,action=>cdp.invoke('pi_step',{id,action}));void agent.prompt('执行已授权的虚构任务').catch(()=>{});}
    const approvals=await cdp.invoke('assistant_workspace_pending');
    if(name==='pdf'&&!diagnostic&&Date.now()-started>1500){
      diagnostic=true;
      const targets=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
      writeFileSync(join(folder,'pdf-pages.json'),JSON.stringify(targets.map(t=>({title:t.title,url:t.url.slice(0,500),type:t.type})),null,2));
    }
    for(const notice of approvals.filter(a=>a.taskId===id)){
      assert.equal(resolve(notice.directory),resolve(workspace));
      if(beforeApproval&&await beforeApproval(notice))continue;
      if(cancel)await cdp.invoke('cancel_task',{id});else await cdp.invoke('assistant_workspace_decide',{id:notice.id,approve,acknowledgedRisks:false});
    }
    await delay(60);
  }
  if(!settled){await cdp.invoke('cancel_task',{id});throw new Error('Native task did not finish: '+name);}
  await result;if(error)throw error;return {value,id,sessionId};
}
async function check(name,run){const filter=process.argv.find(arg=>arg.startsWith('--filter='))?.slice(9);if(filter&&!name.includes(filter))return;try{await run();results.push({name,passed:true});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:String(error)});console.error('FAIL '+name+': '+error.message);}}
const exe=join(folder,'assistant-audit.exe');
async function bootNative(){
  const out=openSync(join(folder,'native.stdout.log'),'a'),err=openSync(join(folder,'native.stderr.log'),'a');
  child=spawn(exe,[],{cwd:root,env,windowsHide:true,stdio:['ignore',out,err]});closeSync(out);closeSync(err);
  childExit=once(child,'exit');writeFileSync(join(folder,'owner.json'),JSON.stringify({nodePid:process.pid,childPid:child.pid,folder,origin,debugPort}));
  const readyDeadline=Date.now()+35_000;let target;
  while(Date.now()<readyDeadline){
    if(child.exitCode!==null)throw new Error('Audit process exited: '+child.exitCode+' '+readFileSync(join(folder,'native.stderr.log'),'utf8'));
    try{const targets=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list',{signal:AbortSignal.timeout(800)})).json();target=targets.find(item=>item.url===origin+'/audit.html');if(target)break;}catch{}
    await delay(200);
  }
  assert.ok(target,'Isolated audit WebView did not start');
  const socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');cdp=new CDP(socket);
  const bridgeDeadline=Date.now()+10_000;
  while(Date.now()<bridgeDeadline&&await cdp.evaluate('typeof window.__TAURI_INTERNALS__?.invoke')!=='function')await delay(100);
  assert.equal(await cdp.evaluate('typeof window.__TAURI_INTERNALS__?.invoke'),'function',JSON.stringify(await cdp.evaluate('({ready:document.readyState,bridge:Object.keys(window.__TAURI_INTERNALS__||{})})')));
  await cdp.evaluate('import('+JSON.stringify(origin+'/audit-ui.js')+')');
  const uiDeadline=Date.now()+5000;while(Date.now()<uiDeadline&&!await cdp.evaluate('!!window.__auditUIReady'))await delay(60);
  assert.ok(await cdp.evaluate('!!window.__auditUIReady'));
}
async function grantWorkspace(){
  await cdp.invoke('assistant_workspace_set',{path:workspace});
  const challenge=await cdp.invoke('assistant_workspace_prepare');
  await cdp.invoke('assistant_workspace_confirm',{id:challenge.id,acknowledgedRisks:true});
}
try{
  const build=spawn('cargo.exe',['build','--offline','--manifest-path','src-tauri/Cargo.toml'],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  const [code]=await once(build,'exit');assert.equal(code,0,'Isolated audit executable failed to build');
  copyFileSync(join(root,'src-tauri/target/debug/office-next.exe'),exe);
  const loader=join(root,'src-tauri/target/debug/WebView2Loader.dll');if(existsSync(loader))copyFileSync(loader,join(folder,'WebView2Loader.dll'));
  await bootNative();await grantWorkspace();
  await check('普通问答不携带工具',async()=>{const {value}=await task('chat');assert.equal(value.status,'completed');const body=requests.get('chat').find(row=>row.tools?.[0]?.function.name!=='interpret_task');assert.equal(body.tools,undefined);});
  await check('TXT 生成与交付登记',async()=>{const {value}=await task('create');assert.equal(value.status,'completed');assert.ok(existsSync(join(workspace,'audit-create.txt')));assert.ok(value.trace.some(row=>row.result.href?.startsWith('office-report:')));});
  await check('助手收起时弹出确认并可通过真实按钮保存',async()=>{
    const submitted=new Set();const {value}=await task('collapsed',{beforeApproval:async notice=>{
      if(submitted.has(notice.id))return true;
      const deadline=Date.now()+3000;let visible=false;
      while(Date.now()<deadline){visible=await cdp.evaluate('!![...document.querySelectorAll("dialog[open]")].find(dialog=>dialog.textContent.includes('+JSON.stringify(notice.filename)+')&&!dialog.closest("[inert]"))');if(visible)break;await delay(40);}
      assert.ok(visible,'收起的助手未展示独立文件确认');submitted.add(notice.id);
      await cdp.evaluate('[...document.querySelectorAll("dialog[open] button")].find(button=>button.textContent.includes("确认生成这个文件")).click()');return true;
    }});assert.equal(value.status,'completed');assert.ok(existsSync(join(workspace,'audit-collapsed.txt')));
  });
  await check('PDF 实际排版保存',async()=>{const {value}=await task('pdf');assert.equal(value.status,'completed',JSON.stringify(value.fault));const bytes=readFileSync(join(workspace,'audit-pdf.pdf'));assert.ok(bytes.subarray(0,5).equals(Buffer.from('%PDF-')));assert.ok(bytes.length>2000,'PDF 不应只有空白页');});
  await check('Word Excel PPT HTML 逐个确认生成',async()=>{for(const format of ['docx','xlsx','pptx','html']){const {value}=await task(format);assert.equal(value.status,'completed',JSON.stringify(value.fault));const bytes=readFileSync(join(workspace,'audit-'+format+'.'+format));assert.ok(bytes.length>100);assert.ok(format==='html'?bytes.includes(Buffer.from('流程验证虚构文档')):bytes.subarray(0,2).equals(Buffer.from('PK')));}});
  await check('文件浏览范围为空时仍可预览助理生成链接',async()=>{
    for(const [name,kind]of[['audit-create.txt','text'],['audit-docx.docx','text'],['audit-xlsx.xlsx','table'],['audit-pdf.pdf','image']]){
      const preview=await cdp.invoke('file_preview',{path:join(workspace,name),requestId:crypto.randomUUID(),page:1,sheet:0});assert.equal(preview.kind,kind);
      if(kind==='image'){assert.ok(preview.image.startsWith('data:image/png;base64,'));writeFileSync(join(folder,'pdf-preview.png'),Buffer.from(preview.image.split(',')[1],'base64'));}
      else assert.ok(JSON.stringify(preview).includes('中文排版'),name+' 正文缺失');
    }
  });
  await check('读取确认后才把虚构正文发送给模型',async()=>{const {value}=await task('read');assert.equal(value.status,'completed');assert.equal(value.taskContext.hasWorkspaceFileData,true);assert.ok(requests.get('read').some(body=>JSON.stringify(body).includes(source)));});
  await check('拒绝读取不发送正文',async()=>{const {value}=await task('read-reject',{approve:false});assert.equal(value.status,'cancelled');assert.equal(requests.get('read-reject').some(body=>JSON.stringify(body).includes(source)),false);});
  await check('确认期间文件变化不发送新旧正文',async()=>{try{const {value}=await task('read-changed',{beforeApproval:async()=>{writeFileSync(join(workspace,'audit-source.txt'),'变更后的虚构内容 AUDIT-CHANGED');return false;}});assert.ok(value.trace.some(row=>/等待确认期间发生变化/.test(row.result.error)),JSON.stringify(value.trace));assert.equal(requests.get('read-changed').some(body=>JSON.stringify(body).includes(source)||JSON.stringify(body).includes('AUDIT-CHANGED')),false);}finally{writeFileSync(join(workspace,'audit-source.txt'),source);}});
  await check('拒绝文件操作不生成文件',async()=>{const {value}=await task('reject',{approve:false});assert.equal(value.status,'cancelled');assert.equal(existsSync(join(workspace,'audit-reject.txt')),false);});
  await check('取消等待确认清理请求',async()=>{const {value,id}=await task('cancel',{cancel:true});assert.equal(value.status,'cancelled');assert.equal(existsSync(join(workspace,'audit-cancel.txt')),false);assert.equal((await cdp.invoke('assistant_workspace_pending')).some(a=>a.taskId===id),false);});
  await check('同名文件不会覆盖',async()=>{const {value}=await task('collision');assert.notEqual(value.status,'completed');assert.ok(value.trace.some(row=>row.tool==='document_create'&&/已存在|重名/.test(row.result.error)),JSON.stringify(value.trace));assert.equal(readFileSync(join(workspace,'keep.txt'),'utf8'),'既有虚构文件，不得覆盖。');});
  await check('保存后中断可以只补交付总结',async()=>{const first=await task('resume-create');assert.equal(first.value.status,'partial');const resumed=await task('resume-summary',{sessionId:first.sessionId,action:{type:'resume_task',taskId:first.id}});assert.equal(resumed.value.status,'completed',JSON.stringify(resumed.value.fault));assert.ok(resumed.value.trace.some(row=>row.result.filename==='audit-resume-create.txt'));});
  await check('服务错误保留代码并脱敏',async()=>{const {value}=await task('stream-error');assert.equal(value.status,'failed');assert.ok(value.fault.message.includes('E_AUDIT'));assert.ok(value.fault.message.includes('audit-request-1'));assert.equal(value.fault.message.includes('sk-audit-secret'),false);});
  await check('上下文超限只压缩重试一次',async()=>{const {value}=await task('context');assert.equal(value.status,'completed',JSON.stringify(value.fault));assert.equal(requests.get('context').filter(row=>row.tools?.[0]?.function.name!=='interpret_task').length,2);});
  await check('缺少完成原因不误报完成',async()=>{const {value}=await task('bad-finish');assert.notEqual(value.status,'completed');assert.equal(value.fault.code,'stream_closed');assert.match(value.fault.message,/完成原因/);});
  await check('支持多行 SSE 数据事件',async()=>{const {value}=await task('multiline');assert.equal(value.status,'completed',JSON.stringify(value.fault));});
  await check('流式输出中取消及时停止并保留已有内容',async()=>{let cancelledAt;const {value}=await task('cancel-stream',{observe:async(snapshot,id)=>{if(!cancelledAt&&snapshot?.text?.includes('可保留')){cancelledAt=Date.now();await cdp.invoke('cancel_task',{id});}}});assert.equal(value.status,'cancelled');assert.match(value.text,/可保留/);assert.ok(Date.now()-cancelledAt<3000);});
  await check('仅整理已有结果不开放工具',async()=>{const {value}=await task('summary-only',{respondOnly:true});assert.equal(value.status,'completed');assert.equal(requests.get('summary-only').length,1);assert.equal(requests.get('summary-only')[0].tools,undefined);});
  await check('撤销权限停止待确认操作且重新授权可生效',async()=>{const {value}=await task('revoke',{beforeApproval:async()=>{await cdp.invoke('assistant_workspace_revoke',{clear:false});return true;}});assert.equal(value.status,'cancelled');assert.equal(existsSync(join(workspace,'audit-revoke.txt')),false);await assert.rejects(()=>cdp.invoke('file_preview',{path:join(workspace,'keep.txt'),requestId:crypto.randomUUID(),page:1,sheet:0}),/目录|授权/);await grantWorkspace();const fresh=await task('after-revoke');assert.equal(fresh.value.status,'completed',JSON.stringify(fresh.value.fault));const preview=await cdp.invoke('file_preview',{path:join(workspace,'audit-after-revoke.txt'),requestId:crypto.randomUUID(),page:1,sheet:0});assert.equal(preview.kind,'text');});
  await check('任务刚建立即关闭后仍能找到正确续接目标',async()=>{
    const id=crypto.randomUUID(),sessionId=crypto.randomUUID();
    const pending=cdp.invoke('ai_task',{id,kind:'agent',text:'执行虚构任务 AUDIT_CASE:crash',context:{sessionId,respondOnly:true,view:{page:'files',root:'',currentDirectory:''}}}).catch(()=>{});
    const deadline=Date.now()+3000;let snapshot;
    while(Date.now()<deadline){snapshot=await cdp.invoke('task_status',{id}).catch(()=>null);if(snapshot?.piRuntime)break;await delay(10);}
    assert.equal(snapshot.taskContext.taskId,id);assert.ok(snapshot.piRuntime);child.kill();await childExit;await pending;await bootNative();
    const recovered=await cdp.invoke('task_status',{id});assert.equal(recovered.status,'interrupted');assert.equal(recovered.taskContext?.taskId,id,'重启后的任务快照丢失了当前目标');assert.equal(recovered.taskContext?.sessionId,sessionId);
    const resumed=await task('resume-summary',{sessionId,action:{type:'resume_task',taskId:id}});assert.equal(resumed.value.status,'completed',JSON.stringify(resumed.value.fault));
  });
}finally{
  try{cdp?.socket.close();}catch{}
  if(child){if(child.exitCode===null&&!child.killed)child.kill();await childExit.catch(()=>{});}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  writeFileSync(join(folder,'report.json'),JSON.stringify({folder,results,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length},null,2));
  console.log('原生隔离测试结果：'+join(folder,'report.json'));
}
assert.equal(results.filter(r=>!r.passed).length,0,'Some isolated native assistant checks failed');
