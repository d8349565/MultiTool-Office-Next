// 仅供浏览器合成演示，名称和金额均为示例数据，桌面识别不使用这些内容。
import { newField, newProfile, type OcrBootstrap, type OcrProfile, type OcrTask, type OcrRenameBatch, type OcrFieldDefinition, type OcrLine, type OcrFileResult } from './ocrTypes';
const state:OcrBootstrap={profiles:[{...newProfile(),id:'text',name:'仅识别文字',pages:'all'},{...newProfile(),id:'quote',name:'报价单',fields:[{...newField(),key:'客户名称',prompt:'找采购方',anchors:['客户']}],filenamePattern:'{客户名称}',keywords:['报价']}],tasks:[],batches:[],engineReady:true,jevReady:false};

/**
 * 单据样本：覆盖报价、合同、对账、送货四类常见办公单据。
 * 每类给出真实的锚点行写法（锚点标签 + 同行取值），
 * 使演示数据能真实考验 match_profile 的关键词匹配与字段抽取，而不是返回统一占位值。
 */
type 单据样本={id:string;关键词:string[];行:[string,string,string][];值:Record<string,string>};
const 单据样本库:单据样本[]=[
  {id:'报价单',关键词:['报价单','报价'],行:[['客户','客户：演示客户甲','text'],['报价日期','报价日期：2025-12-26','date'],['价税合计','价税合计：186,400.00 元','number']],值:{客户名称:'演示客户甲',报价日期:'2025-12-26',价税合计:'186,400.00'}},
  {id:'采购合同',关键词:['合同','协议'],行:[['需方','需方：演示客户乙','text'],['合同编号','合同编号：HT-2025-0371','text'],['签订日期','签订日期：2025-03-11','date']],值:{客户名称:'演示客户乙',合同编号:'HT-2025-0371',签订日期:'2025-03-11'}},
  {id:'对账单',关键词:['对账','对账单'],行:[['客户','客户：演示客户丙','text'],['对账期间','对账期间：2025年11月','text'],['本期应收','本期应收：92,750.00 元','number']],值:{客户名称:'演示客户丙',对账期间:'2025年11月',本期应收:'92,750.00'}},
  {id:'送货单',关键词:['送货','送货单'],行:[['客户','客户：演示客户甲','text'],['送货日期','送货日期：2025-12-29','date'],['数量','数量：240 桶','number']],值:{客户名称:'演示客户甲',送货日期:'2025-12-29',数量:'240'}},
];
const 匹配单据=(path:string):单据样本=>单据样本库.find(s=>s.关键词.some(k=>path.includes(k)))||单据样本库[0];
/** 字段取值必须随类型走：日期字段给日期，金额字段给金额，不能一律返回公司名。 */
const 字段取值=(f:OcrFieldDefinition,样本:单据样本):string=>{
  const 显式=样本.值[f.key]||Object.entries(样本.值).find(([k])=>f.key.includes(k)||k.includes(f.key))?.[1];
  if(显式)return 显式;
  const 同类=样本.行.find(r=>r[2]===f.kind);
  if(同类)return 同类[1].split('：').slice(1).join('：').replace(/\s*元$/,'').replace(/\s*桶$/,'');
  return f.kind==='date'?'2025-12-26':f.kind==='number'?'12,600.00':样本.值.客户名称;
};
/**
 * 识别置信度反映真实成像质量差异：原生 PDF 文字层清晰，手机翻拍的 jpg 存在噪点与倾斜。
 * 低于配置阈值即进入“需复核”，与桌面版判定口径一致。
 */
const 构造行=(样本:单据样本,path:string):OcrLine[]=>{
  const 翻拍=/\.(jpg|jpeg|png|bmp|tif|tiff)$/i.test(path);
  const 基准=翻拍?.62:.96;
  return 样本.行.map(([标签,文本],i)=>({text:文本,page:1,score:i===0?基准:+(基准-.02).toFixed(2),box:i===0?[[10,10],[400,10],[400,40],[10,40]]:[]}));
};
/** 需复核状态由识别置信度与配置阈值真实推导，而不是靠文件名后缀伪造。 */
const 需复核=(lines:OcrLine[],p:OcrProfile):boolean=>lines.some(l=>l.score<p.threshold);
const 脱敏=(text:string):string=>text.replace(/([\d,]+\.\d{2})\s*元/,'[价格已脱敏] 元');
/** 拟命名遵循配置命名格式，取不到值时回落到“未识别”，与桌面版一致。 */
const 生成拟命名=(p:OcrProfile,path:string,fields:Record<string,{value:string}>):string=>{
  const stem=p.filenamePattern.replace(/\{([^{}]+)\}/g,(_,key)=>key==='原文件名'?path.split('/').at(-1)!.replace(/\.[^.]+$/,''):fields[key]?.value||'未识别');
  return `${stem}.${path.split('.').at(-1)}`;
};
function 构造文件(p:OcrProfile,path:string,useJev:boolean):OcrFileResult{
  const 样本=匹配单据(path),lines=构造行(样本,path);
  const fields=Object.fromEntries(p.fields.map(f=>[f.key,{value:字段取值(f,样本),source:'local',confidence:null,evidence:[0],review:false}])) as OcrFileResult['fields'];
  return{id:crypto.randomUUID(),path,originalName:path.split('/').at(-1)!,status:需复核(lines,p)?'review':'ready',error:'',profile:p,lines,fields,proposedName:生成拟命名(p,path,fields),reviewed:false,elapsedMs:123,warning:'浏览器合成演示，未读取或修改本机文件。',diagnostics:{ocrLinesCount:lines.length,ocrElapsedMs:80,jev:{enabled:useJev,sent:useJev,success:useJev,elapsedMs:45,candidates:lines.map((l,i)=>({id:`c${'ab'[i]||'c'+i}`,originalLineIndex:i,originalText:l.text,maskedText:脱敏(l.text)})),questions:p.fields.map((f,idx)=>({questionId:`q_${idx}`,fieldKey:f.key,instructions:`选择【${f.key}】`,chosenId:'ca',chosenText:`第 1 行: ${lines[0]?.text||''}`,confidence:0.95}))},decisions:p.fields.map(f=>({fieldKey:f.key,finalValue:fields[f.key].value,finalSource:'local',reviewRequired:false,localCandidate:fields[f.key].value,localRuleMatched:样本.行[0]?.[0]||''})),logs:['演示模式生成模拟识别日志',`OCR 识别耗时 80ms，共 ${lines.length} 行`,'字段抽取完成']}};
}
export async function ocrDemo(command:string,args:Record<string,unknown>):Promise<unknown>{
  switch(command){
    case 'ocr_bootstrap':return structuredClone(state);
    case 'ocr_import_files':return {files:args.paths,errors:[]};
    case 'ocr_save_profile':{const p=args.profile as OcrProfile;if(!p.name.trim())throw new Error('配置名称不能为空');if(new Set(p.fields.map(f=>f.key)).size!==p.fields.length||p.fields.some(f=>!f.key.trim()))throw new Error('字段名不能为空或重复');const i=state.profiles.findIndex(v=>v.id===p.id);if(i<0)state.profiles.push(p);else state.profiles[i]=p;return p;}
    case 'ocr_delete_profile':state.profiles=state.profiles.filter(p=>p.id!==args.id);return;
    case 'ocr_import_profiles':{const p=JSON.parse(String(args.text));return Array.isArray(p)?p:[p];}
    case 'ocr_generate_profile':throw new Error('演示模式不调用模型，请在桌面版使用 AI 配置。');
    case 'ocr_start_task':{const p=state.profiles.find(p=>p.id===args.profileId)||state.profiles[1];const t:OcrTask={id:crypto.randomUUID(),created:Date.now()/1000,status:'completed',useJev:!!args.useJev,profiles:[p],files:(args.paths as string[]).map(path=>构造文件(p,path,!!args.useJev))};state.tasks.unshift(t);return t.id;}
    case 'ocr_get_task':return state.tasks.find(t=>t.id===args.id);
    case 'ocr_delete_task':state.tasks=state.tasks.filter(t=>t.id!==args.id);return;
    case 'ocr_clear_completed_tasks':{const count=state.tasks.filter(t=>!['queued','running'].includes(t.status)).length;state.tasks=state.tasks.filter(t=>['queued','running'].includes(t.status));return count;}
    case 'ocr_update_result':{const t=state.tasks.find(t=>t.id===args.taskId)!;const f=t.files.find(f=>f.id===args.fileId)!;Object.entries(args.values as Record<string,string>).forEach(([k,v])=>{f.fields[k]={...f.fields[k],value:v,source:'manual'};});f.proposedName=String(args.proposedName)||(f.profile?f.profile.filenamePattern.replace(/\{([^{}]+)\}/g,(_,key)=>key==='原文件名'?f.originalName.replace(/\.[^.]+$/,''):f.fields[key]?.value||'未识别')+'.'+f.originalName.split('.').at(-1):f.originalName);f.reviewed=!!args.reviewed;return t;}
    case 'ocr_preview_rename':{const t=state.tasks.find(t=>t.id===args.taskId)!;const b:OcrRenameBatch={id:crypto.randomUUID(),taskId:t.id,status:'preview',items:t.files.filter(f=>(args.fileIds as string[]).includes(f.id)).map(f=>({fileId:f.id,original:f.path,target:f.path.substring(0,f.path.lastIndexOf('/')+1)+f.proposedName,status:'pending',error:''}))};state.batches.push(b);return b;}
    case 'ocr_apply_rename':{const b=state.batches.find(b=>b.id===args.batchId)!;b.status=args.undo?'rollback':'executed';for(const i of b.items){i.status=args.undo?'undone':'done';const f=state.tasks.find(t=>t.id===b.taskId)!.files.find(f=>f.id===i.fileId)!;f.path=args.undo?i.original:i.target;}return b;}
    case 'ocr_open_file':throw new Error('演示文件不在本机磁盘中。');
    default:throw new Error('此操作需要桌面版。');
  }
}
