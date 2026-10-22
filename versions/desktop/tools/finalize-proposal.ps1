param(
  [string]$Source = 'D:\Desktop\仓颉杯\创新原型赛道\V1.0 项目说明.docx',
  [string]$Output = 'D:\Desktop\仓颉杯\创新原型赛道\V1.1 项目说明.docx'
)
$ErrorActionPreference = 'Stop'
$zip = [IO.Compression.ZipFile]::OpenRead($Source)
try {
  $reader = [IO.StreamReader]::new($zip.GetEntry('word/document.xml').Open())
  try { $originalXml = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally { $zip.Dispose() }
$document = [xml]::new()
$document.PreserveWhitespace = $true
$document.LoadXml($originalXml)
$ns = [Xml.XmlNamespaceManager]::new($document.NameTable)
$ns.AddNamespace('w','http://schemas.openxmlformats.org/wordprocessingml/2006/main')
$replacements = [ordered]@{
  '当前 AI 学习产品已经覆盖' = '智训云枢 ITN 面向高校课程、岗位培训与个人自主学习，由 Web 培训平台和 Lumin 桌面学习工作台组成。项目围绕知识点组织资料、学习任务和反馈：学员在 Web 端沿课程完成阅读、实操与测评，在 Lumin 中使用自己的教材和项目文档，完成检索、课件制作、随页问答与笔记整理。系统保存任务来源、生成产物和学习记录，供后续查询与学习使用。当前两端分别运行、独立保存数据，账号与学习档案互通列入后续建设计划。'
  '一、行业背景、用户需求与产品定位' = '一、行业背景与用户需求'
  '生成式 AI 进入学习场景后' = '生成式 AI 已用于答疑、课程辅导、资料研究与内容制作。ChatGPT、Claude、Gemini 等通用助手提供对话、文件理解和研究支持；Khanmigo、Coursera Coach 将辅导嵌入课程；Gemini Notebook（原 NotebookLM）围绕用户资料提供引用问答和学习材料；Dify、Coze、n8n 支持工具与工作流编排；Moodle、Canvas、雨课堂承担课程、作业和测验管理。学习者已有多种工具可选，但从确定目标、查阅资料到完成练习、整理成果，仍常需在不同工具之间切换。'
  '下表依据各产品官方公开资料整理' = '下表按主要使用场景比较代表性产品。各类产品的定位不同，表中侧重说明学习者使用这些工具时仍需组织的内容。'
  '能力边界' = '学习场景中的使用侧重'
  '通用任务能力较完整；' = '适合开放式问答与内容处理；课程目标、练习安排和个人资料的关联通常由用户组织'
  '课程内辅导与反馈较成熟；' = '围绕平台课程开展辅导；使用自有教材或项目资料时，仍需另行安排学习流程'
  '资料引用与内容整理能力较完整；' = '围绕指定资料研究与整理；课程教学管理和本地文件任务需结合其他工具开展'
  '编排与执行能力较强；' = '提供通用编排能力；学习目标、知识点和学情需要开发者配置相应数据与流程'
  '教学管理功能完整；' = '以课程教学管理为主；个人资料处理与桌面任务通常通过扩展或其他工具完成'
  '五类产品分别在课程、辅导' = '上述产品分别侧重课程管理、辅导、资料研究或任务执行。对于同时使用课程和个人资料的学习者，工具之间的任务衔接与记录整理仍需要额外投入。项目据此关注以下四类问题。'
  '系统以知识点而非聊天会话' = '系统以知识点组织学习内容，并保留相关会话。一个概念可以关联目标、前置知识、讲义、实操、测验、课件和笔记；一次任务保存来源、执行状态和产物。用户再次进入应用时，可以从知识点找到相关资料和学习记录，继续尚未完成的任务。'
  '学习产品需要同时保证回答质量' = '项目将来源查看、产物预览和用户确认纳入学习流程。用户先检查检索片段或生成结果，再决定是否收录为学习资源；收录后的内容保留所属知识点与相关记录，供后续问答和复习使用。'
  '项目不以单次内容生成为终点' = '课件、实践清单、学习计划与检索结果均保留来源或任务记录。用户可以回看依据、修改产物并继续学习；任务失败时，界面显示错误与重试入口。'
  '当前版本聚焦上述学习路径' = '当前版本重点验证课程学习与个人资料学习的核心流程，尚未开展规模化教学应用或学习效果对照研究。'
  '把两种入口放在同一条学习路径上' = 'Web 端组织课程内的目标、资源、练习与反馈，Lumin 处理学习者自己的教材、项目文档和具体任务。两端采用相近的知识点组织方式，但当前独立部署、分别保存数据，尚不支持自动共享学习记录。平台账号和学习档案的跨端同步见第八章建设计划。'
  '课程内的目标、资源、练习和反馈由此' = '上述流程覆盖课程内的学习与反馈。学员需要补充教材、整理项目文档或制作自己的课件时，可以使用 Lumin 开展个人资料学习。'
  '针对上述问题，项目从四个层面' = '项目的设计重点是让资料、生成任务和学习记录保持对应关系。以下四项设计分别回应前文的资料分散、结果难核对、长任务中断与学习流程需自行搭建等问题。'
  '课程、教材、网页和个人笔记原本分散' = '针对资料分散、学习记录难以对应的问题，项目采用知识点作为内容归属。Web 端围绕课程知识点组织讲义、实操和测评；Lumin 在个人知识库中关联节点、课件、笔记与随课会话。用户可在各自应用内从一个概念查找相关资料与记录。两端目前共用这一组织思路，数据尚未互通。'
  '上述机制使教师能够保留课程目标' = '教师据此组织课程资源并查看学习反馈，学习者可以核对来源、选择产物、管理笔记和记录。模型提供内容理解与生成，应用维护任务状态、权限和数据归属。部署方或用户可以更换模型服务，已有资料与学习记录仍由应用保存。'
  '（四）以仓颉学习运行时降低应用建设成本' = '（四）以仓颉实现学习任务运行内核'
  'Dify、Coze、n8n 等工作流平台把执行能力' = '针对通用 Agent 平台需要另行配置学习流程的问题，Lumin 在运行内核中定义知识库、资源、会话、任务和审批等对象，并提供检索、笔记与学习记录工具。仓颉实现 Agent 循环、模型适配、工具调用、会话调度和学习数据聚合，SQLite 驱动也采用仓颉实现。Electron 管理窗口与本地进程，外部模型负责推理，Python 与 Node 组件处理 PPT 文件输出和渲染。用户配置模型并添加资料后，即可发起学习任务。'
  '当前原型重点服务个人资料学习' = '当前原型主要用于课程辅助、个人资料学习和教师资源准备。跨机构管理与学习效果评估仍需结合后续应用开展。'
  '技术章节按照学习任务的执行' = '系统分为 Web 服务和 Desktop 本地运行两部分，分别承担课程教学与个人资料学习。以下说明核心组件、任务执行和数据保存方式。'
  '用户可在 Web 端选择学习画像' = '以 Agent 入门学习为例，用户可在 Web 端选择学习画像，从知识点打开讲义、实操和测试，提交答案后查看解析与学习反馈。在 Lumin 中，用户添加同主题教材并建立索引，检索“MCP”并查看原文，再围绕知识点生成课件、预览和收录。打开课件后，可翻页提问、保存笔记，并在新会话中继续使用已保存的学习状态。这两条流程分别展示课程学习与个人资料学习，当前不涉及跨端数据同步。'
  '当前版本已通过 176 项内核测试' = 'Lumin 0.8.28 已通过 176 项内核测试。真实模型对话验证了记忆保存、跨会话使用与遗忘；已有 PPT 用于验证当前页问答和翻页追问。另以独立课件样本完成 23 项并发会话、文件审批、停止、重试和重启恢复检查。相关检查验证功能运行与状态保存，尚不能据此判断学习效果。'
  '（四）提交材料' = '（四）交付内容'
  '项目提交材料包括项目说明' = '源码仓库、Windows 运行包和 Web 体验入口见第七章；第三方组件、模型接口、既有开发基础、本次新增工作及人工智能工具使用情况见附录。'
}
$changed = @()
foreach($key in $replacements.Keys) {
  $matches = @($document.SelectNodes('//w:body//w:p',$ns) | Where-Object { (($_.SelectNodes('.//w:t',$ns) | ForEach-Object InnerText) -join '').StartsWith($key,[StringComparison]::Ordinal) })
  if($matches.Count -ne 1) { throw "Expected one paragraph for $key, found $($matches.Count)" }
  $p = $matches[0]
  if($p.SelectSingleNode('.//w:drawing|.//w:hyperlink',$ns)) { throw "Cannot replace illustrated or linked paragraph: $key" }
  $texts = $p.SelectNodes('.//w:t',$ns)
  $texts[0].InnerText = $replacements[$key]
  for($i=1; $i -lt $texts.Count; $i++) { $texts[$i].InnerText = '' }
  $changed += $key
}
# Keep the short model configuration table together instead of leaving one row on a page.
foreach($table in $document.SelectNodes('//w:tbl',$ns)) {
  $firstCell = ($table.SelectSingleNode('./w:tr/w:tc',$ns).SelectNodes('.//w:t',$ns) | ForEach-Object InnerText) -join ''
  if($firstCell -ne '用途') { continue }
  $paragraphs = $table.SelectNodes('.//w:p',$ns)
  for($i=0;$i -lt $paragraphs.Count-1;$i++) {
    $p = $paragraphs[$i]
    $prop = $p.SelectSingleNode('./w:pPr',$ns)
    if(!$prop) { $prop=$document.CreateElement('w','pPr',$ns.LookupNamespace('w')); [void]$p.PrependChild($prop) }
    if(!$prop.SelectSingleNode('./w:keepNext',$ns)) { [void]$prop.AppendChild($document.CreateElement('w','keepNext',$ns.LookupNamespace('w'))) }
  }
}
# Keep the team appendix title with its table on the final page.
$heading = $document.SelectNodes('//w:body/w:p',$ns) | Where-Object { (($_.SelectNodes('.//w:t',$ns)|ForEach-Object InnerText)-join '').StartsWith('附录四') }
$prop = $heading.SelectSingleNode('./w:pPr',$ns)
if(!$prop.SelectSingleNode('./w:pageBreakBefore',$ns)) { [void]$prop.AppendChild($document.CreateElement('w','pageBreakBefore',$ns.LookupNamespace('w'))) }
# Keep the source intact; change only document.xml in the new review copy.
Copy-Item -LiteralPath $Source -Destination $Output
$zip = [IO.Compression.ZipFile]::Open($Output,[IO.Compression.ZipArchiveMode]::Update)
try {
  $zip.GetEntry('word/document.xml').Delete()
  $entry = $zip.CreateEntry('word/document.xml',[IO.Compression.CompressionLevel]::Optimal)
  $writer = [IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
  try { $writer.Write($document.OuterXml) } finally { $writer.Dispose() }
} finally { $zip.Dispose() }
Write-Output ("Updated {0} paragraphs: {1}" -f $changed.Count,$Output)
Get-FileHash -LiteralPath $Output -Algorithm SHA256
