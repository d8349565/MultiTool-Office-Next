# 变更日志

## v0.5.3 - 2026-10-27

### Improvements

- The OCR action is now explicitly “Recognize and rename in one click.” It runs recognition and automatic renaming continuously, without another rename button or filename confirmation for eligible files. Old review-only or preview-only preferences no longer interrupt new one-click tasks; the OCR-only action remains available.
- One-click tasks report completion only when every file has a successful rename record. Uncertain results, errors, locked files, and conflicts remain visible for review. Identity checks, non-replacing renames, execution records, and undo protections are retained.

### 修复与完善

- OCR 的一键入口明确为“一键识别并改名”，按当前配置连续完成识别与自动重命名，正常项无需再次点击改名或确认名称；兼容旧的只核对/只预览设置，保留“仅识别”分步入口。
- 只有本批全部文件都有成功改名记录时，才显示“识别与重命名已完成”。需复核、失败、占用或冲突项集中保留，继续沿用文件身份校验、不覆盖、执行记录与撤销保护。

### Compatibility / 使用说明

- Windows x64 and Microsoft Edge WebView2 are required. OCR models are bundled and run locally; optional connected services may charge provider fees. Clicking the clearly labelled one-click action authorizes that task's recognition and renaming using the current profiles; uncertain items are not forced through.
- 需要 Windows x64 和 Microsoft Edge WebView2；OCR 模型随安装包提供并在本机处理，可选联网服务可能产生服务商费用。点击明确标注的一键入口即按当前配置执行本次识别与改名；不确定或异常项不会被强行处理。
- Application build / 应用构建版本：`2026.1027.1553`（最小递增）。

### Verification scope / 验证范围

- Reused passing checks from this session: 12 legacy-option/export-format combinations, the rename-completion regression, the existing task-authorization regression, and the frontend build. The final version is production-built and its installer configuration, versions, and SHA-256 checksums are verified. No complete GUI walkthrough, fresh-install acceptance, real OCR, or connected-service validation was performed; no user business files were read. No GitHub Actions workflows are configured.
- 复用本会话已通过的 12 种旧选项/导出格式组合、改名完成条件回归、原有任务级授权回归与前端构建；最终版本完成生产构建、安装配置、版本与 SHA-256 核验。未进行完整界面走查、全新安装验收、真实 OCR 或联网服务验证，未读取用户业务文件；仓库未配置 GitHub Actions 工作流。

## v0.5.2 - 2026-10-27

### Improvements

- Rename a single file or folder from its context menu, selected-item action, or F2. Extensions are preserved by default; review the original and target paths before confirming.
- Renaming uses a pinned Windows source handle without replacing existing targets. Persistent intent/result records support guarded undo and interrupted-operation checks; affected paths, navigation, and indexes are refreshed, and stale OCR results require reimport.
- Ctrl+K history now records files and folders only after a successful system-open request. Selection, browsing, locating, and previews no longer add entries. Frequently used program history is retained; older mixed file/folder history starts accumulating again from explicit opens.

### 修复与完善

- 文件工作区新增单个文件/文件夹安全重命名：右键菜单、所选项按钮及 F2，默认保留扩展名，核对原路径和目标路径后再确认。
- 通过 Windows 源对象句柄执行不覆盖目标的改名，操作前后保留本地记录，支持安全撤销和中断状态核对。同步索引、目录后代路径、导航与最近打开记录；受影响的旧 OCR 结果需重新导入，OCR 运行期间禁止改名。
- Ctrl+K 只记录成功发起系统打开的文件/文件夹，选择、浏览、定位和预览不计入。常用程序历史继续保留；旧文件历史未区分操作来源，从实际打开重新累计。

### Compatibility / 使用说明

- Windows x64 and Microsoft Edge WebView2 are required. OCR models are bundled and run locally. The app and installer remain in Simplified Chinese; optional connected services may charge provider fees.
- Rename checks use file IDs, sizes, and Windows timestamps without reading document bodies. Only local working folders are supported. Case-only changes, links, protected objects, target paths over 240 UTF-16 units (including descendants), folders exceeding 10,000 descendants, and file systems without reliable change timestamps are rejected. Undo stops on changes or conflicts; uncertain interrupted operations require manual review. Other programs are not transactionally frozen during folder renames.
- 需要 Windows x64 和 Microsoft Edge WebView2；OCR 模型随安装包提供并在本机处理。软件界面和安装器仍为简体中文，可选联网服务可能产生服务商费用。
- 重命名仅核对文件标识、大小和 Windows 时间，不读取正文。仅支持本地工作目录；暂不支持只改大小写、链接、受保护对象、完整目标路径（含子项）超过 240 个 UTF-16 字符、目录超过 10,000 个子项或缺少可靠变更时间的文件系统。撤销遇到状态变化或名称占用会停止，无法确认的中断记录需人工处理；目录改名不能事务性冻结其他程序。
- Application build / 应用构建版本：`2026.1027.1552`。

### Verification scope / 验证范围

- Reused passing checks from this session: 15 workspace/OCR rename safety cases, one index regression, path checks, and Rust static checks. The final version is production-built and its installer configuration, versions, and SHA-256 checksum are verified. No complete GUI walkthrough, fresh-install acceptance, real OCR, or connected-service validation was performed; no user business documents were read. No GitHub Actions workflows are configured.
- 复用本会话已通过的 15 项改名/OCR 安全用例、1 项索引回归、路径检查和 Rust 静态检查；最终版本完成生产构建、安装配置、版本及 SHA-256 核验。未进行完整界面走查、全新安装验收、真实 OCR 或联网服务验证，未读取用户业务正文；仓库未配置 GitHub Actions 工作流。

## v0.5.1 - 2026-10-24

### Improvements

- Directory filters prioritize exact directory-name or relative-path matches before partial matches, with ranking applied before pagination.
- Clearing file-search keywords returns focus to the search box while retaining other filters.
- The default README is now in English, with a complete Simplified Chinese edition, language switching, clearer Windows download instructions, and existing screenshots and demos.

### 修复与完善

- 目录筛选优先展示目录名或相对路径精确匹配的结果，在候选分页前完成排序，避免目标被大量模糊结果挤到后页。
- 清空文件搜索关键词后，焦点返回搜索框，方便继续输入；其他筛选条件保留。
- 默认 README 改为英文首页，提供完整中文版和语言切换，突出 Windows 下载与快速上手，并保留已有真实截图和演示。

### Compatibility / 使用说明

- Windows x64 and Microsoft Edge WebView2 are required. OCR models are bundled and run locally. The app and installer remain in Simplified Chinese; optional connected services may charge provider fees.
- 需要 Windows x64 和 Microsoft Edge WebView2；OCR 模型随安装包提供并在本机处理。软件界面和安装器仍为简体中文，可选联网服务可能产生服务商费用。
- Application build / 应用构建版本：`2026.1024.1522`。

### Verification scope / 验证范围

- Production build and installer checksum verification, with existing Rust static-check and test-target compilation results reused. No simulated tests, real OCR, or fresh-install verification in this release.
- 本次验证范围为程序编译、安装包构建及校验，复用已有 Rust 静态检查和测试目标编译结果；未运行模拟测试、真实 OCR 或全新环境安装验收，未读取用户业务数据。

## v0.5.0 - 2026-10-22

### 新增

- OCR 支持按首页关键词逐文件匹配配置；无唯一匹配或文字质量不足时保留文字供复核，可更换配置仅重新处理单个文件。
- 新增 OCR 一键任务，可组合识别、TXT / CSV / JSON 导出、改名预览或确认后的自动改名；中断后可仅继续后续步骤。
- 文件工作区支持跨层目录筛选，按目录名或相对路径查找，并与文件关键词、扩展名和修改时间组合使用。
- Ctrl+K 快捷面板增加常用工具和最近访问的文件、目录，支持应用内定位、分页选中及记录移除。
- 助理支持生成 Markdown，以及在已确认读取的 XLSX 副本中翻译指定文字单元格，保留其他样式、合并、数字与公式。

### 修复与完善

- 助理文件夹使用独立授权范围，支持授权范围内的绝对路径、子目录与分页查找，相关追问和续接保留目录范围。
- OCR 自动改名将名称截断、非法字符替换等命名警告纳入复核；继续任务时根据最新结果重新生成未执行项目的预览。
- OCR 导出先完整写入临时文件再发布；通过已保存的内容校验值恢复中断记录，无法确认的同名文件保留并另加序号新建。
- 兼容已有 OCR 配置、任务和改名记录；保留文件身份校验、不覆盖原文件和改名撤销机制。
- 应用构建版本同步为 `2026.1022.1606`。

### 使用说明与限制

- Windows x64 桌面版依赖 WebView2，离线 OCR 组件随安装包提供；联网模型服务可能产生费用，使用前仍需确认服务与数据范围。
- 自动匹配依赖已有配置的关键词，不代表模型置信度；自动改名首次启用或规则改变时需确认，需复核项不会直接处理。
- Excel 翻译只新建副本，不修改原文件；译文完整性、行高列宽仍需核对，替换单元格中的富文本会转为普通文字。
- 本次完成静态检查、测试目标编译和安装包构建；未运行模拟测试、真实 OCR 或实机安装验收，也未读取用户业务数据。人工验收范围见 [OCR 与文件工作区验收清单](docs/issues-9-12.md)。

## v0.4.0 - 2026-10-19

### 新增

- 联网搜索新增 DeepSeek 渠道，保留 Tavily；支持复用指定 DeepSeek 官方模型配置的密钥，或单独填写搜索 Key。
- DeepSeek 搜索优先使用返回的网页正文，缺失时使用摘要；支持按需额外抓取网页正文，默认关闭，并与搜索共用任务联网次数上限。
- 会话费用新增 DeepSeek Search / Fetch 按次明细，与模型 token 费用分别统计；保留请求时单价，后续回答失败或任务中断不丢失已记录费用，无法核实的请求标为待核实。
- 费用计价支持编辑搜索与抓取单价、来源及核对日期；连接测试费用在测试结果和联网活动中查看。
- AI 助手新增 PDF 创建，支持中文标题、段落与简单表格；排版完成后预览并逐文件确认保存，生成文件可在应用内预览。
- 文件列表及目录浏览支持 Windows 原生拖出文件和文件夹，可复制到资源管理器，或交给支持接收文件的其他应用。
- 新增 `Alt+1` 至 `Alt+5` 模块切换快捷键。

### 修复与完善

- 统一搜索配置与设置页的草稿、保存和撤销流程，修复保存成功后仍提示“未保存”、底栏无法保存或撤销搜索参数的问题。
- 调整搜索渠道与密钥来源的表单对齐，收起详细计费说明；明确区分密钥测试保存与模块参数保存。
- 搜索与网页抓取统一遵循仅本地模式、联网授权及本地资料会话隔离；更换渠道或凭据时停止旧请求，测试未启用渠道的密钥不会打断当前渠道搜索。
- 来源链接和生成报告区分搜索摘要、网页正文及截断状态，优先复用已有足够正文，避免重复抓取计费。
- 更新配置引导、数据与隐私说明，以及 DeepSeek 搜索、计费和保存状态的人工验收清单。
- 修复助理目录已经授权、生成文件却无法通过交付链接预览或打开的问题；文件浏览目录与助理目录仍分别授权。
- 改善 Office 文件保持打开时的读取兼容性；文件被独占、已移动、权限不足或在确认期间变化时，给出具体原因并停止读取。
- 修复助手收起后文件确认不可见的问题，确认窗口可独立显示；拒绝、取消及撤销权限后不执行待确认操作。
- 新配置默认任务等待提高至 30 分钟、单次请求 10 分钟；已有设置保留，低于推荐值时可查看调整建议，不改变用户的思考程度。
- 上下文接近容量时压缩发送副本中的历史回复和工具资料；超限时最多进行一次更强压缩重试，完整本地记录和当前用户约束保留。
- 继续未完成任务时保留原目标、范围及成功交付的文件，避免重复生成；任务目标和调度状态及时保存，应用中断后可继续处理。
- 修复多行流式事件解析及缺少完成原因仍被当成完整回复的问题；模型服务异常显示脱敏后的具体错误与请求标识。
- 重新排列常用工具设置中的类型、名称、分组、路径和操作按钮，修复分组输入过窄及不同宽度下的对齐问题。
- 减少操作界面的意外文本选中，保留输入与正文区域的正常复制能力。
- 应用构建版本同步为 `2026.1019.2128`。

### 使用说明与限制

- PDF 当前支持创建和本地预览，尚不支持通过助理工具读取 PDF 正文；生成文件仍只允许新建，不覆盖、修改或删除原文件。
- 模型连接使用 OpenAI 兼容接口；Anthropic Messages 协议尚未接入。服务地址、模型 ID、权限与余额仍需按厂商文档核对；更换模型后需重新确认助理目录授权，涉及本地资料时新建会话。
- Windows x64 桌面版依赖 WebView2，离线 OCR 组件随安装包提供。联网模型、搜索与抓取可能产生服务商费用，使用前会核对服务与数据范围。
- 已完成本机隔离流程回归与安装包构建，并由用户进行实际测试；未对所有模型服务和全新安装环境逐项验收。验证范围见[本版调整与验收清单](docs/next-release.md)。

## v0.3.0 - 2026-10-15

### 新增

- 首次配置引导，提供工作目录、模型与联网搜索的分步设置，以及 DeepSeek、Tavily 密钥获取说明。
- 隐私与联网设置，支持仅本地模式、按功能及服务授权、撤销授权和查看脱敏活动摘要。
- 独立模型连接配置。
- AI 助手新增专用工作区域，可在用户授权后读取本地资料，并将整理结果保存为新文件，具体用法见下文。
- 文件预览窗口支持拖动调整大小、方向键微调，并记住窗口尺寸。

#### AI 助手工作区域：读取资料与生成文件

在 AI 助手中用日常语言提出需求，即可让模型读取指定资料、提取信息、整理摘要，并生成可打开使用的文档。例如，将会议材料整理为 Word 纪要、将资料中的项目整理成 Excel 清单，或根据已有内容制作要点式 PPT。

文件工作台中添加的浏览、搜索目录，与这里的“助理工作目录”分别管理。添加索引目录不会自动允许 AI 读取正文；助理只能在另行选择并授权的专用文件夹内操作。

**如何开启与使用**

1. 打开“设置 → 助理配置 → 助理工作目录与文件权限”，选择一个本地专用文件夹，放入本次需要处理的资料。只选择或保存位置不会授予文件访问权限。
2. 勾选“允许助理在此目录读取文件内容和新建文件”，核对目录、当前模型服务与数据使用说明，再勾选风险确认并保存授权。
3. 返回 AI 助手，说明要读取的文件、处理目标及输出格式。文件可使用相对于助理工作目录的名称；读取子目录文件时，需提供相对路径。
4. 读取前核对确认框中的文件名、目录、格式、大小和模型服务；生成前检查文件名、格式及内容预览。逐项确认后才会读取正文或保存文件，保存成功后显示文件交付入口。

**支持范围**

| 操作 | 支持内容 | 当前限制 |
| :--- | :--- | :--- |
| 查看可用文件 | 列出助理工作目录根部支持的文件名及大小 | 最多展示 100 个文件，不读取正文，也不递归列出子目录文件 |
| 读取文字资料 | TXT、MD、CSV、JSON、HTML | 文本需为 UTF-8 编码；读取 HTML 时不执行其中的脚本或外部链接 |
| 读取 Office 资料 | Word DOCX、Excel XLSX、PowerPoint PPTX | 提取文字及单元格内容，不还原完整排版；Excel 只读取已有缓存值，不计算公式，缓存可能过期；不读取含宏的文档 |
| 新建普通文档 | TXT、Word DOCX、Excel XLSX、静态 HTML、PowerPoint PPTX | 支持标题、段落、简单表格与标题/要点幻灯片；Excel 内容写为文字，不提供复杂公式、宏或嵌入对象 |
| 新建交互网页 | 自包含的交互式 HTML，如简单网页、小游戏或交互图表 | 需额外授权；使用内联 CSS/JavaScript，不支持外部库、网络接口或浏览器持久存储 |

单个读取文件上限为 8 MB，返回给模型的文字最多 4 万字符，超出时截取并提示；Office 文档另有内部结构和解压大小限制。PDF、图片及旧版 DOC/XLS/PPT 不属于这项文件正文读取能力的支持格式。

生成文件只保存到助理工作目录根部，单个输出不超过 8 MB。当前仅支持新建，不支持覆盖、直接修改、删除或重命名原文件，也不执行本地程序。同名文件会提示换名，已有文件保留。

**可以这样提出需求**

以下文件名仅为用法示例，需先将相应资料放入已授权的目录：

- “读取 `会议记录.docx`，整理主要结论和后续事项，保存为 `会议纪要.docx`。”
- “读取 `资料/项目清单.xlsx`，按负责人整理一份新清单，保存为 `项目分工.xlsx`。”
- “读取 `方案说明.md`，整理成 5 页要点式演示文稿，保存为 `方案汇报.pptx`。”

**交互式 HTML 的额外授权**

基本文件读写权限不会自动开启脚本能力。需要制作交互网页时，须额外勾选“允许生成含脚本的交互式 HTML”，完成二次确认；每个文件保存前还需查看源码并确认脚本风险。完整源码上限为 1 MB。

应用只保存文件，不自动打开或执行。用户手动用浏览器打开后，代码在受限隔离容器中运行；不支持 CDN、外部资源、网络接口、localStorage、cookie、下载或动态代码求值，页面状态关闭后不保留。隔离措施不能代替代码审计或运行验证，生成成功不代表网页或游戏已经测试可用。

**授权与数据处理说明**

- 读取文件名和正文是为了交给当前模型处理，相关内容可能保存在模型服务及本机聊天记录中；该功能不等同于纯本地 AI 处理。授权前请核对资料是否适合发送给该服务。
- 目录权限默认关闭，每次正文读取和文件生成仍需单项确认。拒绝、取消或超时不会执行；单项文件确认最长等待 5 分钟，也受本次任务总预算限制。
- 只允许本地专用目录，不能授权磁盘根目录、整个个人目录、系统/应用目录或网络路径；拒绝通过链接或路径跳转访问目录外文件。配置导入、聊天指令或角色文件不能代替用户授权。
- 更换目录、模型配置、服务账号或更新密钥后，需要重新确认权限；涉及本地资料的旧会话不能直接转交给新服务继续处理，需新建会话并重新授权读取。
- 会话接触助理工作目录的文件名或正文后，将停止该会话的公开联网搜索；如需搜索公开资料，请另建会话。
- 可在同一设置页查看近期文件操作记录、撤销读写授权，或清空目录设置。撤销会取消涉及文件的运行中任务，但不会删除已有文件或聊天，也无法收回已发送给模型的内容；关闭交互网页权限不会停止外部浏览器中已打开的网页。

更多权限细节见 [助理文件工作目录与安全边界](docs/assistant-workspace-security.md)。

### 修复与完善

- 收集箱显示条目拖拽手柄，可直接拖入四象限归类。
- OCR 改名提供逐项预检、异常排除和部分成功统计，支持失败项重试、异常 CSV 导出与撤销重试，兼容旧记录。
- Tavily 连接测试与启用分开处理，新密钥测试成功后再保存；仅本地模式及授权撤销可阻止相关联网请求。
- WebView2 下载与安装失败时显示中文恢复说明和微软官方下载入口，并修正安装路径引号。
- 扩充六类 OCR 示例配置、虚构演示资料生成脚本及使用指南，更新产品说明和演示图片。
- 应用构建版本同步为 `2026.1015.2117`。
