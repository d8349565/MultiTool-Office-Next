use super::*;

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
