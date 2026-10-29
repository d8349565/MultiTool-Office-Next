use super::*;

#[test]
fn completion_cleanup_preserves_review_failures_and_unfinished_workflows(){
    let result=|id:&str,status:&str,reviewed:bool,warning:&str|json!({"id":id,"path":format!("D:/status-check/{id}.pdf"),"originalName":format!("{id}.pdf"),"status":status,"error":"","profile":null,"lines":[],"fields":{},"proposedName":"","reviewed":reviewed,"elapsedMs":0,"warning":warning});
    let mut task:OcrTask=serde_json::from_value(json!({"id":"status-check","created":1,"status":"completed","useJev":false,"profiles":[],"files":[
        result("success","ready",false,""),result("review","review",false,""),result("warning","ready",false,"needs review"),result("checked","review",true,"confirmed"),
        result("failed","failed",true,""),result("interrupted","interrupted",true,""),result("cancelled","cancelled",true,""),result("relocated","relocated",true,"")
    ]})).unwrap();
    let mut batches=BTreeMap::new();
    assert_eq!(completed_file_ids(&task,&batches),HashSet::from(["success".into(),"checked".into()]));
    assert!(!completed_task(&task,&batches));
    for status in ["queued","running"]{task.status=status.into();assert!(completed_file_ids(&task,&batches).is_empty());}
    task.status="completed".into();task.files.truncate(1);
    assert!(completed_task(&task,&batches));
    task.files[0].error="not complete".into();assert!(completed_file_ids(&task,&batches).is_empty());task.files[0].error.clear();
    task.workflow=OcrWorkflow{enabled:true,status:"review".into(),options:OcrWorkflowOptions{export_format:"csv".into(),rename:"apply".into(),..Default::default()},..Default::default()};
    let batch:OcrRenameBatch=serde_json::from_value(json!({"id":"batch","taskId":task.id,"status":"executed","items":[{"fileId":"success","original":"D:/status-check/original.pdf","target":task.files[0].path,"status":"done","error":"","fingerprint":""}]})).unwrap();
    batches.insert(batch.id.clone(),batch);
    assert!(completed_file_ids(&task,&batches).is_empty());
    task.workflow.export_path="D:/status-check/output.csv".into();
    assert!(completed_file_ids(&task,&BTreeMap::new()).is_empty());
    assert_eq!(completed_file_ids(&task,&batches).len(),1);assert!(!completed_task(&task,&batches));
    task.workflow.status="completed".into();assert!(completed_task(&task,&batches));
    task.status="failed".into();assert!(!completed_task(&task,&batches));task.status="completed".into();
    batches.get_mut("batch").unwrap().items[0].status="failed".into();assert!(completed_file_ids(&task,&batches).is_empty());
    batches.get_mut("batch").unwrap().items[0].status="done".into();batches.get_mut("batch").unwrap().items[0].target="D:/status-check/other.pdf".into();assert!(completed_file_ids(&task,&batches).is_empty());
}

#[test]
fn workspace_rename_invalidates_durable_results_batches_and_old_write_grants(){
    let base=Path::new(env!("CARGO_MANIFEST_DIR")).join("target/workspace-rename-checks");std::fs::create_dir_all(&base).unwrap();
    let dir=tempfile::Builder::new().prefix("ocr-check-").tempdir_in(base).unwrap();
    let store=OcrStore::open(dir.path(),"missing-test-worker.exe".into()).unwrap();
    let task_id=uuid::Uuid::new_v4().to_string();let file_id=uuid::Uuid::new_v4().to_string();let original=r"D:\synthetic\before\child.pdf";
    let task:OcrTask=serde_json::from_value(json!({"id":task_id,"created":1,"status":"completed","useJev":false,"profiles":[],"files":[{
        "id":file_id,"path":original,"originalName":"child.pdf","status":"ready","error":"","profile":null,
        "lines":[],"fields":{},"proposedName":"new.pdf","reviewed":true,"elapsedMs":0,"warning":"","fingerprint":"old-fingerprint"
    }]})).unwrap();
    let batch:OcrRenameBatch=serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"taskId":task_id,"status":"preview","items":[{
        "fileId":file_id,"original":original,"target":r"D:\synthetic\before\new.pdf","status":"pending","error":"","fingerprint":"old-fingerprint"
    }]})).unwrap();
    store.save_task(&task).unwrap();store.save_batch(&batch).unwrap();
    {let mut data=store.data.lock().unwrap();data.tasks.insert(task.id.clone(),task);data.batches.insert(batch.id.clone(),batch.clone());data.grants.insert(original.into());data.grants.insert(r"D:\synthetic\before-other\keep.pdf".into());
        invalidate_workspace_paths(&store,&mut data,r"D:\synthetic\before",r"D:\synthetic\after").unwrap();
        assert_eq!(data.tasks[&task_id].files[0].status,"relocated");assert!(data.tasks[&task_id].files[0].fingerprint.is_empty());
        assert_eq!(data.batches[&batch.id].items[0].status,"conflict");assert!(!data.grants.contains(original));assert!(data.grants.contains(r"D:\synthetic\before-other\keep.pdf"));
    }
    drop(store);
    let reopened=OcrStore::open(dir.path(),"missing-test-worker.exe".into()).unwrap();let data=reopened.data.lock().unwrap();
    assert_eq!(data.tasks[&task_id].files[0].status,"relocated");assert!(!data.grants.contains(original));assert_eq!(data.batches[&batch.id].items[0].status,"conflict");
}

#[test]
fn auto_profile_requires_unique_keywords_and_readable_evidence() {
    let contract=OcrProfile{id:"contract".into(),keywords:vec!["采购合同".into(),"采购合同".into()," ".into()],..Default::default()};
    let quote=OcrProfile{id:"quote".into(),keywords:vec!["报价单".into()],..Default::default()};
    let profiles=vec![contract,quote];
    let line=|text:&str,score:f64|OcrLine{text:text.into(),score,page:1,r#box:vec![],page_size:None};
    assert_eq!(rules::match_profile(&profiles,&[line("采购合同",0.99)]).unwrap().id,"contract");
    assert!(rules::match_profile(&profiles,&[line("采购合同 报价单",0.99)]).is_none());
    assert!(rules::match_profile(&profiles,&[line("采购合同",0.2)]).is_none());
    assert!(rules::match_profile(&profiles,&[line("无匹配内容",0.99)]).is_none());
}

#[test]
fn auto_profile_normalizes_only_within_a_line() {
    let profiles=vec![OcrProfile{keywords:vec!["报价单".into(),"Quotation".into()],..Default::default()}];
    let line=|text:&str,page:u32|OcrLine{text:text.into(),score:0.99,page,r#box:vec![],page_size:None};
    assert!(rules::match_profile(&profiles,&[line("报 价　单",1)]).is_some());
    assert!(rules::match_profile(&profiles,&[line("Ｑｕｏｔａｔｉｏｎ",1)]).is_some());
    assert!(rules::match_profile(&profiles,&[line("报",1),line("价单",1)]).is_none());
    assert!(rules::match_profile(&profiles,&[line("报\n价单",1)]).is_none());
    assert!(rules::match_profile(&profiles,&[line("报\t价单",1)]).is_none());
    assert!(rules::match_profile(&profiles,&[line("报  价单",1)]).is_none());
    assert!(rules::match_profile(&profiles,&[line("报价单",2)]).is_none());
}

#[test]
fn auto_profile_diagnostics_explain_filtering_ties_and_missing_keywords() {
    let quote=OcrProfile{id:"quote".into(),name:"报价单".into(),keywords:vec!["报价单".into(),"报 价 单".into()],threshold:0.8,..Default::default()};
    let strict=OcrProfile{id:"strict".into(),threshold:0.95,..quote.clone()};
    let no_keywords=OcrProfile{id:"name-only".into(),name:"报价单".into(),..Default::default()};
    let profiles=vec![quote,strict,no_keywords.clone()];
    let line=|score:f64|OcrLine{text:"报 价 单".into(),score,page:1,r#box:vec![],page_size:None};
    let (selected,diagnostic)=rules::diagnose_profile_match(&profiles,&[line(0.85)]);
    assert_eq!(selected.unwrap().id,"quote");
    assert_eq!(diagnostic.outcome,"matched");
    assert_eq!(diagnostic.candidates[0].score,1); // Normalized duplicates get one vote.
    assert_eq!(diagnostic.candidates[1].score,0);
    assert_eq!(diagnostic.candidates[1].keywords[0].hits[0].score,Some(0.85));
    assert!(!diagnostic.candidates[1].keywords[0].hits[0].accepted);
    assert!(diagnostic.candidates[2].keywords.is_empty());
    let (selected,tied)=rules::diagnose_profile_match(&profiles,&[line(0.99)]);
    assert!(selected.is_none());assert_eq!(tied.outcome,"tied");
    for score in [0.2,f64::NAN,f64::INFINITY]{
        let (selected,low)=rules::diagnose_profile_match(&profiles,&[line(score)]);
        assert!(selected.is_none());assert_eq!(low.outcome,"low_confidence");
        assert_eq!(low.candidates[0].keywords[0].hits[0].accepted,false);
        assert!(serde_json::to_string(&low).is_ok());
    }
    assert_eq!(rules::diagnose_profile_match(&[no_keywords],&[line(0.99)]).1.outcome,"no_keywords");
    assert_eq!(rules::diagnose_profile_match(&profiles,&[]).1.outcome,"no_text");
    let mut other=line(0.99);other.text="无标题".into();
    assert_eq!(rules::diagnose_profile_match(&profiles,&[other]).1.outcome,"no_match");
    let (_,best)=rules::diagnose_profile_match(&profiles,&[line(0.1),line(0.85)]);
    assert_eq!(best.candidates[0].keywords[0].hits[0].line_index,1);
}

#[test]
fn auto_profile_import_and_diagnostics_roundtrip_keep_match_inputs() {
    let profiles=ocr_import_profiles("templates:\n  - name: 报价单\n    match_keywords: [报价单]\n    fields: []\n".into()).unwrap();
    let imported=ocr_import_profiles(serde_json::to_string(&profiles).unwrap()).unwrap();
    assert_eq!(imported[0].keywords,vec!["报价单"]);
    let lines=vec![OcrLine{text:"报价单".into(),score:0.99,page:1,r#box:vec![],page_size:None}];
    let (_,matched)=rules::diagnose_profile_match(&imported,&lines);
    let diag=OcrFileDiagnostics{profile_match:Some(matched),..Default::default()};
    let saved=serde_json::to_value(&diag).unwrap();
    let restored:OcrFileDiagnostics=serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(restored.profile_match.unwrap().outcome,"matched");
    let mut legacy=saved;legacy.as_object_mut().unwrap().remove("profileMatch");
    assert!(serde_json::from_value::<OcrFileDiagnostics>(legacy).unwrap().profile_match.is_none());
}

#[test]
fn automatic_rename_requires_explicit_confirmation() {
    let mut options=OcrWorkflowOptions{export_format:"none".into(),rename:"apply".into(),..Default::default()};
    assert!(validate_workflow(&mut options).is_err());
    options.rename_confirmed=true;
    assert!(validate_workflow(&mut options).is_ok());
}

#[test]
fn one_click_completion_requires_every_file_to_be_renamed(){
    let mut task:OcrTask=serde_json::from_value(json!({"id":"task","created":1,"status":"completed","useJev":false,"profiles":[],"workflow":{"enabled":true,"options":{"rename":"apply","renameConfirmed":true}},"files":[
        {"id":"one","path":"one.pdf","originalName":"one.pdf","status":"ready","error":"","profile":null,"lines":[],"fields":{},"proposedName":"new-one.pdf","reviewed":true,"elapsedMs":0,"warning":""},
        {"id":"two","path":"two.pdf","originalName":"two.pdf","status":"ready","error":"","profile":null,"lines":[],"fields":{},"proposedName":"new-two.pdf","reviewed":true,"elapsedMs":0,"warning":""}
    ]})).unwrap();
    let mut renamed=HashSet::new();
    assert_eq!(workflow_completion_status(&task,&renamed),"review");
    renamed.insert("one".into());
    assert_eq!(workflow_completion_status(&task,&renamed),"review");
    renamed.insert("two".into());
    assert_eq!(workflow_completion_status(&task,&renamed),"completed");
    task.workflow.options.rename="preview".into();
    assert_eq!(workflow_completion_status(&task,&renamed),"review");
    task.workflow.options.rename="review".into();
    assert_eq!(workflow_completion_status(&task,&HashSet::new()),"completed");
}

#[test]
fn naming_warnings_require_review_without_repeating_or_discarding_other_warnings() {
    let mut file:OcrFileResult=serde_json::from_value(json!({
        "id":"file","path":"scan.pdf","originalName":"scan.pdf","status":"ready","error":"",
        "profile":OcrProfile{filename_pattern:"a".repeat(141),..Default::default()},
        "lines":[],"fields":{},"proposedName":format!("{}.pdf","a".repeat(140)),
        "reviewed":false,"elapsedMs":0,"warning":"已有提示"
    })).unwrap();
    assert!(review_naming_warning(&mut file));
    assert_eq!(file.status,"review");
    assert!(file.warning.starts_with("已有提示；"));
    assert!(file.warning.contains("已截断"));
    let warning=file.warning.clone();
    assert!(!review_naming_warning(&mut file));
    assert_eq!(file.warning,warning);
    file.reviewed=true;
    assert!(!review_naming_warning(&mut file));
    file.reviewed=false;file.proposed_name="人工命名.pdf".into();
    assert!(!review_naming_warning(&mut file));
    file.profile.as_mut().unwrap().filename_pattern="合同/编号".into();
    file.proposed_name="合同_编号.pdf".into();file.status="ready".into();
    assert!(!review_naming_warning(&mut file));
    assert_eq!(file.status,"ready");
    assert_eq!(file.warning,warning);
}

#[test]
fn export_recovery_checks_content_and_atomic_writes_preserve_existing_files() {
    use sha2::{Digest,Sha256};
    let dir=tempfile::tempdir().unwrap();
    let path=dir.path().join("OCR-task.txt");
    let expected=format!("{:x}",Sha256::digest(b"complete export"));
    assert!(!export_matches(&path,&expected).unwrap());
    write_export("txt",path.to_str().unwrap(),b"complete export").unwrap();
    assert!(export_matches(&path,&expected).unwrap());
    assert!(write_export("txt",path.to_str().unwrap(),b"replacement").is_err());
    assert_eq!(std::fs::read(&path).unwrap(),b"complete export");
    let partial=dir.path().join("partial.txt");
    std::fs::write(&partial,b"complete").unwrap();
    assert!(!export_matches(&partial,&expected).unwrap());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(),2);
    let old:OcrWorkflow=serde_json::from_str("{}").unwrap();
    assert_eq!(old.export_attempt,0);
    assert!(old.export_sha256.is_empty());
    let restored:OcrWorkflow=serde_json::from_str(&serde_json::to_string(&OcrWorkflow{export_attempt:2,export_sha256:expected.clone(),..Default::default()}).unwrap()).unwrap();
    assert_eq!(restored.export_attempt,2);
    assert_eq!(restored.export_sha256,expected);
}

fn profile() -> OcrProfile {
    OcrProfile {
        fields: vec![
            OcrFieldDefinition {key:"公司名称".into(),anchors:vec!["买方".into()],..Default::default()},
            OcrFieldDefinition {key:"合同编号".into(),pattern:r"HT-\d{4}-\d{4}".into(),..Default::default()},
        ],
        regions: vec![OcrRegion {page:1,x:0.1,y:0.1,width:0.2,height:0.2,field_key:Some("公司名称".into())}],
        filename_pattern: "{公司名称}_{合同编号}".into(),
        ..Default::default()
    }
}

#[test]
fn ai_micro_edit_preserves_unrequested_fields_and_regions() {
    let original=profile();
    let mut generated=original.clone();
    generated.fields[0].anchors=vec!["需方".into()];
    generated.fields[1].pattern="错误的编号规则".into();
    generated.name="随意改名".into();
    generated.filename_pattern="{原文件名}".into();
    generated.regions.clear();
    generated.fields.push(OcrFieldDefinition {key:"无关字段".into(),..Default::default()});
    let merged=merge_profile(original.clone(),"优化公司名称的提取规则",generated);
    assert_eq!(merged.fields[0].anchors,vec!["需方"]);
    assert_eq!(serde_json::to_value(&merged.fields[1]).unwrap(),serde_json::to_value(&original.fields[1]).unwrap());
    assert_eq!(merged.fields.len(),2);
    assert_eq!(merged.name,original.name);
    assert_eq!(merged.filename_pattern,original.filename_pattern);
    assert_eq!(serde_json::to_value(&merged.regions).unwrap(),serde_json::to_value(&original.regions).unwrap());
}

#[test]
fn explicitly_protected_field_is_preserved_even_when_named() {
    let original=profile();
    let mut generated=original.clone();
    generated.fields[0].prompt="优化后的说明".into();
    generated.fields[1].pattern="错误的编号规则".into();
    let merged=merge_profile(original.clone(),"只优化“公司名称”，合同编号保持不变",generated);
    assert_eq!(merged.fields[0].prompt,"优化后的说明");
    assert_eq!(merged.fields[1].pattern,original.fields[1].pattern);
}

#[test]
fn new_profile_keeps_generated_metadata_and_normalizes_date_format() {
    let original=OcrProfile::default();
    let generated=OcrProfile {
        name:"采购合同".into(),keywords:vec!["采购合同".into()],
        fields:vec![OcrFieldDefinition {key:"日期".into(),kind:"date".into(),format:"YYYY-MM-DD".into(),..Default::default()}],
        filename_pattern:"{日期}".into(),..Default::default()
    };
    let merged=merge_profile(original.clone(),"提取日期并命名",generated);
    assert_eq!(merged.id,original.id);
    assert_eq!(merged.name,"采购合同");
    assert_eq!(merged.keywords,vec!["采购合同"]);
    assert_eq!(merged.filename_pattern,"{日期}");
    assert_eq!(merged.fields[0].format,"%Y-%m-%d");
    rules::validate(&merged).unwrap();
}

#[test]
fn explicit_deletion_updates_filename_and_bound_regions() {
    let original=profile();
    let merged=merge_profile(original.clone(),"删除“公司名称”",original);
    assert_eq!(merged.fields.len(),1);
    assert_eq!(merged.fields[0].key,"合同编号");
    assert_eq!(merged.filename_pattern,"{合同编号}");
    assert!(merged.regions.is_empty());
    rules::validate(&merged).unwrap();
}
