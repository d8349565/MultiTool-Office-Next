// Authorized synthetic acceptance through the real Tauri commands and worker.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const baseline=process.argv.includes('--baseline');
const controlsOnly=process.argv.includes('--controls-only');
const repeats=Number(process.argv.find(a=>a.startsWith('--repeat='))?.split('=')[1]||1);
assert.ok(Number.isInteger(repeats)&&repeats>=1&&repeats<=3);
const sourceRoot=baseline?join(root,'.tools/ocr-baseline-v056'):root;
const base=join(root,'test-results/ocr-acceptance-20261101');
const manifest=JSON.parse(readFileSync(join(base,'cases/manifest.json'),'utf8'));
const profiles=JSON.parse(readFileSync(join(base,'profiles.json'),'utf8'));
assert.equal(profiles.length,1);assert.equal(manifest.cases.length,10);
const folder=mkdtempSync(join(root,'test-results/ocr-native-'));
const data=join(folder,'data');mkdirSync(join(data,'workspace/ocr'),{recursive:true});
copyFileSync(join(base,'profiles.json'),join(data,'workspace/ocr/profiles.json'));
writeFileSync(join(data,'settings.json'),JSON.stringify({schemaVersion:1,revision:0,roots:[],theme:'light',recursive:true,filter:'',launchers:[],modelUrl:'http://127.0.0.1:19290/v1',modelId:'unused-offline-test',jevEnabled:false}));
const outDir=join(folder,'exports');mkdirSync(outDir);mkdirSync(join(folder,'webview'));
const report={baseline,folder,profileSha256:manifest.profile_sha256,runs:[],checks:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const {outputText}=ts.transpileModule(readFileSync(join(root,'src/ocrTypes.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
const {mergeOcrProgress}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const server=http.createServer((_,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><title>Isolated OCR acceptance</title><p>Synthetic documents only</p>');});
await new Promise((done,reject)=>{server.once('error',reject);server.listen(19290,'127.0.0.1',done);});
const picker=http.createServer();await new Promise(done=>picker.listen(0,'127.0.0.1',done));const debugPort=picker.address().port;await new Promise(done=>picker.close(done));
const env={...process.env,RUSTUP_TOOLCHAIN:'stable-x86_64-pc-windows-gnu',CARGO_NET_OFFLINE:'true',CARGO_BUILD_JOBS:'2',CARGO_TARGET_DIR:join(root,'src-tauri/target'),
  PATH:join(root,'.tools/mingw64/bin')+';'+process.env.PATH,TEMP:join(root,'test-results/ocr-performance/temp'),TMP:join(root,'test-results/ocr-performance/temp'),
  TAURI_CONFIG:JSON.stringify({identifier:'com.multitool.office.next.ocracceptance',productName:'OCR Acceptance',build:{devUrl:'http://127.0.0.1:19290/audit.html'}}),
  OFFICE_NEXT_TEST_DATA_DIR:data,OFFICE_NEXT_TEST_WINDOW_HIDDEN:'1',WEBVIEW2_USER_DATA_FOLDER:join(folder,'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-address=127.0.0.1 --remote-debugging-port='+debugPort,NO_PROXY:'127.0.0.1,localhost',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:''};
let child,socket;const pending=new Map();let sequence=0;
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},60000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
const invoke=(name,args={})=>evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
async function waitTask(id){let snapshot=await invoke('ocr_get_task',{id});const deadline=Date.now()+300000;let bytes=JSON.stringify(snapshot).length;
  while(['queued','running'].includes(snapshot.status)&&Date.now()<deadline){await delay(100);if(baseline){snapshot=await invoke('ocr_get_task',{id});bytes+=JSON.stringify(snapshot).length;}else{const update=await invoke('ocr_get_task_progress',{id,known:Object.fromEntries(snapshot.files.map(f=>[f.id,f.status]))});bytes+=JSON.stringify(update).length;snapshot=mergeOcrProgress(snapshot,update);}}
  assert.ok(!['queued','running'].includes(snapshot.status),'OCR task timed out');return {snapshot,bytes};
}
function copiedCases(name){const dir=join(folder,name);mkdirSync(dir);return manifest.cases.map(c=>{const path=join(dir,c.id+'.'+c.format);copyFileSync(join(root,c.path),path);return path;});}
function verify(snapshot){assert.equal(snapshot.status,'completed');assert.equal(snapshot.files.length,10);let fields=0,names=0;
  for(let i=0;i<10;i++){const actual=snapshot.files[i],expected=manifest.cases[i];assert.equal(actual.status,'ready',`${expected.id}: ${actual.error} ${actual.warning}`);
    assert.ok(actual.lines.every(l=>l.page===1),expected.id+' leaked second page');
    for(const [key,value] of Object.entries(expected.expected_fields)){assert.equal(actual.fields[key]?.value,value,expected.id+' '+key);assert.equal(actual.fields[key].review,false);fields++;}
    assert.equal(actual.proposedName,expected.expected_filename,expected.id+' filename');names++;}
  return {fields,names};
}
try{
  const build=spawn('cargo.exe',['build','--offline','--manifest-path',join(sourceRoot,'src-tauri/Cargo.toml')],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  assert.equal((await once(build,'exit'))[0],0,'Native build failed');
  const exe=join(folder,'ocr-acceptance.exe');copyFileSync(join(root,'src-tauri/target/debug/office-next.exe'),exe);
  copyFileSync(join(root,'src-tauri/target/debug/WebView2Loader.dll'),join(folder,'WebView2Loader.dll'));
  const stdout=openSync(join(folder,'native.stdout.log'),'w'),stderr=openSync(join(folder,'native.stderr.log'),'w');
  child=spawn(exe,[],{cwd:root,env,windowsHide:true,stdio:['ignore',stdout,stderr]});closeSync(stdout);closeSync(stderr);
  let target,lastDiscovery;const deadline=Date.now()+45000;
  while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('Native app exited: '+readFileSync(join(folder,'native.stderr.log'),'utf8'));try{const targets=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`,{signal:AbortSignal.timeout(800)})).json();lastDiscovery=targets.map(t=>({title:t.title,url:t.url}));target=targets.find(t=>t.url==='http://127.0.0.1:19290/audit.html');if(target)break;}catch(error){lastDiscovery=String(error);}await delay(200);}
  assert.ok(target,'Owned WebView did not start: '+JSON.stringify(lastDiscovery));socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,'open');
  socket.addEventListener('message',event=>{const packet=JSON.parse(event.data),p=pending.get(packet.id);if(!p)return;pending.delete(packet.id);clearTimeout(p.timer);packet.error?p.reject(new Error(packet.error.message)):p.resolve(packet.result);});
  const bridgeDeadline=Date.now()+10000;
  while(Date.now()<bridgeDeadline&&await evaluate('typeof window.__TAURI_INTERNALS__?.invoke')!=='function')await delay(100);
  assert.equal(await evaluate('typeof window.__TAURI_INTERNALS__?.invoke'),'function','Tauri bridge did not initialize');
  for(const [round,mode] of controlsOnly?[]:Array.from({length:repeats},(_,round)=>[[round,'manual'],[round,'auto']]).flat()){
    const paths=copiedCases(`${mode}-${round}`);const started=performance.now();const imported=await invoke('ocr_import_files',{paths});assert.deepEqual(imported.errors,[]);
    const workflow=mode==='auto'?{exportFormat:'csv',exportDirectory:outDir,rename:'apply',renameConfirmed:true}:null;
    const id=await invoke('ocr_start_task',{paths:imported.files,profileId:mode==='auto'?'auto':profiles[0].id,useJev:false,retryId:null,retryFileIds:null,workflow});
    const {snapshot,bytes}=await waitTask(id);const wallMs=performance.now()-started;const accuracy=verify(snapshot);
    writeFileSync(join(folder,`${mode}-${round}-task.json`),JSON.stringify(snapshot,null,2));
    report.runs.push({round,mode,wallMs,progressBytes:bytes,...accuracy,workerCpuMs:snapshot.files.reduce((sum,f)=>sum+(f.diagnostics?.timings?.engine?.workerCpuMs||0),0),
      stageMs:snapshot.files.map(f=>({file:f.originalName,elapsedMs:f.elapsedMs,timings:f.diagnostics?.timings}))});
    if(mode==='auto'){
      assert.equal(snapshot.workflow.status,'completed');assert.ok(existsSync(snapshot.workflow.exportPath));
      for(let i=0;i<10;i++){assert.equal(sha(snapshot.files[i].path),manifest.cases[i].sha256);assert.equal(existsSync(paths[i]),false);}
      const undo=await invoke('ocr_apply_rename',{batchId:snapshot.workflow.renameBatchId,undo:true});assert.equal(undo.summary.success,10);
      paths.forEach((path,i)=>assert.equal(sha(path),manifest.cases[i].sha256));report.checks.push('automatic export, rename and undo preserve all 10 original file hashes');
    }
    console.log(JSON.stringify({round,mode,wallMs,...accuracy}));
  }
  if(!baseline){
    const strict={...profiles[0],id:'acceptance-strict-confidence',name:'虚构验收：严格复核',threshold:1};
    await invoke('ocr_save_profile',{profile:strict});
    const paths=copiedCases('confidence');const imported=await invoke('ocr_import_files',{paths:[paths[0]]});
    const id=await invoke('ocr_start_task',{paths:imported.files,profileId:strict.id,useJev:false,retryId:null,retryFileIds:null,workflow:null});
    const result=(await waitTask(id)).snapshot.files[0];
    assert.equal(result.status,'review');assert.equal(result.diagnostics.timings.regionFallback,true);
    assert.equal(result.diagnostics.timings.engine.requests,2);
    for(const [key,value] of Object.entries(manifest.cases[0].expected_fields))assert.equal(result.fields[key].value,value);
    assert.equal(sha(paths[0]),manifest.cases[0].sha256);report.checks.push('low confidence re-runs precise detection and retains correct fields for review');
    await invoke('ocr_delete_profile',{id:strict.id});
    await invoke('ocr_save_profile',{profile:{...profiles[0],keywords:[manifest.cases[0].expected_products[0]]}});
    const fallbackId=await invoke('ocr_start_task',{paths:imported.files,profileId:'auto',useJev:false,retryId:null,retryFileIds:null,workflow:null});
    const fallback=(await waitTask(fallbackId)).snapshot.files[0];
    assert.equal(fallback.status,'ready');assert.equal(fallback.diagnostics.timings.classificationFallback,true);
    for(const [key,value] of Object.entries(manifest.cases[0].expected_fields))assert.equal(fallback.fields[key].value,value);
    report.checks.push('keyword below header falls back to full first page and matches correctly');
    await invoke('ocr_save_profile',{profile:profiles[0]});
    await invoke('ocr_save_profile',{profile:{...profiles[0],id:'acceptance-competitor',name:'虚构验收：冲突候选',keywords:['客户名称']}});
    const tiedId=await invoke('ocr_start_task',{paths:imported.files,profileId:'auto',useJev:false,retryId:null,retryFileIds:null,workflow:null});
    const tied=(await waitTask(tiedId)).snapshot.files[0];
    assert.equal(tied.status,'review');assert.equal(tied.profile,null);assert.equal(tied.diagnostics.profileMatch.outcome,'tied');
    assert.equal(tied.diagnostics.timings.classificationFastPath,false);report.checks.push('multiple candidates retain full-page conflict detection and require review');
  }
  const cancelPath=copiedCases('cancel')[0];const imported=await invoke('ocr_import_files',{paths:[cancelPath]});
  const id=await invoke('ocr_start_task',{paths:imported.files,profileId:profiles[0].id,useJev:false,retryId:null,retryFileIds:null,workflow:null});await invoke('ocr_cancel_task',{id});
  const cancelled=(await waitTask(id)).snapshot;assert.equal(cancelled.status,'cancelled');
  const retry=await invoke('ocr_start_task',{paths:[],profileId:profiles[0].id,useJev:false,retryId:id,retryFileIds:null,workflow:null});
  assert.equal((await waitTask(retry)).snapshot.files[0].status,'ready');assert.equal(sha(cancelPath),manifest.cases[0].sha256);report.checks.push('cancel and retry preserve file bytes');
  report.passed=true;
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1;console.error(error);}
finally{
  writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2));
  writeFileSync(join(base,baseline?'native-baseline.json':controlsOnly?'native-controls.json':'native-candidate.json'),JSON.stringify(report,null,2));
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Acceptance ended'));}pending.clear();socket?.close();
  if(child&&child.exitCode===null){child.kill();await once(child,'exit');}await new Promise(done=>server.close(done));
}
