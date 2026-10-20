/** Revise the supplied competition document while preserving its figures and disclosures.
 * Use the Codex managed Node runtime and packages for document work.
 * Usage: node tools/revise-proposal-story.cjs <source.docx> <output.docx>
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const dependencies=process.env.CODEX_DOCUMENT_NODE_MODULES||'C:/Users/GeJie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const JSZip=require(path.join(dependencies,'jszip'));
const source=process.argv[2],output=process.argv[3];
if(!source||!output||path.resolve(source)===path.resolve(output))throw Error('Provide distinct source and output DOCX paths');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const plain=p=>[...p.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>m[1]).join('');
const changes={
 0:'智训云枢 个性化培训与学习智能体平台',
 1:'当前 AI 学习产品已经覆盖对话辅导、课程管理、资料研究和工具编排，但课程、个人资料、执行过程与学习记录仍分散在不同工具中。智训云枢 ITN 面向高校课程、岗位培训和个人自主学习，由 Web 培训平台与 Lumin 桌面学习工作台组成。项目以知识点连接课程教学、个人资料、可执行 Agent 与持续学情：Web 负责课程、资源、练习与反馈，Lumin 把教材、项目文档、课件生成、随课问答和学习记录放到同一工作台。本文说明产品定位、学习流程、技术实现与可复现验证。',
 2:'一、行业判断、用户痛点与产品定位',
 4:'二、产品构成与学习流程',
 21:'Web 培训平台服务于有明确课程和教学组织的场景。学员查看学习目标，进入对应知识点，再选择讲义、实操、测评和课件；教师据此组织教学资源，管理员维护机构成员、账号与平台配置。课程结构为不同角色提供共同的工作范围。',
 22:'Lumin 面向使用自有教材、项目文档和个人笔记的学习者。用户添加资料后，可以检索原文、整理知识结构，并围绕一个知识点提出学习任务。应用把课件、练习、笔记与相关会话保存在本机，后续问答可使用已记录的学习目标和状态；用户按用途配置所需外部模型。',
 23:'三、Web 平台中的课程学习与教学组织',
 24:'（一）从学习目标进入课程',
 25:'学员进入课程后，首先需要确定当前学到哪里、下一步应处理什么。首页汇总当前章节、学习建议和复习入口，知识网络进一步呈现章节与知识点的关系。展开节点后，学员可查看掌握目标与推荐资源，再定位到具体知识点；底部章节速览与右侧导航便于在课程中切换。图 3-1 和图 3-2 展示了从继续学习到定位内容的过程。',
 30:'（二）依据学习基础选择资源',
 31:'同一知识点需要适应不同的学习起点。游客入口提供零基础探索、研究进阶和工程实践三类画像，分别侧重概念解释、原理分析与工程训练。进入知识点后，学员在同一窗口选择领学讲义、实操指南、分阶测试题和交互课件。概念阅读与动手训练因此保持知识点归属，学员可以带着同一个问题继续练习。',
 36:'（三）通过实操与作答检查理解',
 37:'阅读之后，学员需要用操作和作答检查理解。实操资源把目标拆为准备条件和操作步骤，提供目录、检查项与进度记录，便于对照要求完成训练。分阶题按作答进度推进，提交后展示判分与解析，完成的题组仍可回看。图示题组包含 5 道题，完成状态为 100%；学员可以结合题目解析与自己的操作结果，确定需要补练的内容。',
 42:'（四）依据笔记与反馈继续学习',
 43:'一次题组结束后，学习还需要延续。学员可保存带课程来源的笔记，在错题本记录错因并再次作答；成长页汇总掌握度、学习投入、计划完成度和资源偏好。笔记帮助学员回到当时的概念与问题，错题和阶段反馈则提供复习依据。学员下次进入课程时，可以先处理尚未解决的问题，再推进后续内容。',
 49:'学习资源需要支持回到原文核对。讲义和实操中的引用标记对应具体资料，资源页列出来源标题、内容摘要与相关位置；学员对结论有疑问时，可以检查上下文并提交复核反馈。教师也能沿知识点、资源和任务记录检查生成内容与学习目标是否一致，再修订讲解或训练要求。来源信息同时服务于学习者理解内容和教师复核资源。',
 51:'教师按课程、章节和知识点组织讲义、实操、测试与课件，定制任务保留生成进度和结果。教学安排据此连接到学员的具体学习内容，教师可结合学习记录调整后续资源。管理员通过独立入口维护组织成员、知识结构和资源目录，为课程使用提供账号与资源管理支持。',
 52:'在 Agent 入门课程中，学员先从“初识智能体”阅读概念讲义，再按实操步骤构建并分析简单智能体，随后用分阶题检查理解。出现问题时，学员可回到引用资料，保存错因与笔记，再带着这些记录继续训练。下表概括了这条学习流程：每个环节既有用户动作，也有相应记录，便于课程持续推进。',
 69:'四、Lumin 中的个人资料学习与任务执行',
 70:'（一）将个人资料组织为学习结构',
 71:'课程之外，学习者常有自己的教材和项目资料。Lumin 允许选择文件夹或单个文件建立知识库：文件夹原地使用，单文件保存副本，建库后可修改名称。索引后的资料支持检索和原文回看，预览保留 Markdown 表格、代码块与配图；同一小节连续显示，跨分页表格保持完整。已索引内容保留为快照，原文件移走后仍可回看当时的依据。',
 72:'资料进入知识库后，用户可用知识网络整理概念关系，查看连线上的关系说明，并为节点配色、补充笔记。学习导图按教材章节组织知识点和相关资源，便于为一次任务限定范围。生成时显示阶段进度与服务返回的 token 用量，用户可以了解任务推进情况。图示采用 Hello-Agents 示例资料，相关索引和学习记录保存在本机。',
 77:'（二）生成课件并在当前页开展导学',
 78:'围绕选定知识点制作课件时，Lumin 先确认必要的受众、用途、页数与风格，再组织内容、背景、页面布局、讲者备注和文件输出。结果是可编辑的 .pptx，应用中的预览对应实际课件。用户先检查候选结果，满意后再收录为学习资源。课件生成与后续学习因此使用同一份产物，便于核对内容并继续修改。',
 81:'（三）把资料问题落实为实践清单',
 82:'理解概念后，学员还需要明确动手时应做什么。在已有实机案例中，用户指定 ha 知识库中的模型上下文协议（MCP）内容，要求整理工具调用步骤、常见失败点与上线前检查项。Lumin 检索相关资料，输出连接与发现工具、标准化调用和结果整合三个步骤，补充两个常见失败点和 8 项检查表，并附资料引用。图 4-4 记录了该次任务的 26 秒、3 步执行过程；实践清单为用户提供了可逐项核对的操作要求。',
 85:'（四）根据时间约束安排学习任务',
 86:'学习计划需要对应用户能够投入的时间。在另一任务案例中，用户给出学习周期、资料范围和每天可用时间，Lumin 形成 D1 至 D7 学习表，将目标、教材章节、30 至 60 分钟练习和完成标准放在同一安排中，并给出 3 条资料依据。计划覆盖智能体基础、ReAct、框架与综合实践，用户可据此选择当天的学习任务。图 4-5 中该次任务为 30 秒、8 步；两例耗时均为当次运行记录，实际耗时随模型、资料范围与网络条件变化。',
 89:'（五）按学习用途配置模型与朗读',
 90:'上述资料问答、检索、课件生成和朗读需要不同的模型能力。用户在“模型与接口”中填写服务地址、密钥与模型名称，再分别绑定对话、向量、图片理解和 TTS 用途。未配置向量模型时，资料仍可按关键词检索；语音朗读支持协议、音色和格式配置，可以先试听，再通过 Lumin 的语音工具朗读文本。下表说明每类配置在学习流程中的位置。',
 109:'（六）把学习结果带入后续问答',
 110:'一次任务完成后，后续回答还需要了解用户的学习状态。Lumin 将目标、偏好与实际学习记录分别保存：目标和偏好保留本人原话及来源，阅读位置、章节完成、测验、导学检查点和复习队列来自对应操作。首次作答与最新重试分别记录，本人完成标记也与作答证据分别解释，便于区分读过内容、完成练习与已有何种验证。用户可以查看、编辑、删除记忆，或明确要求遗忘。',
 111:'在真实模型验证中，用户先保存“喜欢用图书馆借书类比编程概念”和“刚学会函数、还没学类”，新会话的函数解释能够使用这些信息。用户要求遗忘举例偏好后，再开会话不再召回该偏好，学习阶段信息仍保留。这个案例检查了记忆的写入、使用与撤销，说明个性化回答有可查询、可调整的记录依据。',
 117:'五、创新点：把四个断点做成结构设计',
 118:'（一）用知识点连接课程、个人资料与反馈',
 119:'课程、教材、网页和个人笔记原本分散在不同入口。项目把知识点作为共同归属：Web 端的讲义、实操和测评围绕同一目标组织；Lumin 在个人资料中限定节点范围，再保存课件、笔记与随课会话。用户可以从一个概念出发找到来源、练习和结果，教师也能沿同一节点检查资源与教学目标是否对应。',
 120:'（二）用可检查产物回应生成结果难以核验',
 121:'内容生成先确认范围、资料依据和输出结构，候选稿与已收录版本分别管理。PPT 任务保留可编辑文件及应用内实际预览，资料收集先暂存、由用户核对后再并入知识库；知识图谱按分批摘要、受控并行和缓存推进，并显示阶段进度与 token 用量。用户从“看见答案”推进到“核对依据、检查产物、决定是否收录”，降低把流畅文本误当学习成果的风险。',
 122:'（三）用会话隔离、任务状态和逐次审批维持学习连续',
 123:'随课会话携带资源和当前页上下文，用户翻页后可以继续追问；笔记、记忆和复习信息通过工具访问，并参与新会话。长任务在后台运行，用户仍可新建或切换会话；文件读写、附件和审批保持会话归属，任务可停止、重试或补充要求。等待任务不再迫使学习中断，权限也不会跨会话混用。',
 124:'（四）用仓颉学习运行时降低学习场景的搭建成本',
 125:'Dify、Coze、n8n 等工作流平台把执行能力交给用户编排。Lumin 把学习目标、知识点、资源、会话、任务和审批直接做进运行时，再由仓颉承担 Agent 循环、模型适配、工具协议、会话调度和学习数据聚合，SQLite 驱动也采用仓颉实现。Electron 管理窗口与本地进程，外部模型负责推理，Python 与 Node 组件处理 PPT 文件输出和渲染。用户不需要先搭一套工作流，才能开始学习。',
 126:'六、支撑学习流程的技术实现',
 128:'Web 采用浏览器与服务端部署方式。Nginx 提供同源入口，React 与 TypeScript 页面通过仓颉 API 网关访问业务接口。仓颉业务服务处理账号、组织、学习进度和资源数据；Python Agent 服务承担内容生成、教研、语音与自适应题检查点，平台 MySQL 保存课程、任务和学习记录。图 6-1 展示了两类产品的组件职责，后文分别说明任务如何执行与保存。',
 132:'用户发起资源任务后，平台先取得学习目标、当前学情与相关资料，再按学情诊断、知识检索、内容生成、核验和决策调度划分职责。生成草稿后，系统检查输出结构和引用，任务编排据检查结果发布资源、继续修订或返回错误。前端以任务状态显示进度和结果，业务规则决定何时保存、发布或释放后续题目。下表列出这些判断与学习动作的对应关系。',
 153:'Desktop 由 Electron 拉起仓颉内核，再加载本机工作台。内核在 127.0.0.1 提供界面与接口，runtime 组织消息、事件和工具循环，runtime_host 连接会话、任务、上下文与审批，model_provider 适配外部模型协议。用户提出学习要求后，内核将相关资料交给模型，通过工具执行检索、生成或记录操作，再把工具结果与产物写回会话，供界面展示和后续查询。',
 154:'学习记忆按当前知识库与资源范围聚合，向模型提供本轮所需的学情，详细信息仍可通过工具查询。随课导学中的文件读写逐次确认，审批与附件按会话隔离。PPT 制作由仓颉调度固定的内容与设计流程，再调用文件处理程序输出和预览；文件程序负责课件处理，运行内核维护任务状态、工具结果与资源归属。这样的分工使界面、学习工具和文件产物能够在同一次任务中对照检查。',
 156:'Web 在验证账号和资源归属后，将任务、作答与记录写入平台数据库。Desktop 在本机 SQLite 和目录中保存会话、知识库、资源与进度，重启后恢复已保存的会话和选择状态；中断任务保留状态，供用户检查与重试。网络资料保留来源和抓取时间，仓库资料固定完整 commit。并入成功但索引失败时，界面提示重建入口，避免用户重复复制来源。部署和升级分别备份两端的数据与资源。',
 186:'八、运行验证与后续建设',
 187:'（一）可复现的学习任务流程',
 188:'评审可在 Web 端选择学习画像，进入 Agent 入门课程，从知识点打开讲义、实操与测试，提交答案后查看解析、笔记和成长反馈。在 Lumin 中，可添加同主题教材并建立索引，检索“MCP”并核对原文，再围绕知识点确认需求、生成课件、预览并收录。进入课件后翻页提问、保存笔记，随后开新会话检查已保存的学习状态。两种入口分别提供可运行的学习流程。',
 190:'截至 2026 年 10 月 20 日，176 项内核测试通过。MiMo Flash 真实对话验证记忆保存、跨会话个性化和遗忘；已有真实 PPT 用于验证当前页问答与页间追问。另一组真实模型测试使用仓颉课件夹具，完成并发会话、文件审批、停止、重试和重启恢复的 23 项检查。数据库另经原生 SQLite 只读核对页格式、变长更新后的内容与主键索引。上述证据用于检查运行链路与状态，尚不构成学习成效的量化评估。',
 191:'资料收集完成 27 项检查，覆盖从界面填写链接、网页预览和用户确认，到索引失败重试、检索及重启恢复的过程；真实 HTTPS 网页与固定 commit 的 GitHub 仓库均在确认并入后检索命中。知识库用真实 README 验证 22 行章节表、65 行跨页表格和代码块，配图验证包括断开 GitHub 请求后读取本地图片。桌宠边界与节奏检查 28 项，两阶段启动动画检查 9 项。',
 192:'检查脚本和 TRACE.md 保留操作、失败样本与复测结果，release.json 记录版本、源码提交及资产哈希。测试在隔离数据中运行，真实模型请求、确定性课件夹具和既有任务案例分别记录，便于复现问题并核对验证范围。',
};
const competitorRows=[
 ['综合 AI 助手','ChatGPT、Claude、Gemini','对话与文件理解、项目空间、记忆，以及研究或学习模式','通用任务强；课程结构、个人资料库与本地执行通常需要用户另行组织'],
 ['AI 学习辅导','Khanmigo、Coursera Coach','围绕课程内容答疑、分步引导、练习与反馈','教学交互成熟；能力主要落在各自课程和内容生态内'],
 ['资料研究','Gemini Notebook（原 NotebookLM）','基于上传资料问答、引用、思维导图、音频/视频和学习材料','来源意识强；课程管理、桌面执行和完整学情不在同一闭环'],
 ['Agent/工作流','Dify、Coze、n8n','搭建 Agent、知识库、工具调用与自动化工作流','执行灵活；学习目标、知识点和学情通常需要自行建模'],
 ['课程/教学平台','Moodle、Canvas、雨课堂','课程、作业、测验、成绩与教学数据','教学管理完整；个人资料建库、生成式导学和桌面任务依赖插件或外部工具'],
];
const sectionOneBlocks=[
 {type:'heading',text:'（一）行业从内容生成走向过程支持'},
 {type:'body',text:'生成式 AI 进入学习场景后，产品能力已经从生成解释扩展到对话辅导、课程管理、资料研究、内容生成和工具执行。公开产品资料显示，ChatGPT、Claude、Gemini 等通用助手强化文件理解、项目空间、记忆和研究或学习模式；Khanmigo、Coursera Coach 把对话引导嵌入课程与练习；Gemini Notebook（原 NotebookLM）围绕上传资料提供引用问答、思维导图和学习材料；Dify、Coze、n8n 提供 Agent 与工作流编排；Moodle、Canvas、雨课堂承担课程、作业、测验和教学数据。市场不缺会回答问题的模型，真正稀缺的是把一次回答放进持续学习过程的产品。'},
 {type:'body',text:'下表按公开产品页呈现的能力分工整理，不比较市场份额和模型效果。表中“本项目判断”是团队结合学习流程作出的分析。'},
 {type:'caption',text:'表 1-1  代表产品公开能力与本项目判断'},
 {type:'competitorTable'},
 {type:'body',text:'资料核对日期：2026 年 10 月 20 日。来源为 OpenAI Help Center、Anthropic、Google Gemini Notebook Help、Khanmigo、Coursera、Dify、Coze、n8n、Moodle、Canvas 与雨课堂官方页面。'},
 {type:'body',text:'五类产品分别把课程、辅导、资料、执行和管理做深，学习者得到的却是一组分段工具：课程在 LMS，辅导在课程平台，资料研究在笔记本，执行在工作流，日常问答又在通用助手。一个人要从目标走到资料、实践、产物和复习，仍得自己搬运上下文并拼接流程。'},
 {type:'heading',text:'（二）四个未被接通的断点'},
 {type:'body',text:'课程、教材、网页和个人笔记放在不同入口。知识库能检索资料，课程平台能管理章节，但“这个知识点学到什么程度、用了哪些材料、做过哪些练习”没有共同归属，换一个入口就要重新说明。'},
 {type:'body',text:'生成结果常常停在对话框里。用户能看到一段解释，却不容易核对来源、检查可编辑产物，也分不清候选稿和已收录版本。内容越多，筛选和复核的成本越高。'},
 {type:'body',text:'单次对话可以保持上下文，学习过程却容易被一个长任务打断。用户在等待课件或资料处理时，仍需切换会话、查看进度、控制文件权限，并把结果带回原来的学习位置。'},
 {type:'body',text:'Agent 平台提供工具编排和工作流能力，但学习目标、知识点、练习证据和复习状态不是它们的默认对象。要把通用 Agent 变成学习产品，用户或机构仍需自己搭建流程和数据结构。'},
 {type:'heading',text:'（三）产品定位：以知识点连接学习链'},
 {type:'body',text:'智训云枢由 Web 培训平台与 Lumin 桌面学习工作台组成。Web 端面向有课程组织的学习与教学，Lumin 面向使用自有教材、项目文档和个人笔记的学习者。两端使用同一套知识点语义，把课程资源、个人资料、生成任务、学习会话和记录放到同一条链上。'},
 {type:'body',text:'团队选择以知识点而不是聊天会话作为组织单位。一个概念可以关联目标、前置知识、讲义、实操、测验、课件、笔记和随堂问题；一次任务也会留下来源、工具结果、任务状态和可继续学习的产物。用户下一次打开应用时，回到的是正在学的概念和已经完成的证据，而不是一段难以检索的聊天记录。'},
 {type:'body',text:'这个选择来自我们的判断：学习 AI 的竞争力不只在模型回答得多像老师，还在于它能否让回答找到来源、变成可检查的产物、得到用户确认，并在下一次学习中被重新使用。项目优先解决这条链上的断点，再扩展更多内容和工具。'},
 {type:'heading',text:'（四）项目目标与验证边界'},
 {type:'body',text:'以一次持续两周的 Agent 入门培训为例。学员已经收藏教程、示例项目和零散笔记，却仍需判断先读哪章、该做什么练习，以及程序跑通是否等于掌握概念；教师面对不同基础，也要调整讲解深度和训练量。项目从这组真实动作出发，而不是从功能菜单出发。'},
 {type:'body',text:'原型阶段验证一条可复现路径：学员在 Web 端从学习目标进入知识点，完成阅读、实操、作答、笔记与复习；教师在平台组织资源并查看记录。在 Lumin 中，学员把个人教材或项目资料建成知识库，用知识网络整理概念，限定知识点后生成真实课件，在课件页右侧继续对话，并把笔记、任务和学情带入后续会话。'},
 {type:'body',text:'当前原型主要服务三类对象：需要把课程落到具体知识点的学生，需要组织讲义、练习和反馈的教师，以及使用自有项目资料的自学者。三类对象的共同需求，是让材料、操作结果和后续复习围绕同一个概念保存。'},
 {type:'body',text:'项目不把一次生成内容当作终点。课件、清单、学习计划与检索结果都要能回看来源、继续编辑或进入下一项学习动作；无法核验时，界面应明确失败并保留重试入口。'},
 {type:'body',text:'评价以运行链路、状态断言和可复查产物为主。文档中的测试数据用于证明功能可以工作，不作为学习成效或市场规模结论。'},
];
const additions={
 22:['把两种入口放在同一条学习路径上：Web 负责课程内的目标、资源、练习与反馈，Lumin 负责处理学习者自己的教材、项目文档和待完成的具体任务。当前版本两端独立部署并保存数据；平台账号和学习档案的跨端同步属于后续集成规划。'],
 68:['课程内的目标、资源、练习和反馈由此连成一条线。当学员改用自有教材或项目文档时，学习任务会从 Web 延伸到 Lumin。'],
 78:['图 4-3 展示了生成之后的学习过程：学员翻到验收清单页，追问删去测试记录、只留“运行成功”是否足够。Lumin 依据当前页“另一人可复现”的标准，说明应保留输入、预期与实际结果，以及记录对失败定位的作用。右侧会话保留课件标签和当前页上下文，学员可以继续追问或切换会话；涉及附件文件读写时，仍需逐次确认。'],
 111:['学习足迹与成长页按实际活动回顾进展，用户可以结合笔记、作答和复习记录决定下一步任务。顶部任务中心保留后台状态，较长的生成任务运行时仍可切换会话继续学习；工作台支持浅色、深色与跟随系统，桌宠提供可收起的状态提示。'],
 117:['行业中的单点能力已经很多，项目选择在四个断点上做结构设计。以下四项均对应前文的现实问题，也对应可运行的产品机制。'],
 125:['这些设计在应用中的价值，是让教师保留课程目标和资源标准，让学习者保留选择与确认，由系统承担资料整理、候选生成、状态跟踪和证据保存。评审可以从一个知识点出发，看到课程资源、个人资料、任务产物和反馈如何连续；部署方也能替换模型服务，而不改变学习数据的组织方式。','当前原型的应用重点放在个人资料学习、课程辅助和教师资源准备。跨机构管理、学习效果归因和课程市场不在本次范围内，避免用未经验证的能力扩大结论。'],
 126:['技术章节按一次学习任务如何执行、核验和保存展开，说明上述设计落在哪些运行结构上。'],
};
const futureHeading='（三）平台账号与学习档案衔接规划';
const futureBody='后续建设将优先接入平台账号，使 Lumin 首次使用时可以登录同一学习身份。在用户授权后，计划同步学习目标、偏好、当前进度与待复习内容，支持课程学习与本地资料学习共同使用持续更新的学习档案。例如，平台中尚需巩固的概念可作为桌面课件讲解的参考，桌面形成的笔记与练习结果也可用于安排后续课程。账号互通和跨端同步尚未在当前版本实现，现阶段两端各自保存并使用学习数据。';
(async()=>{
 const beforeBytes=fs.readFileSync(source),zip=await JSZip.loadAsync(beforeBytes);
 const xml=await zip.file('word/document.xml').async('string');
 const ps=[...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(m=>m[0]);
 if(ps.length!==256||!plain(ps[80]).includes('图 4-3')||!plain(ps[115]).includes('衔接规划'))throw Error('Source structure differs from the accepted light-theme document');
 const paragraph=(i,text)=>{
  const original=ps[i],open=original.match(/^<w:p(?: [^>]*)?>/)[0];
  let props=original.match(/<w:pPr[ >][\s\S]*?<\/w:pPr>/)?.[0]||'';
  if(i===111||i===116)props=props.replace(/<w:keepLines(?: [^>]*)?\/>/g,'');
  const run=original.replace(/<w:pPr[ >][\s\S]*?<\/w:pPr>/,'').match(/<w:rPr[ >][\s\S]*?<\/w:rPr>/)?.[0]||'';
  return open+props+'<w:r>'+run+'<w:t xml:space="preserve">'+esc(text)+'</w:t></w:r></w:p>';
 };
 const tableCell=(text,width,{header=false,fill='FFFFFF'}={})=>{
  const run='<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="仿宋_GB2312" w:cs="Times New Roman" w:hint="eastAsia"/>'+(header?'<w:b/>':'<w:b w:val="0"/>')+'<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>';
  return '<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="'+width+'"/><w:shd w:val="clear" w:color="auto" w:fill="'+fill+'"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:start w:w="90" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:end w:w="90" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:keepNext w:val="0"/><w:spacing w:line="300" w:lineRule="exact" w:after="0"/><w:ind w:firstLine="0"/><w:jc w:val="'+(header?'center':'left')+'"/></w:pPr><w:r>'+run+'<w:t xml:space="preserve">'+esc(text)+'</w:t></w:r></w:p></w:tc>';
 };
 const competitorTableXml=()=>{
  const widths=[1350,2100,2920,2773];
  const headerRow='<w:tr><w:trPr><w:tblHeader w:val="true"/><w:cantSplit/></w:trPr>'+['产品类型','代表产品','公开能力','本项目判断'].map((text,i)=>tableCell(text,widths[i],{header:true,fill:'D9E2F3'})).join('')+'</w:tr>';
  const bodyRows=competitorRows.map((cells,row)=>'<w:tr><w:trPr><w:cantSplit/></w:trPr>'+cells.map((text,i)=>tableCell(text,widths[i],{fill:row%2?'F4F7FB':'FFFFFF'})).join('')+'</w:tr>').join('');
  return '<w:tbl><w:tblPr><w:tblW w:type="dxa" w:w="9143"/><w:jc w:val="center"/><w:tblLayout w:type="fixed"/><w:tblLook w:firstColumn="1" w:firstRow="1" w:lastColumn="0" w:lastRow="0" w:noHBand="0" w:noVBand="1" w:val="04A0"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:left w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:right w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/></w:tblBorders></w:tblPr><w:tblGrid>'+widths.map(w=>'<w:gridCol w:w="'+w+'"/>').join('')+'</w:tblGrid>'+headerRow+bodyRows+'</w:tbl>';
 };
 const sectionOneXml=sectionOneBlocks.map(block=>{
  if(block.type==='heading')return paragraph(24,block.text);
  if(block.type==='caption')return paragraph(27,block.text);
  if(block.type==='competitorTable')return competitorTableXml();
  return paragraph(3,block.text);
 }).join('');
 let index=0;
 let newXml=xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g,p=>{
  const n=index++;
  if(n===3)return sectionOneXml;
  if(n===114||n===115||n===116)return '';
  let result=Object.hasOwn(changes,n)?paragraph(n,changes[n]):p;
  for(const text of additions[n]||[])result+=paragraph(3,text);
  if(n===192)result+=paragraph(115,futureHeading)+paragraph(116,futureBody);
  return result;
 });
 const pageBreaksRemoved=(newXml.match(/<w:pageBreakBefore(?: [^>]*)?\/>/g)||[]).length;
 newXml=newXml.replace(/<w:pageBreakBefore(?: [^>]*)?\/>/g,'');
 const withPageBreak=p=>/<w:pPr[ >]/.test(p)?p.replace(/<w:pPr[ >]/,m=>m+'<w:pageBreakBefore/>'):p.replace(/^<w:p(?: [^>]*)?>/,m=>m+'<w:pPr><w:pageBreakBefore/></w:pPr>');
 newXml=newXml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g,p=>{
  const text=plain(p);
  if(text.startsWith('表 1-1')||/^[二三四五六七八]、/.test(text))return withPageBreak(p);
  return p;
 });
 const pageBreaksRestored=(newXml.match(/<w:pageBreakBefore(?: [^>]*)?\/>/g)||[]).length;
 zip.file('word/document.xml',newXml);
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 const before=await JSZip.loadAsync(beforeBytes),after=await JSZip.loadAsync(bytes),changed=[];
 for(const name of Object.keys(before.files)){
  if(before.files[name].dir)continue;
  if(sha(await before.file(name).async('nodebuffer'))!==sha(await after.file(name).async('nodebuffer')))changed.push(name);
 }
 if(changed.length!==1||changed[0]!=='word/document.xml')throw Error('Unexpected package changes: '+changed.join(','));
 if(!newXml.includes('跨端同步尚未在当前版本实现'))throw Error('Missing implementation boundary');
 const beforeChars=ps.reduce((s,p)=>s+plain(p).length,0);
 const finalPs=[...newXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(m=>m[0]);
 const afterChars=finalPs.reduce((s,p)=>s+plain(p).length,0);
 const tablesBefore=(xml.match(/<w:tbl>/g)||[]).length,tablesAfter=(newXml.match(/<w:tbl>/g)||[]).length;
 fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,bytes);
 const stem=output.replace(/\.docx$/i,'');
 const report={source:path.resolve(source),sourceHash:sha(beforeBytes),output:path.resolve(output),outputHash:sha(bytes),changedEntries:changed,beforeChars,afterChars,growthPercent:Number(((afterChars/beforeChars-1)*100).toFixed(1)),rewrittenParagraphs:Object.keys(changes).length,addedParagraphs:Object.values(additions).flat().length+sectionOneBlocks.filter(b=>b.type!=='competitorTable').length,pageBreaksRemoved,pageBreaksRestored,tablesBefore,tablesAfter,competitorRows:competitorRows.length,imagesUnchanged:true,appendicesUnchanged:true,figure43Retained:true};
 fs.writeFileSync(stem+'-report.json',JSON.stringify(report,null,2));
 fs.writeFileSync(stem+'-text.txt',finalPs.map((p,i)=>`${i} ${plain(p)}`).join('\n'));
 console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});
