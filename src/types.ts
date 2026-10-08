export type ReasoningEffort = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export interface PricingRule { id:string; modelIds:string[]; providerHost:string; currency:'CNY'|'USD'; inputPerMillion:number; cachedInputPerMillion:number; outputPerMillion:number; schedule:'flat'|'deepseek'; offPeakDiscount:number; source:string; verifiedAt:string }
export interface PricingConfig { rules:PricingRule[]; holidays:Record<string,string[]> }
export interface Entry { path: string; name: string; parent: string; extension: string; size: number; modified: number; created?: number | null; isDir: boolean; businessDate?: string | null; dateSource?: string; matchReason?: string }
export interface Launcher { id: string; name: string; path: string; group: string }
export interface Settings { schemaVersion: number; revision: number; roots: string[]; theme: 'light' | 'dark' | 'system'; recursive: boolean; filter: string; launchers: Launcher[]; modelUrl: string; modelId: string; jevEnabled: boolean; tavilyEnabled?: boolean; assistantReasoning?: ReasoningEffort; translationReasoning?: ReasoningEffort;
  assistantOutputTokens?: number; translationOutputTokens?: number; modelRequestTimeoutSecs?: number; modelRetryCount?: number; assistantTaskTimeoutSecs?: number;
  assistantHistoryMessages?: number; assistantHistoryChars?: number; assistantToolRounds?: number; assistantSearchLimit?: number; assistantAutoContinue?: boolean; assistantContinueTokens?: number;
  modelContextTokens?: number;
  modelFirstResponseTimeoutSecs?: number; modelIdleTimeoutSecs?: number;
  modelTemperature?: number | null; modelTopP?: number | null;
  modelPricing?: PricingConfig;
}
export interface Status { scanning: boolean; count: number; scanned: number; errors: string[]; generation: number }
export interface Query { query?: string; kind?: 'file' | 'directory'; root?: string; recursive?: boolean; filter?: string; extension?: string; after?: number; before?: number; offset?: number; limit?: number }
export interface Results { items: Entry[]; total: number }
export interface Proposal { id: string; before: Partial<Settings>; after: Partial<Settings>; reason?: string; impact?: string }
export interface TaskFault { code:string; message:string; recovery:string }
export type TaskStatus='running'|'waiting_input'|'completed'|'partial'|'failed'|'cancelled'|'interrupted';
export interface TaskContext { schemaVersion:number;version:number;sessionId:string;taskId:string;status:TaskStatus;intent:{goal:string;operation:string;scope:string;root?:string;fields:string[];delivery:string;pendingField?:string;question?:string};resultSetIds:string[];evidenceIds:string[] }
export interface TaskAction {type:'next_page'|'scope_answer';resultSetId?:string;offset?:number;scope?:'current'|'workspace';operation?:string}
export interface DeliveryTable {columns:{key:string;label:string}[];rows:{path:string;values:string[];notice?:string|null}[];total:number;resultSetId:string}
export interface Activity { id: string; kind: 'reasoning' | 'note' | 'tool'; status: 'running' | 'completed' | 'failed' | 'interrupted'; text?: string; tool?: string; args?: unknown; result?: unknown; elapsedMs?: number }
export interface AIResult { id?:string; status?:TaskStatus; route?:string; fault?:TaskFault; warning?: string; taskContext?:TaskContext;delivery?:DeliveryTable|null;deadlineAt?:number;activities?: Activity[]; text?: string; format?: 'plain'|'markdown'|'html'; trace?: { tool: string; result: unknown }[]; proposals?: Proposal[]; answers?: Record<string, { choice?: string; confidence?: number; score?: number }>; usage?: unknown; model?: string }
export interface Bootstrap { settings: Settings; status: Status; keys: { model: boolean; jev: boolean; tavily?: boolean } }

export type TodoQuadrant = 0 | 1 | 2 | 3 | 4;
export interface TodoSubtask { id: string; title: string; completed: boolean }
export interface TodoItem {
  id: string;
  title: string;
  type: 'todo' | 'idea';
  quadrant: TodoQuadrant;
  completed: boolean;
  createdAt: number;
  completedAt?: number;
  dueDate?: string; // 本地日历日期，YYYY-MM-DD；未设置表示未排期。
  dueTime?: string; // 本地时间，HH:mm；未设置表示当天结束前到期。
  schemaVersion?: 2;
  deletedAt?: number;
  subtasks?: TodoSubtask[];
  notes?: string;
  aiNote?: string;
}
export interface TodoAiAssistResult {
  triage?: { quadrant: TodoQuadrant; reason: string };
  breakdown?: string[];
  expand?: { scenario: string; tech: string; firstStep: string };
  focus?: { q1Focus?: string; q2Focus?: string; q3Batch?: string; advice?: string };
}
