export type OcrFieldType = 'text' | 'date' | 'number';
export interface OcrFieldDefinition {
  key: string; prompt: string; kind: OcrFieldType; multiple: boolean; maxItems: number;
  separator: string; required: boolean; fallback: string; anchors: string[];
  pattern: string; stripPrefixes: string[]; format: string;
}
export interface OcrProfile {
  id: string; name: string; keywords: string[]; pages: string; dpi: number;
  regions?: OcrRegion[]; fields: OcrFieldDefinition[]; filenamePattern: string; threshold: number;
  extraTitles?: string[]; noiseMarkers?: string[]; extraHeaders?: string[];
}
export interface OcrRegion { page: number; x: number; y: number; width: number; height: number; fieldKey?: string | null }
export interface OcrLine { text: string; page: number; score: number; box: number[][]; page_size?: [number, number] | null }
export interface OcrJevCandidateLog {
  id: string; originalLineIndex: number; originalText: string; maskedText: string;
}
export interface OcrJevQuestionLog {
  questionId: string; fieldKey: string; instructions: string;
  chosenId?: string | null; chosenText?: string | null; confidence?: number | null;
}
export interface OcrJevLog {
  enabled: boolean; sent: boolean; success: boolean; error?: string | null; elapsedMs: number;
  candidates: OcrJevCandidateLog[]; questions: OcrJevQuestionLog[]; rawResponse?: unknown;
}
export interface OcrDecisionLog {
  fieldKey: string; finalValue: string; finalSource: string; reviewRequired: boolean;
  reviewReason?: string | null; jevCandidate?: string | null; jevConfidence?: number | null;
  localCandidate?: string | null; localRuleMatched?: string | null;
}
export interface OcrFileDiagnostics {
  ocrLinesCount: number; ocrElapsedMs: number; jev: OcrJevLog; decisions: OcrDecisionLog[]; logs: string[];
  profileMatch?: OcrProfileMatch | null;
}
export interface OcrProfileMatch {
  outcome: string; message: string; page: number; dpi: number; linesCount: number;
  candidates: {
    profileId: string; profileName: string; threshold: number; score: number;
    keywords: { keyword: string; normalized: string; hits: { lineIndex: number; score: number | null; accepted: boolean }[] }[];
  }[];
}
export interface OcrFieldResult { value: string; source: string; confidence: number | null; evidence: number[]; review: boolean }
export interface OcrFileResult {
  id: string; path: string; originalName: string; status: string; error: string;
  profile: OcrProfile | null; lines: OcrLine[]; fields: Record<string, OcrFieldResult>;
  proposedName: string; reviewed: boolean; elapsedMs: number; warning: string;
  diagnostics?: OcrFileDiagnostics | null;
}
export interface OcrWorkflowOptions {exportFormat:'none'|'txt'|'csv'|'json';exportDirectory:string;rename:'review'|'preview'|'apply';renameConfirmed:boolean}
export interface OcrWorkflow {enabled:boolean;options:OcrWorkflowOptions;status:string;exportPath:string;renameBatchId:string;error:string}
export interface OcrTask { id: string; created: number; status: string; useJev: boolean; profiles: OcrProfile[]; files: OcrFileResult[];autoMatch?:boolean;workflow?:OcrWorkflow;clearedFileIds?:string[] }
export const defaultWorkflow:OcrWorkflowOptions={exportFormat:'none',exportDirectory:'',rename:'apply',renameConfirmed:false};
// Clicking the explicitly labelled action authorizes this task's rename step.
export const oneClickWorkflow=(options:OcrWorkflowOptions):OcrWorkflowOptions=>({...options,rename:'apply',renameConfirmed:true});
export interface OcrRenameItem { fileId: string; original: string; target: string; status: string; error: string; warning?:string }
export interface OcrRenameBatch { id: string; taskId: string; status: string; items: OcrRenameItem[]; summary?:{success:number;failed:number;pending:number;blocked:number} }
export function completedOcrFileIds(task:OcrTask,batches:OcrRenameBatch[]):string[] {
  if(['queued','running'].includes(task.status))return [];
  const workflow=task.workflow;
  if(workflow?.enabled&&workflow.options.exportFormat!=='none'&&!workflow.exportPath)return [];
  const renamed=new Set(batches.filter(b=>b.taskId===task.id).flatMap(b=>b.items.filter(i=>i.status==='done'&&!i.error).map(i=>`${i.fileId}\0${i.target}`)));
  return task.files.filter(f=>['ready','review'].includes(f.status)&&!f.error&&(f.status==='ready'&&!f.warning||f.reviewed)&&(!workflow?.enabled||workflow.options.rename==='review'||renamed.has(`${f.id}\0${f.path}`))).map(f=>f.id);
}
export const completedOcrTask=(task:OcrTask,batches:OcrRenameBatch[]):boolean=>task.status==='completed'&&(!task.workflow?.enabled||task.workflow.status==='completed')&&task.files.length>0&&completedOcrFileIds(task,batches).length===task.files.length;
export interface OcrBootstrap { profiles: OcrProfile[]; tasks: OcrTask[]; batches: OcrRenameBatch[]; engineReady: boolean; jevReady: boolean; unavailableReason?: string | null }
export const newField = (): OcrFieldDefinition => ({key:'',prompt:'',kind:'text',multiple:false,maxItems:5,separator:'、',required:true,fallback:'',anchors:[],pattern:'',stripPrefixes:[],format:''});
export const newProfile = (): OcrProfile => ({id:crypto.randomUUID(),name:'新配置',keywords:[],pages:'1',dpi:200,fields:[],filenamePattern:'{原文件名}',threshold:.75});

export function updateProfileField(profile:OcrProfile,index:number,update:Partial<OcrFieldDefinition>|null):OcrProfile {
  const key=profile.fields[index].key;
  const next={...profile,fields:update===null?profile.fields.filter((_,i)=>i!==index):profile.fields.map((f,i)=>i===index?{...f,...update}:f)};
  if(update===null){
    next.regions=profile.regions?.filter(r=>r.fieldKey!==key);
    if(profile.filenamePattern.includes(`{${key}}`))next.filenamePattern=profile.filenamePattern.replaceAll(`{${key}}`,'').replace(/^[\s_-]+|[\s_-]+$/g,'')||'{原文件名}';
  }else if(update.key!==undefined&&update.key!==key){
    next.regions=profile.regions?.map(r=>r.fieldKey===key?{...r,fieldKey:update.key}:r);
    next.filenamePattern=profile.filenamePattern.replaceAll(`{${key}}`,()=>`{${update.key}}`);
  }
  return next;
}
