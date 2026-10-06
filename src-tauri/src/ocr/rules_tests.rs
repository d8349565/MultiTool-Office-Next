use super::*;

fn line(text: &str, x: f64, y: f64, width: f64) -> OcrLine {
    OcrLine {
        text: text.into(), page: 1, score: 0.99,
        r#box: vec![vec![x,y],vec![x+width,y],vec![x+width,y+30.0],vec![x,y+30.0]],
        page_size: Some([1653.0,2339.0]),
    }
}

fn contract_fields() -> Vec<OcrFieldDefinition> {
    vec![
        OcrFieldDefinition {
            key: "公司名称".into(),
            prompt: "提取买方/采购方/需方的公司名称，排除供方和税号".into(),
            anchors: vec!["买方".into(),"买方名称".into(),"需方".into()],
            pattern: r"(?i)[\u4e00-\u9fa5A-Za-z0-9（）()\u3001·]{2,}(?:有限公司|有限责任公司|股份有限公司|集团|公司|厂|商行|经营部)".into(),
            strip_prefixes: vec!["买方：".into(),"需方：".into()],
            ..Default::default()
        },
        OcrFieldDefinition {
            key: "合同编号".into(), anchors: vec!["合同编号".into(),"合同号".into()],
            pattern: r"(?i)[A-Za-z0-9][A-Za-z0-9\-_/（）()]{3,39}".into(),
            strip_prefixes: vec!["合同编号：".into(),"合同编号:".into()],
            ..Default::default()
        },
    ]
}

#[test]
fn contract_form_extracts_values_from_their_own_labels() {
    let lines = vec![
        line("产品采购合同",650.0,132.0,343.0),
        line("STANDARD PURCHASE CONTRACT",596.0,205.0,459.0),
        line("合同编号：HT-2025-0819",142.0,269.0,296.0),
        line("签订日期：2025年10月18日",677.0,266.0,317.0),
        line("签订地点：北京市海淀区",1235.0,266.0,279.0),
        line("需方（买方）：北京未来智能科技有限公司",176.0,411.0,518.0),
        line("供方（卖方）：上海卓越晨星电子科技有限公司",843.0,411.0,572.0),
        line("统一社会信用代码：91110108MA0198KQ88",176.0,463.0,515.0),
        line("统一社会信用代码：91310115MA1H72XW99",843.0,463.0,526.0),
    ];
    let profile = OcrProfile {fields: contract_fields(), ..Default::default()};
    let (fields, _) = extract(&lines,&profile,None,None,&mut vec![]);
    assert_eq!(fields["公司名称"].value,"北京未来智能科技有限公司");
    assert_eq!(fields["公司名称"].evidence,vec![5]);
    assert_eq!(fields["合同编号"].value,"HT-2025-0819");
    assert_eq!(fields["合同编号"].evidence,vec![2]);
}

#[test]
fn anchored_pattern_uses_capture_and_rejects_invalid_values() {
    let field = OcrFieldDefinition {
        key: "编号".into(), anchors: vec!["编号".into(),"合同编号".into()],
        pattern: r"^(HT-\d{4}-\d{4})\s*(?:备注.*)?$".into(),
        ..Default::default()
    };
    let lines = vec![line("合同编号：日期另见正文",100.0,100.0,350.0),line("合同编号：HT-2025-0819 备注已签署",100.0,200.0,350.0)];
    assert_eq!(local(&lines,&field),vec![(1,"HT-2025-0819".into())]);
    assert_eq!(format_value("错误编号",&field),None);
}

#[test]
fn region_does_not_bypass_a_configured_pattern() {
    let field = contract_fields().remove(1);
    let profile = OcrProfile {
        fields: vec![field.clone()],
        regions: vec![OcrRegion {page:1,x:0.0,y:0.0,width:1.0,height:1.0,field_key:Some(field.key.clone())}],
        ..Default::default()
    };
    let (fields, _) = extract(&[line("签订地点：北京市海淀区",100.0,100.0,350.0)],&profile,None,None,&mut vec![]);
    assert_eq!(fields["合同编号"].source,"missing");
    assert!(fields["合同编号"].review);
}

#[test]
fn real_product_table_keeps_multiple_values() {
    let field = OcrFieldDefinition {key:"产品名称".into(),anchors:vec!["产品名称".into()],multiple:true,..Default::default()};
    let lines = vec![
        line("产品名称",100.0,100.0,250.0),line("数量",400.0,100.0,80.0),
        line("工业控制器",100.0,180.0,250.0),line("2",400.0,180.0,80.0),
        line("显示面板",100.0,240.0,250.0),line("3",400.0,240.0,80.0),
        line("合计",100.0,300.0,250.0),
    ];
    assert_eq!(local(&lines,&field),vec![(2,"工业控制器".into()),(4,"显示面板".into())]);
}

#[test]
fn customer_role_comes_from_anchors_even_with_a_generic_key() {
    let field = contract_fields().remove(0);
    assert!(is_rejected_candidate(None,&field,"供方（卖方）：上海卓越晨星电子科技有限公司"));
    let profile = OcrProfile {fields:vec![field],..Default::default()};
    let lines = vec![line("供方（卖方）：上海卓越晨星电子科技有限公司",100.0,100.0,450.0)];
    let plan = jev_body(&lines,&profile).unwrap();
    assert!(plan.groups.is_empty());
}

#[test]
fn a_label_and_its_inline_value_do_not_form_a_table_header_row() {
    let field=OcrFieldDefinition {
        key:"公司名称".into(),anchors:vec!["公司名称".into()],
        pattern:r"[\u4e00-\u9fa5]+有限公司".into(),..Default::default()
    };
    let lines=vec![
        line("公司名称",100.0,100.0,120.0),line("北京未来智能科技有限公司",300.0,100.0,400.0),
        line("其他信息：上海卓越晨星电子科技有限公司",100.0,200.0,500.0),
    ];
    assert_eq!(local(&lines,&field),vec![(1,"北京未来智能科技有限公司".into())]);
}

#[test]
fn common_document_numbers_keep_their_complete_values() {
    let samples=[
        ("合同编号",r"HT-\d{4}-\d{4}","HT-2025-0819"),
        ("送货单号",r"SH-\d{8}-\d{2}","SH-20261006-01"),
        ("报价单号",r"BJ-\d{8}-\d{2}","BJ-20261006-01"),
    ];
    for (key,pattern,expected) in samples {
        let profile=OcrProfile {
            fields:vec![OcrFieldDefinition {key:key.into(),anchors:vec![key.into()],pattern:pattern.into(),..Default::default()}],
            ..Default::default()
        };
        validate(&profile).unwrap();
        let raw=format!("{key}：{expected}");
        assert_eq!(local_for_profile(&[line(&raw,100.0,100.0,450.0)],&profile,&profile.fields[0]),vec![(0,expected.into())]);
    }
}

#[test]
#[ignore = "只读重放指定的本地任务；设置 OFFICE_OCR_REPLAY_FILE 后运行"]
fn replay_stored_contract_task() {
    let path=std::env::var("OFFICE_OCR_REPLAY_FILE").expect("需要指定任务 JSON 路径");
    let file:OcrFileResult=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let profile=file.profile.unwrap();
    let (fields,_) = extract(&file.lines,&profile,None,None,&mut vec![]);
    assert_eq!(file.lines.len(),58);
    assert_eq!(fields["公司名称"].value,"北京未来智能科技有限公司");
    assert_eq!(fields["合同编号"].value,"HT-2025-0819");
    assert_eq!(fields["公司名称"].evidence,vec![5]);
    assert_eq!(fields["合同编号"].evidence,vec![2]);
    println!("{} 行任务重放通过：公司名称={}（第6行），合同编号={}（第3行）",file.lines.len(),fields["公司名称"].value,fields["合同编号"].value);
}
