use super::*;

#[test]
fn small_or_memory_limited_pcs_reuse_one_model() {
    for (logical_cpus, total_gib, free_gib, threads) in [
        (1, 8, 2, 1), (2, 8, 2, 1), (4, 8, 3, 2), (6, 16, 9, 3),
        (8, 8, 5, 4), (8, 16, 10, 4), (16, 8, 6, 4), (20, 32, 5, 4),
    ] {
        let pc = OcrHardware { logical_cpus, total_gib, free_gib };
        assert_eq!(pc.file_count(0, 10), 1);
        let settings = pc.worker_settings(0, 1, None);
        assert_eq!(settings.inference_threads, threads);
        assert_eq!(settings.reuse_recognition_memory, free_gib >= 3);
    }
    let pc = OcrHardware { logical_cpus: 8, total_gib: 8, free_gib: 5 };
    assert_eq!(pc.file_count(2, 10), 2);
    assert_eq!(pc.file_count(8, 3), 3);
    for lane in 0..2 { assert_eq!(pc.worker_settings(lane, 2, None).inference_threads, 2); }
    assert!(!pc.worker_settings(0, 4, None).reuse_recognition_memory);
}

#[test]
fn larger_pcs_keep_their_file_concurrency_and_cpu_budget() {
    let pc = OcrHardware { logical_cpus: 20, total_gib: 32, free_gib: 15 };
    assert_eq!(pc.file_count(0, 10), 4);
    assert_eq!(OcrHardware { logical_cpus: 16, ..pc }.recommended_files(), 3);
    assert_eq!(OcrHardware { free_gib: 7, ..pc }.recommended_files(), 2);
    let totals: Vec<u8> = (1..=MAX_CONCURRENT_FILES).map(|n| {
        assert_eq!(pc.file_count(n, 10), n);
        (0..n).map(|lane| pc.worker_settings(lane, n, None).inference_threads).sum()
    }).collect();
    assert_eq!(totals, [2, 4, 6, 6, 6, 6, 7, 8]);
}

// Run by scripts/benchmark-ocr.py against newly generated documents in an isolated directory.
#[test]
#[ignore = "explicit local performance benchmark"]
fn dense_batch_benchmark() {
    use std::{fs, path::PathBuf, thread, time::Duration};
    let root = PathBuf::from(std::env::var_os("OCR_BENCH_RUN").unwrap());
    let originals = PathBuf::from(std::env::var_os("OCR_BENCH_INPUT").unwrap());
    let lanes: usize = std::env::var("OCR_BENCH_LANES").unwrap().parse().unwrap();
    let copies: usize = std::env::var("OCR_BENCH_COPIES").map_or(1, |n| n.parse().unwrap());
    assert!((1..=2).contains(&copies));
    let file_count: usize = std::env::var("OCR_BENCH_FILES").map_or(12*copies, |n| n.parse().unwrap());
    assert!((1..=24).contains(&file_count));
    // Benchmarks can hold compute per file constant while varying file concurrency.
    let thread_budget = std::env::var("OCR_BENCH_THREAD_BUDGET").ok().map(|n| n.parse::<usize>().unwrap());
    assert_ne!(thread_budget, Some(0));
    let split = std::env::var_os("OCR_BENCH_SPLIT").is_some();
    assert!(!split || lanes > 0);
    let queues = if split { lanes } else { 1 };
    let profile: OcrProfile = serde_json::from_value(json!({
        "id":"benchmark","name":"合成巡检记录","pages":"all","dpi":160,
        "fields":[{"key":"项目名称","anchors":["项目名称"],"stripPrefixes":["项目名称"]}],
        "filenamePattern":"{项目名称}_{原文件名}"
    }))
    .unwrap();
    rules::validate(&profile).unwrap();
    let mut jobs = Vec::new();
    for lane in 0..queues {
        let dir = root.join(format!("queue-{lane}"));
        fs::create_dir(&dir).unwrap();
        let (index, _rx) = crate::Index::open(&dir).unwrap();
        let exe = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/ocr-worker/ocr-worker.exe");
        let ocr = OcrStore::open(&dir, exe).unwrap();
        let state = Arc::new(AppState {
            workspace: crate::assistant_workspace::Workspace::load(&dir),
            workspace_renames: Default::default(),
            file_previews: Default::default(),
            todo_reminders: Default::default(),
            settings: Default::default(),
            index,
            dir: dir.clone(),
            ocr,
            reports: Default::default(),
            proposals: Default::default(),
            tasks: Default::default(),
            task_results: Default::default(),
            pi_sessions: Default::default(),
        });
        let files: Vec<_> = (lane..file_count).step_by(queues).map(|i| {
            let name = format!("sheet-{:02}.pdf",i+1);
            let path = dir.join(&name);
            let source = originals.join(format!("sheet-{:02}.pdf",i%12+1));
            fs::copy(source, &path).unwrap();
            json!({"id":uuid::Uuid::new_v4().to_string(),"path":path,"originalName":name,"profile":profile,
                "status":"queued","lines":[],"fields":{},"proposedName":"","error":"","warning":"","reviewed":false,"elapsedMs":0})
        }).collect();
        let id = uuid::Uuid::new_v4().to_string();
        let task: OcrTask = serde_json::from_value(json!({"id":id,"created":1,"status":"queued","profiles":[profile],
            "useJev":false,"concurrency":if split {1} else {lanes},"files":files,"workflow":{"enabled":true,
            "options":{"exportFormat":"none","rename":"apply","renameConfirmed":true}}})).unwrap();
        state.ocr.save_task(&task).unwrap();
        state
            .ocr
            .cancels
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(AtomicBool::new(false)));
        {
            let mut data = state.ocr.data.lock().unwrap();
            data.queue.push_back(id.clone());
            data.tasks.insert(id.clone(), task);
        }
        jobs.push((state, id));
    }
    fs::write(root.join("ready"), b"").unwrap();
    let wait = Instant::now();
    while !root.join("go").exists() {
        assert!(wait.elapsed() < Duration::from_secs(60));
        thread::sleep(Duration::from_millis(10));
    }
    let hardware = OcrHardware::current();
    let start = Instant::now();
    let queue_stats = std::sync::Mutex::new(Vec::new());
    let measurements = &queue_stats;
    let results: Vec<_> = thread::scope(|scope| {
        let handles: Vec<_> = jobs.into_iter().map(|(state,id)|scope.spawn(move|| {
            let peak_files = std::sync::atomic::AtomicUsize::new(0);
            let workflow_start = std::sync::OnceLock::new();
            let workflow_end = std::sync::OnceLock::new();
            process_queue(state.clone(), &|task| {
                let running = task.files.iter().filter(|file| file.status == "running").count();
                peak_files.fetch_max(running, Ordering::Relaxed);
                if task.workflow.status == "running" { workflow_start.get_or_init(Instant::now); }
                if task.status == "completed" { workflow_end.get_or_init(Instant::now); }
            }, thread_budget);
            let data=state.ocr.data.lock().unwrap();
            let task=&data.tasks[&id];
            assert_eq!(task.status,"completed", "{}",task.workflow.error);
            let peak = peak_files.into_inner();
            assert!((1..=MAX_CONCURRENT_FILES.min(task.files.len())).contains(&peak));
            if lanes > 0 { assert_eq!(peak, if split { 1 } else { lanes.min(task.files.len()) }); }
            let elapsed = workflow_end.into_inner().unwrap().duration_since(workflow_start.into_inner().unwrap());
            measurements.lock().unwrap().push((peak, elapsed.as_secs_f64()));
            task.files.iter().map(|f|json!({"original":f.original_name,"name":f.proposed_name,"status":f.status,"elapsedMs":f.elapsed_ms,
                "renamed":Path::new(&f.path).file_name().unwrap().to_string_lossy()==f.proposed_name && Path::new(&f.path).is_file(),
                "field":f.fields.get("项目名称").map(|v|&v.value),"lines":f.lines.len(),
                "pages":f.lines.iter().map(|l|l.page).collect::<HashSet<_>>().len()})).collect::<Vec<_>>()
        })).collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect()
    });
    let (peaks, workflow_seconds): (Vec<_>, Vec<_>) = queue_stats.into_inner().unwrap().into_iter().unzip();
    fs::write(
        root.join("result.json"),
        serde_json::to_vec(&json!({"seconds":start.elapsed().as_secs_f64(),"logicalCpus":hardware.logical_cpus,
            "totalGiB":hardware.total_gib,"freeGiB":hardware.free_gib,"recommendedFiles":hardware.recommended_files(),
            "peakFilesPerQueue":peaks,"workflowSecondsPerQueue":workflow_seconds,"files":results}))
            .unwrap(),
    )
    .unwrap();
}

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
        let (fields,_)=rules::extract(&lines,profile,&mut vec![]);
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
    assert!(can_use_fast_regions(&profile));
    profile.regions[0].field_key=None;assert!(!can_use_fast_regions(&profile));
    profile.regions[0].field_key=Some("日期".into());profile.fields[0].anchors.clear();assert!(!can_use_fast_regions(&profile));
    assert!(!can_use_fast_regions(&OcrProfile::default()));
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
    task.files[1].status="ready".into();task.files[1].path="renamed-synthetic.pdf".into();task.status="completed".into();task.batch_elapsed_ms=Some(1234);
    let update=task_progress(&task,&known);assert!(update.complete_snapshot);assert_eq!(update.files.len(),3);assert_eq!(update.files[1].path,"renamed-synthetic.pdf");
    assert_eq!(update.batch_elapsed_ms,Some(1234));
    task.status="failed".into();assert!(task_progress(&task,&known).complete_snapshot);
}

#[test]
fn timing_records_are_optional_for_old_results_and_add_both_passes(){
    let legacy=json!({"ocrLinesCount":1,"ocrElapsedMs":10,"jev":{},"decisions":[],"logs":[]});

    let mut diag:OcrFileDiagnostics=serde_json::from_value(legacy).unwrap();assert!(diag.timings.is_none());
    let mut engine=OcrEngineTimings{render_ms:10,detect_ms:20,pages_processed:1,requests:1,..Default::default()};
    engine.add(OcrEngineTimings{render_ms:5,detect_ms:15,pages_processed:1,requests:1,..Default::default()});
    assert_eq!((engine.render_ms,engine.detect_ms,engine.pages_processed,engine.requests),(15,35,2,2));
    diag.timings=Some(OcrTimings{engine:Some(engine),reused_pages:1,..Default::default()});
    let restored:OcrFileDiagnostics=serde_json::from_value(json!(diag)).unwrap();assert_eq!(restored.timings.unwrap().reused_pages,1);
}

#[test]
fn interrupted_rename_recovers_the_item_and_its_task_path() {
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("source.pdf");
    let target = directory.path().join("renamed.pdf");
    std::fs::write(&original, b"synthetic identity fixture").unwrap();
    let mut task = task();
    task.id = uuid::Uuid::new_v4().to_string();
    task.status = "completed".into();
    task.batch_elapsed_ms = Some(1234);
    task.files.truncate(1);
    let file = &mut task.files[0];
    file.id = uuid::Uuid::new_v4().to_string();
    file.path = original.to_string_lossy().into_owned();
    file.status = "ready".into();
    file.fingerprint = store::fingerprint(&original).unwrap();
    let mut batch: OcrRenameBatch = serde_json::from_value(json!({
        "id":"recovery", "taskId":task.id, "status":"preview",
        "items":[{"fileId":file.id,"original":original,"target":target,"status":"pending",
                  "error":"","fingerprint":file.fingerprint}]
    })).unwrap();
    let open = || OcrStore::open(directory.path(),"unused.exe".into()).unwrap();
    {
        let store = open();
        store.save_task(&task).unwrap();
        store.save_batch(&batch).unwrap();
        batch.items[0].status = "applying".into();
        store.save_rename_item(&batch,0).unwrap();
        store::move_no_replace(&original,&target).unwrap();
    }
    for _ in 0..2 {
        let reopened = open();
        let data = reopened.data.lock().unwrap();
        assert_eq!(data.batches[&batch.id].items[0].status,"done");
        assert_eq!(data.tasks[&task.id].batch_elapsed_ms,Some(1234));
        assert_eq!(Path::new(&data.tasks[&task.id].files[0].path),target);
    }
    {
        let store = open();
        batch = store.data.lock().unwrap().batches[&batch.id].clone();
        batch.status = "rollback".into();
        batch.items[0].status = "undoing".into();
        store.save_rename_item(&batch,0).unwrap();
        store::move_no_replace(&target,&original).unwrap();
    }
    let reopened = open();
    let data = reopened.data.lock().unwrap();
    assert_eq!(data.batches[&batch.id].items[0].status,"undone");
    assert_eq!(Path::new(&data.tasks[&task.id].files[0].path),original);
}
