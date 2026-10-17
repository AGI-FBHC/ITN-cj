package itn_desktop_core.dev

import std.collection.*
import std.fs.*
import std.time.*
import std.sync.*
import stdx.net.http.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.store.*
import itn_desktop_core.kb.*
import itn_desktop_core.learning.arrOf
import itn_desktop_core.course.courseId
import itn_desktop_core.util.*

// Native, explicit empty-database-only UI fixture. Never enabled in a normal app launch.
/* 检查用开关：每次导图流水线调用延迟 N 毫秒（模拟真实模型的耗时，让进度条可观察），
   并把调用次数/最大并发写进 dataDir/fixture-stats.json 供检查脚本断言。 */
let fixtureLock=Mutex()
var fixtureDelayMs: Int64=0
var fixtureActive: Int64=0
var fixtureMaxActive: Int64=0
var fixtureSummarize: Int64=0
var fixtureMerge: Int64=0
var fixtureTree: Int64=0
var fixtureOther: Int64=0
public func setCourseFixtureDelay(ms: Int64): Unit{synchronized(fixtureLock){fixtureDelayMs=ms}}
func fixtureBegin(kind: String): Unit{synchronized(fixtureLock){fixtureActive+=1;if(fixtureActive>fixtureMaxActive){fixtureMaxActive=fixtureActive};if(kind=="summarize"){fixtureSummarize+=1}else if(kind=="merge"){fixtureMerge+=1}else if(kind=="tree"){fixtureTree+=1}else{fixtureOther+=1}}}
func fixtureEnd(dir: String): Unit{synchronized(fixtureLock){
    fixtureActive-=1
    let o=JsonObject();o.put("summarize",JsonInt(fixtureSummarize));o.put("merge",JsonInt(fixtureMerge));o.put("tree",JsonInt(fixtureTree));o.put("other",JsonInt(fixtureOther));o.put("maxConcurrent",JsonInt(fixtureMaxActive));o.put("delayMs",JsonInt(fixtureDelayMs));o.put("active",JsonInt(fixtureActive))
    try{File.writeTo(dir+Path.Separator+"fixture-stats.json",o.toString().toArray())}catch(e: Exception){()}
}}
func fixtureKindOf(b: JsonObject): String{
    let msgs=arrOf(b,"messages");var sys="";var i=0
    while(i<msgs.size()){let m=objOf(msgs[i]).getOrThrow();i+=1;if(strOf(m,"role")=="system"){sys+=strOf(m,"content")}}
    if(sys.contains("资料整理员")){return "summarize"};if(sys.contains("合并主题")){return "merge"};if(sys.contains("学习思维导图设计者")){return "tree"};return "other"
}
func fixtureArray(values: Array<String>): JsonArray{let a=JsonArray();for(v in values){a.add(JsonString(v))};return a}
func fixtureBody(): String{var s="";for(i in 0..12){s+="先明确工具调用的输入、输出和验收约定，再创建最小样例并执行。以查询文件为例：写下文件名、预期内容和失败时的返回信息，执行后逐项核对输出，确认调用过程留下了可复现的记录。若结果不一致，检查输入参数、权限、执行顺序和观察结果，而不是编造成功。保留原始样例，再添加空输入、缺失文件和重复请求的边界样例；逐个比较实际结果与预期，修正后重新执行验证。[1]\n\n"};return s}
func fixtureLecture(): JsonObject{let o=JsonObject();o.put("title",JsonString("工具调用学习讲义"));o.put("objective",JsonString("理解工具调用并验证输入输出"));o.put("objectives",fixtureArray(["明确输入输出约定","完成一次调用","识别失败与重试"]));let chapters=JsonArray();for(i in 0..2){let c=JsonObject();c.put("title",JsonString(if(i==0){"输入输出的设计"}else{"执行与反馈的验证"}));c.put("introduction",JsonString("从具体样例学习工具调用"));let sections=JsonArray();for(j in 0..2){let s=JsonObject();s.put("title",JsonString("学习步骤 "+(i*2+j+1).toString()));s.put("content",JsonString(fixtureBody()));sections.add(s)};c.put("sections",sections);chapters.add(c)};o.put("chapters",chapters);return o}
func fixturePractice(): JsonObject{let o=JsonObject();o.put("title",JsonString("工具调用实操指南"));o.put("objective",JsonString("独立完成并验证一次工具调用"));o.put("prerequisites",fixtureArray(["了解输入输出"]));o.put("environment",fixtureArray(["本地练习目录"]));let steps=JsonArray();for(i in 0..4){let s=JsonObject();s.put("title",JsonString("实操步骤 "+(i+1).toString()));s.put("instruction",JsonString("打开练习目录，创建输入与预期输出说明，然后执行样例并检查结果。"+fixtureBody()));s.put("code",JsonString(""));s.put("expectedOutput",JsonString("看到输入、输出和验证记录且逐项一致。[1]"));s.put("safety",JsonString("safe"));steps.add(s)};o.put("steps",steps);o.put("acceptanceCriteria",fixtureArray(["输入有记录","输出可核对","边界能解释"]));let trouble=JsonArray();for(i in 0..2){let t=JsonObject();t.put("problem",JsonString("样例问题 "+i.toString()));t.put("solution",JsonString("检查输入与观察结果后重试"));trouble.add(t)};o.put("troubleshooting",trouble);o.put("safetyChecklist",fixtureArray(["只操作练习副本"]));return o}
func fixtureQuiz(): JsonObject{let o=JsonObject();o.put("title",JsonString("工具调用分阶测试"));let points=JsonArray();let kp=JsonObject();kp.put("id",JsonString("kp-1"));kp.put("name",JsonString("输入输出与观察"));kp.put("description",JsonString("判断工具调用是否可验证"));points.add(kp);o.put("knowledgePoints",points);let qs=JsonArray();for(i in 0..3){let q=JsonObject();q.put("id",JsonString("q-"+(i+1).toString()));q.put("knowledgePointId",JsonString("kp-1"));q.put("difficulty",JsonString(["easy","medium","hard"][i]));q.put("stem",JsonString("场景 "+(i+1).toString()+"：执行工具后输出不符合预期，应该先做什么？"));let choices=fixtureArray(["核对输入与观察记录","伪造成功结果","忽略原始问题","删除全部资料"]);q.put("options",choices);q.put("correctIndex",JsonInt(0));q.put("explanation",JsonString("核对输入与观察记录能区分参数错误与执行失败，保留真实证据并支持复现；伪造结果掩盖问题，忽略问题无法完成目标，删除资料会破坏原始证据。[1]"));qs.add(q)};o.put("questions",qs);return o}
func fixturePpt(): JsonObject{let o=JsonObject();o.put("title",JsonString("工具调用演示"));let slides=JsonArray();for(i in 0..4){let s=JsonObject();s.put("title",JsonString(["明确输入输出","执行并观察结果","验证与复盘","独立实践与验收"][i]));s.put("bullets",fixtureArray(["先确认输入、预期结果与边界。[1]","保留观察记录，核对真实输出。[1]"]));s.put("speakerNote",JsonString("用最小工具调用样例演示输入、执行和反馈之间的关系，说明如何区分真实成功与未经核对的假设。先展示预期，再带领学习者逐项验证输出。[1]"));slides.add(s)};o.put("slides",slides);return o}
func fixtureDocRefs(text: String): ArrayList<String>{
    let out=ArrayList<String>();let parts=text.split("\"id\":\"D");var k=1
    while(k<parts.size){let bytes=parts[k].toArray();var n: Int64=0;while(n<bytes.size&&bytes[n]>=48&&bytes[n]<=57){n+=1};if(n>0){out.add("D"+String.fromUtf8(bytes[0..n]))};k+=1}
    return out
}
/** 覆盖提示词里出现的所有文档编号：小库保持原来的三节点结构，大库为每个额外文档补一个二级节点。 */
func fixtureTreeFor(text: String): String{
    let refs=fixtureDocRefs(text);var extra="";var idx: Int64=3
    while(idx<=refs.size){let ref=refs[idx-1];extra+=",{\"key\":\"extra"+idx.toString()+"\",\"parent\":\"root\",\"title\":\"主题 "+ref+"\",\"description\":\"资料 "+ref+" 的学习范围\",\"sources\":[\""+ref+"\"]}";idx+=1}
    return "{\"nodes\":[{\"key\":\"root\",\"parent\":\"\",\"title\":\"工具学习\",\"sources\":[\"D1\",\"D2\"]},{\"key\":\"tools\",\"parent\":\"root\",\"title\":\"工具调用\",\"description\":\"学习输入输出和调用过程\",\"sources\":[\"D1\"]},{\"key\":\"observe\",\"parent\":\"tools\",\"title\":\"观察与验证\",\"sources\":[\"D2\"]}"+extra+"]}"
}
func fixtureReply(b: JsonObject): (String,?JsonObject){
    let messages=arrOf(b,"messages");var user="";var system="";var lastRole="";var i=0
    while(i<messages.size()){let m=objOf(messages[i]).getOrThrow();i+=1;lastRole=strOf(m,"role");if(lastRole=="user"){user=strOf(m,"content")};if(lastRole=="system"){system+=strOf(m,"content")}}
    if(arrOf(b,"tools").size()>0){
        if(lastRole=="tool"){return("候选学习资源已生成，请预览；满意后点击加入我的学习资源。",None)}
        if(user.contains("活跃度")){
            let args=JsonObject();args.put("kbId",JsonString("course-alpha"));let function=JsonObject();function.put("name",JsonString("get_learning_activity"));function.put("arguments",JsonString(args.toString()));let call=JsonObject();call.put("index",JsonInt(0));call.put("id",JsonString(courseId("call-")));call.put("type",JsonString("function"));call.put("function",function);return("",Some(call))
        }
        if(user.contains("任务中心")||user.contains("哪些任务")||user.contains("在跑什么")){
            let args=JsonObject();let function=JsonObject();function.put("name",JsonString("list_activity_tasks"));function.put("arguments",JsonString(args.toString()));let call=JsonObject();call.put("index",JsonInt(0));call.put("id",JsonString(courseId("call-")));call.put("type",JsonString("function"));call.put("function",function);return("",Some(call))
        }
        if(user.contains("请先")&&!user.contains("直接生成")){return("你希望面向什么学习程度？篇幅、题量或使用场景有什么要求？",None)}
        var kind="lecture";for(k in ["practice","quiz","ppt"]){if(system.contains("\"kind\":\""+k+"\"")){kind=k}}
        let args=JsonObject();args.put("kind",JsonString(kind));args.put("topic",JsonString("工具调用"));args.put("detail",JsonString("concise"));args.put("count",JsonInt(3));let function=JsonObject();function.put("name",JsonString("generate_learning_resource"));function.put("arguments",JsonString(args.toString()));let call=JsonObject();call.put("index",JsonInt(0));call.put("id",JsonString(courseId("call-")));call.put("type",JsonString("function"));call.put("function",function);return("",Some(call))
    }
    if(system.contains("你是学习思维导图设计者")){return(fixtureTreeFor(user),None)}
    if(system.contains("资料整理员")||system.contains("合并主题")){return("[D1] 工具调用：输入、输出、参数。[D2] 观察与验证：执行记录、边界、反馈。",None)}
    if(user.contains("\"questions\"")){return(fixtureQuiz().toString(),None)}
    if(user.contains("\"knowledgePoints\"")){return(fixtureQuiz().toString(),None)}
    if(user.contains("\"steps\"")){return(fixturePractice().toString(),None)}
    if(user.contains("\"slides\"")){return(fixturePpt().toString(),None)}
    if(user.contains("\"chapters\"")||user.contains("resourceType: lecture")){return(fixtureLecture().toString(),None)}
    return(fixtureBody(),None)
}
public func seedCourseFixture(dir: String): Unit{
    let db=DbHub.open(dir);if(db.scalarInt("SELECT COUNT(*) FROM knowledge_bases",ArrayList<DbValue>())>0||db.scalarInt("SELECT COUNT(*) FROM sessions",ArrayList<DbValue>())>0){throw Exception("course夹具只允许在空数据目录启动")}
    let mock=ServerBuilder().addr("127.0.0.1").port(0).build();mock.distributor.register("/v1/chat/completions",{ctx: HttpContext=>
        let b=objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow();let kind=fixtureKindOf(b);fixtureBegin(kind);if(fixtureDelayMs>0){sleep(Duration.millisecond*fixtureDelayMs)}
        let (text,call)=fixtureReply(b);fixtureEnd(dir);let delta=JsonObject();delta.put("role",JsonString("assistant"));match(call){case Some(c)=>let calls=JsonArray();calls.add(c);delta.put("tool_calls",calls);case None=>delta.put("content",JsonString(text))};let choice=JsonObject();choice.put("index",JsonInt(0));choice.put("delta",delta);let choices=JsonArray();choices.add(choice);let response=JsonObject();response.put("id",JsonString(courseId("response-")));response.put("choices",choices)
        let first=response.toString();let end=JsonObject();end.put("index",JsonInt(0));end.put("delta",JsonObject());end.put("finish_reason",JsonString(if(call.isSome()){"tool_calls"}else{"stop"}));let ends=JsonArray();ends.add(end);response.put("choices",ends);let usage=JsonObject();usage.put("prompt_tokens",JsonInt(Int64(b.toString().size/4)+12));usage.put("completion_tokens",JsonInt(Int64(text.size/4)+8));response.put("usage",usage)
        ctx.responseBuilder.status(200);ctx.responseBuilder.header("Content-Type","text/event-stream");ctx.responseBuilder.body(("data: "+first+"\n\ndata: "+response.toString()+"\n\ndata: [DONE]\n\n").toArray())
    });spawn{mock.serve()};sleep(Duration.millisecond*150)
    let settings=Settings();let model=ModelConfig();model.id="course-fixture";model.name="本地仓颉检查模型";model.baseUrl="http://127.0.0.1:"+mock.port.toString()+"/v1";model.apiKey="isolated-fixture";model.model="course-fixture";settings.models.add(model);settings.chatModelId=model.id
    for(id in ["course-alpha","course-beta"]){let root=dir+Path.Separator+id;ensureDir(root);let index=KbIndex();index.kbId=id;index.rootDir=root
        for(i in 0..2){let c=KbChunk();c.id="source-"+i.toString();c.docPath="文档"+i.toString()+".md";c.docTitle=if(i==0){"输入输出工具调用"}else{"观察与验证"};c.headingPath=c.docTitle;c.ordinal=i;c.text="# "+c.docTitle+"\n"+fixtureBody();writeText(root+Path.Separator+c.docPath,c.text);index.chunks.add(c)}
        saveIndex(dir,id,index);let kb=KnowledgeBase();kb.id=id;kb.name=if(id=="course-alpha"){"Agent 入门"}else{"Python 编程"};kb.rootDir=root;kb.chunkCount=2;kb.docCount=2;kb.builtAt=stamp();settings.knowledgeBases.add(kb)
    };Store(dir).save(settings)
}
/** Uses a private database copy prepared by the verifier, never the live user database. */
public func useCopiedCourseModel(dir: String,copyDir: String): Unit{
    if(!copyDir.contains("lumin-course-model-copy-")){throw Exception("真实模型检查只读取专用临时数据库副本")}
    let source=Store(copyDir).load();var picked=source.findModel(source.chatModelId);if(picked.isNone()&&source.models.size>0){picked=Some(source.models[0])};let model=picked.getOrThrow();DbHub.reset()
    let target=Store(dir).load();if(target.chatModelId!="course-fixture"){throw Exception("真实模型检查必须先创建空目录夹具")};target.models.clear();target.models.add(model);target.chatModelId=model.id;Store(dir).save(target)
}
