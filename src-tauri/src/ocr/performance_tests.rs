use super::*;

#[test]
#[ignore = "仅用户授权后，使用已有配置副本和独立生成的虚构样本进行实际 OCR 验收"]
fn saved_profile_acceptance(){
    let root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let base=root.join("test-results/ocr-acceptance-20261101");
    let profiles:Vec<OcrProfile>=serde_json::from_slice(&std::fs::read(base.join("profiles.json")).unwrap()).unwrap();
    let manifest:Value=serde_json::from_slice(&std::fs::read(base.join("cases/manifest.json")).unwrap()).unwrap();
    let events_name=std::env::var("OFFICE_OCR_ACCEPTANCE_EVENTS").unwrap_or("current-worker-events.json".into());
    let events:Vec<Value>=serde_json::from_slice(&std::fs::read(base.join(&events_name)).unwrap()).unwrap();
    let profile=&profiles[0];rules::validate(profile).unwrap();
    let mut results=vec![];let mut correct=0;let mut names=0;
    for case in manifest["cases"].as_array().unwrap(){
        let lines:Vec<OcrLine>=events.iter().filter(|v|v["id"]==case["id"]&&v["kind"]=="page").flat_map(|v|serde_json::from_value::<Vec<OcrLine>>(v["lines"].clone()).unwrap()).collect();
        assert!(!lines.is_empty());assert!(lines.iter().all(|l|l.page==1));
        let (fields,_)=rules::extract(&lines,profile,None,None,&mut vec![]);
        let actual:BTreeMap<_,_>=fields.iter().map(|(k,v)|(k.clone(),v.value.clone())).collect();
        for (key,value) in case["expected_fields"].as_object().unwrap(){if actual.get(key).map(String::as_str)==value.as_str(){correct+=1;}}
        let filename=rules::filename(profile,&fields,case["path"].as_str().unwrap());
        if Some(filename.as_str())==case["expected_filename"].as_str(){names+=1;}
        results.push(json!({"id":case["id"],"actual":actual,"expected":case["expected_fields"],"filename":filename,"expectedFilename":case["expected_filename"],"review":fields.values().any(|v|v.review)}));
    }
    let report=json!({"correctFields":correct,"totalFields":30,"correctNames":names,"totalFiles":10,"cases":results});
    std::fs::write(base.join(format!("{events_name}.fields.json")),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    assert_eq!(correct,30,"{report}");assert_eq!(names,10,"{report}");
}

#[test]
fn first_page_reuse_requires_identical_pixels_and_requested_page(){
    let probe=OcrProfile::default();
    for pages in ["1","all","1-3","3,1","2,1-1"," 1 "]{
        let profile=OcrProfile{pages:pages.into(),..probe.clone()};
        assert!(can_reuse_first_page(&probe,&profile),"{pages}");
    }
    for pages in ["2","2-3","3,4"]{
        assert!(!can_reuse_first_page(&probe,&OcrProfile{pages:pages.into(),..probe.clone()}));
    }
    assert!(!can_reuse_first_page(&probe,&OcrProfile{dpi:300,..probe.clone()}));
    let region=OcrRegion{page:1,x:0.0,y:0.0,width:1.0,height:1.0,field_key:None};
    // Even a full-size user region must retain the region recognition path.
    assert!(!can_reuse_first_page(&probe,&OcrProfile{regions:vec![region],..probe.clone()}));
    assert!(!can_reuse_first_page(&OcrProfile{pages:"2".into(),..probe.clone()},&probe));
}

#[test]
fn fast_region_detection_requires_local_anchored_fields_and_bound_regions(){
    let mut profile=OcrProfile{fields:vec![OcrFieldDefinition{key:"日期".into(),anchors:vec!["日期".into()],..Default::default()}],
        regions:vec![OcrRegion{page:1,x:0.6,y:0.1,width:0.3,height:0.1,field_key:Some("日期".into())}],..Default::default()};
    assert!(can_use_fast_regions(&profile,false));assert!(!can_use_fast_regions(&profile,true));
    profile.regions[0].field_key=None;assert!(!can_use_fast_regions(&profile,false));
    profile.regions[0].field_key=Some("日期".into());profile.fields[0].anchors.clear();assert!(!can_use_fast_regions(&profile,false));
    assert!(!can_use_fast_regions(&OcrProfile::default(),false));
}

#[test]
fn header_probe_is_only_used_when_no_competing_profile_can_change_the_match(){
    let whole=OcrProfile{keywords:vec!["报价单".into()],..Default::default()};
    assert!(first_page_probe(&[whole.clone()]).regions.is_empty());
    let quote=OcrProfile{regions:vec![OcrRegion{page:1,x:0.0,y:0.0,width:0.5,height:0.5,field_key:None}],..whole};
    assert_eq!(first_page_probe(&[quote.clone()]).regions.len(),1);
    assert!(first_page_probe(&[quote.clone(),OcrProfile{keywords:vec!["合同".into()],..Default::default()}]).regions.is_empty());
    assert_eq!(first_page_probe(&[quote,OcrProfile::default()]).regions.len(),1);
    assert!(first_page_probe(&[]).regions.is_empty());
}

fn task()->OcrTask{
    serde_json::from_value(json!({"id":"timing-check","created":1,"status":"running","useJev":false,"profiles":[],
        "files":(0..3).map(|i|json!({"id":i.to_string(),"path":format!("synthetic-{i}.pdf"),"originalName":"synthetic.pdf",
            "status":"queued","error":"","profile":null,"lines":[{"text":"SYNTHETIC TEXT","page":1,"score":0.99,"box":[]}],
            "fields":{},"proposedName":"","reviewed":false,"elapsedMs":0,"warning":""})).collect::<Vec<_>>() })).unwrap()
}

#[test]
fn publishing_one_file_keeps_previous_text_buffers_and_matches_full_state(){
    let mut task=task();let mut tasks=BTreeMap::from([(task.id.clone(),task.clone())]);
    let untouched=tasks[&task.id].files[0].lines.as_ptr();
    task.files[1].status="ready".into();task.files[1].lines[0].text="UPDATED SYNTHETIC TEXT".into();
    cache_progress(&mut tasks,&task,Some(1));
    assert_eq!(tasks[&task.id].files[0].lines.as_ptr(),untouched);
    assert_eq!(serde_json::to_value(&tasks[&task.id]).unwrap(),serde_json::to_value(&task).unwrap());
    task.status="completed".into();task.files[2].status="cancelled".into();
    cache_progress(&mut tasks,&task,None);
    assert_eq!(serde_json::to_value(&tasks[&task.id]).unwrap(),serde_json::to_value(&task).unwrap());
}

#[test]
fn progress_sends_changed_files_and_a_complete_terminal_snapshot(){
    let mut task=task();let known=task.files.iter().map(|file|(file.id.clone(),file.status.clone())).collect();
    assert!(task_progress(&task,&known).files.is_empty());
    task.files[1].status="running".into();
    let update=task_progress(&task,&known);assert!(!update.complete_snapshot);assert_eq!(update.files.len(),1);assert_eq!(update.files[0].id,"1");
    task.files[1].status="ready".into();task.files[1].path="renamed-synthetic.pdf".into();task.status="completed".into();
    let update=task_progress(&task,&known);assert!(update.complete_snapshot);assert_eq!(update.files.len(),3);assert_eq!(update.files[1].path,"renamed-synthetic.pdf");
    task.status="failed".into();assert!(task_progress(&task,&known).complete_snapshot);
}

#[test]
fn timing_records_are_optional_for_old_results_and_add_both_passes(){
    let legacy=json!({"ocrLinesCount":1,"ocrElapsedMs":10,"jev":{},"decisions":[],"logs":[]});
    // Existing Jev records carry required fields, as they did before timing was added.
    let mut legacy=legacy;legacy["jev"]=json!(OcrJevLog::default());
    let mut diag:OcrFileDiagnostics=serde_json::from_value(legacy).unwrap();assert!(diag.timings.is_none());
    let mut engine=OcrEngineTimings{render_ms:10,detect_ms:20,pages_processed:1,requests:1,..Default::default()};
    engine.add(OcrEngineTimings{render_ms:5,detect_ms:15,pages_processed:1,requests:1,..Default::default()});
    assert_eq!((engine.render_ms,engine.detect_ms,engine.pages_processed,engine.requests),(15,35,2,2));
    diag.timings=Some(OcrTimings{engine:Some(engine),reused_pages:1,..Default::default()});
    let restored:OcrFileDiagnostics=serde_json::from_value(json!(diag)).unwrap();assert_eq!(restored.timings.unwrap().reused_pages,1);
}
