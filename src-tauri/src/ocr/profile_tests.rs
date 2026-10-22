use super::*;

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
fn automatic_rename_requires_explicit_confirmation() {
    let mut options=OcrWorkflowOptions{export_format:"none".into(),rename:"apply".into(),..Default::default()};
    assert!(validate_workflow(&mut options).is_err());
    options.rename_confirmed=true;
    assert!(validate_workflow(&mut options).is_ok());
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
    assert!(review_naming_warning(&mut file));
    assert!(file.warning.contains("非法文件名字符"));
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
