use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct OcrFieldDefinition {
    pub key: String, pub prompt: String, pub kind: String, pub multiple: bool,
    pub max_items: usize, pub separator: String, pub required: bool, pub fallback: String,
    pub anchors: Vec<String>, pub pattern: String, pub strip_prefixes: Vec<String>, pub format: String,
}
impl Default for OcrFieldDefinition { fn default()->Self {Self{key:String::new(),prompt:String::new(),kind:"text".into(),multiple:false,max_items:5,separator:"、".into(),required:true,fallback:String::new(),anchors:vec![],pattern:String::new(),strip_prefixes:vec![],format:String::new()}} }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct OcrProfile {
    pub id:String, pub name:String, pub keywords:Vec<String>, pub pages:String, pub dpi:u32,
    pub regions:Vec<OcrRegion>, pub fields:Vec<OcrFieldDefinition>, pub filename_pattern:String, pub threshold:f64,
    #[serde(default)] pub extra_titles:Vec<String>,
    #[serde(default)] pub noise_markers:Vec<String>,
    #[serde(default)] pub extra_headers:Vec<String>,
}
impl Default for OcrProfile {fn default()->Self{Self{id:uuid::Uuid::new_v4().to_string(),name:"新配置".into(),keywords:vec![],pages:"1".into(),dpi:200,regions:vec![],fields:vec![],filename_pattern:"{原文件名}".into(),threshold:0.75,extra_titles:vec![],noise_markers:vec![],extra_headers:vec![]}}}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct OcrRegion {pub page:u32,pub x:f64,pub y:f64,pub width:f64,pub height:f64,#[serde(default)] pub field_key:Option<String>}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OcrLine {pub text:String,pub page:u32,pub score:f64,pub r#box:Vec<Vec<f64>>,#[serde(default)] pub page_size:Option<[f64;2]>}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OcrFieldResult {pub value:String,pub source:String,pub confidence:Option<f64>,pub evidence:Vec<usize>,pub review:bool}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrJevCandidateLog {
    pub id: String,
    pub original_line_index: usize,
    pub original_text: String,
    pub masked_text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrJevQuestionLog {
    pub question_id: String,
    pub field_key: String,
    pub instructions: String,
    pub chosen_id: Option<String>,
    pub chosen_text: Option<String>,
    pub confidence: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrJevLog {
    pub enabled: bool,
    pub sent: bool,
    pub success: bool,
    pub error: Option<String>,
    pub elapsed_ms: u64,
    pub candidates: Vec<OcrJevCandidateLog>,
    pub questions: Vec<OcrJevQuestionLog>,
    pub raw_response: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrDecisionLog {
    pub field_key: String,
    pub final_value: String,
    pub final_source: String,
    pub review_required: bool,
    pub review_reason: Option<String>,
    pub jev_candidate: Option<String>,
    pub jev_confidence: Option<f64>,
    pub local_candidate: Option<String>,
    pub local_rule_matched: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrFileDiagnostics {
    pub ocr_lines_count: usize,
    pub ocr_elapsed_ms: u64,
    pub jev: OcrJevLog,
    pub decisions: Vec<OcrDecisionLog>,
    pub logs: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct OcrFileResult {
    pub id:String,pub path:String,pub original_name:String,pub status:String,pub error:String,
    pub profile:Option<OcrProfile>,pub lines:Vec<OcrLine>,pub fields:BTreeMap<String,OcrFieldResult>,
    pub proposed_name:String,pub reviewed:bool,pub elapsed_ms:u64,pub warning:String,
    #[serde(default)] pub fingerprint:String,
    #[serde(default)] pub diagnostics:Option<OcrFileDiagnostics>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct OcrTask {pub id:String,pub created:u64,pub status:String,pub use_jev:bool,pub profiles:Vec<OcrProfile>,pub files:Vec<OcrFileResult>}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct OcrBootstrap {pub profiles:Vec<OcrProfile>,pub tasks:Vec<OcrTask>,pub batches:Vec<OcrRenameBatch>,pub engine_ready:bool,pub jev_ready:bool,pub unavailable_reason:Option<String>}
#[derive(Clone, Debug, Serialize)]
pub struct OcrImportResult {pub files:Vec<String>,pub errors:Vec<String>}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct OcrRenameItem {pub file_id:String,pub original:String,pub target:String,pub status:String,pub error:String,pub fingerprint:String}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct OcrRenameBatch {pub id:String,pub task_id:String,pub status:String,pub items:Vec<OcrRenameItem>}
pub fn now()->u64{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()}
pub fn defaults()->Vec<OcrProfile>{
    let text=OcrProfile{id:"text".into(),name:"仅识别文字".into(),pages:"all".into(),..Default::default()};
    let field=|key:&str,prompt:&str,anchors:Vec<&str>,kind:&str|OcrFieldDefinition{key:key.into(),prompt:prompt.into(),kind:kind.into(),anchors:anchors.iter().map(|s|s.to_string()).collect(),strip_prefixes:anchors.iter().map(|s|s.to_string()).collect(),format:if kind=="date"{"%Y%m%d".into()}else{String::new()},..Default::default()};
    let quote=OcrProfile{id:"quote".into(),name:"报价单".into(),keywords:vec!["报价".into(),"Quotation".into(),"比价".into()],fields:vec![field("客户名称","选择采购方或买方，排除供应商和报价方",vec!["客户名称","客户","买方","需方"],"text"),OcrFieldDefinition{multiple:true,..field("产品名称","选择文档各分组明确列出的产品或物料名称，包含历史对比项；排除分组标题、条款、单位和金额",vec!["产品名称","品名","物料名称"],"text")},field("日期","选择报价日期或生效日期",vec!["报价日期","日期"],"date")],filename_pattern:"{客户名称}_{日期}_{产品名称}".into(),..Default::default()};
    let contract=OcrProfile{id:"contract".into(),name:"合同".into(),keywords:vec!["合同".into(),"协议".into()],pages:"1-2".into(),fields:vec![field("相对方","选择合同乙方或主要合作相对方",vec!["乙方","相对方"],"text"),field("合同类型","选择合同正式名称",vec!["合同名称","协议名称"],"text"),field("签约日期","选择签订或生效日期",vec!["签约日期","签订日期","生效日期"],"date")],filename_pattern:"{相对方}_{合同类型}_{签约日期}".into(),..Default::default()};
    vec![text,quote,contract]
}
