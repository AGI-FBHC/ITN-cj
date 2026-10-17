package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import std.posix.getcwd
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.course.*
import itn_desktop_core.store.*
import itn_desktop_core.db.*
import itn_desktop_core.learning.LearningStore
import itn_desktop_core.learning.arrOf
import itn_desktop_core.personal.PersonalStore
import itn_desktop_core.session.*
import itn_desktop_core.pi.ChatProvider
import itn_desktop_core.pi.StepContext
import itn_desktop_core.pi.EventStream
import itn_desktop_core.pi.ModelReply
import itn_desktop_core.agent.courseTools
import itn_desktop_core.dev.seedGrowthActivity
import itn_desktop_core.kb.stamp
import itn_desktop_core.util.*

func courseTestDir(name: String): String{return getcwd().toString()+Path.Separator+freshDir(name)}
func courseLibrary(dir: String): Unit{let s=Settings();let k=KnowledgeBase();k.id="course-kb";k.name="学习资料";k.builtAt="source-v1";k.chunkCount=2;s.knowledgeBases.add(k);Store(dir).save(s)}
func courseDocs(): JsonArray{return match(JsonValue.fromStr("[{\"id\":\"D1\",\"title\":\"文档甲\",\"docPath\":\"a.md\"},{\"id\":\"D2\",\"title\":\"文档乙\",\"docPath\":\"b.md\"}]")){case a: JsonArray=>a;case _=>JsonArray()}}
func courseTree(): String{return "{\"title\":\"学习资料\",\"nodes\":[{\"key\":\"root\",\"parent\":\"\",\"title\":\"学习资料\",\"sources\":[\"D1\",\"D2\"]},{\"key\":\"one\",\"parent\":\"root\",\"title\":\"工具调用\",\"sources\":[\"D1\"]},{\"key\":\"two\",\"parent\":\"one\",\"title\":\"执行与观察\",\"sources\":[\"D2\"]}]}"}
func publishedCourse(dir: String): JsonObject{courseLibrary(dir);let cs=CourseStore(dir);let body=validateCourseTree(courseJson(courseTree()),courseDocs());body.put("sourceVersion",JsonString("source-v1"));let draft=cs.saveDraft("course-kb",body,"");cs.publish(strOf(draft,"id"),"",true);return draft}
func firstCourseNode(map: JsonObject): String{return strOf(objOf(arrOf(map,"nodes")[1]).getOrThrow(),"id")}
func courseCandidate(dir: String,sid: String,kind: String,text: String): JsonObject{
    ensureDir(dir+Path.Separator+"drafts");let file=dir+Path.Separator+"drafts"+Path.Separator+courseId("candidate-")+".md";fsWrite(file,text)
    let body=JsonObject();body.put("kind",JsonString(kind));body.put("title",JsonString(text));body.put("markdown",JsonString(text));body.put("artifactPath",JsonString(file));body.put("artifactName",JsonString("candidate.md"));body.put("citations",JsonArray())
    body.put("content",JsonValue.fromStr("{\"questions\":[{\"id\":\"q1\",\"stem\":\"如何调用工具\",\"options\":[\"先确认输入\",\"胡乱调用\",\"忽略结果\",\"伪造结果\"],\"correctIndex\":0,\"explanation\":\"先确认输入再执行\"}]}"))
    let saved=LearningStore(dir).saveResource(body,"course-kb",sid,"test-turn","",0);let ev=SessionEvent();ev.sessionId=sid;ev.turnId="test-turn";ev.kind="resource/saved";ev.payload=saved;SessionStore(dir).append(ev);return saved
}
func courseSaveArgs(sid: String,candidate: JsonObject,expected: String): JsonObject{let b=JsonObject();b.put("sessionId",JsonString(sid));b.put("path",JsonString(strOf(candidate,"artifactPath")));b.put("expectedResourceId",JsonString(expected));b.put("confirmed",JsonBool(true));return b}
func courseReject(fn: ()->Unit): Bool{try{fn();return false}catch(e: Exception){return true}}
class CourseTestProvider <: ChatProvider {
    public let seen=ArrayList<String>()
    public func respond(ctx: StepContext,stream: EventStream): ModelReply{let r=ModelReply();seen.add(ctx.messages[0].text);r.text=if(ctx.system.contains("只输出完整JSON")){courseTree()}else{"[D1] 工具调用，输入校验。[D2] 执行与观察，反馈循环。"};return r}
}

@Test
class CourseLifecycleTest {
    @TestCase
    func validationRejectsCyclesUnknownSourcesAndExcessDepth(): Unit{
        @Expect(arrOf(validateCourseTree(courseJson(courseTree()),courseDocs()),"nodes").size(),3)
        @Expect(courseReject({=>validateCourseTree(courseJson(courseTree().replace("\"parent\":\"root\"","\"parent\":\"two\"")),courseDocs())}),true)
        @Expect(courseReject({=>validateCourseTree(courseJson(courseTree().replace("\"sources\":[\"D2\"]","\"sources\":[\"D99\"]")),courseDocs())}),true)
        @Expect(courseReject({=>validateCourseTree(courseJson(courseTree().replace("\"sources\":[\"D2\"]","\"sources\":[\"D1\"]")),courseDocs())}),true)
        let deep=courseJson(courseTree());let ns=arrOf(deep,"nodes");for((key,parent) in [("three","two"),("four","three")]){let n=JsonObject();n.put("key",JsonString(key));n.put("parent",JsonString(parent));n.put("title",JsonString(key));n.put("sources",JsonValue.fromStr("[\"D1\"]"));ns.add(n)};@Expect(courseReject({=>validateCourseTree(deep,courseDocs())}),true)
    }
    @TestCase
    func deleteRestoreAndPurgeNeverDeleteMapOrOriginalCandidate(): Unit{
        let dir=courseTestDir("course-trash");let map=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(map);let t=cs.start("course-kb",nid,"lecture","",false);let sid=strOf(t,"sessionId");let candidate=courseCandidate(dir,sid,"lecture","SECRET-COURSE-77")
        let args=courseSaveArgs(sid,candidate,"");args.put("confirmed",JsonBool(false));@Expect(courseReject({=>cs.commit(args)}),true);@Expect(cs.slot(nid,"lecture"),"")
        args.put("confirmed",JsonBool(true));let saved=cs.commit(args);let id=strOf(saved,"id");@Expect(PersonalStore(dir).search("SECRET-COURSE-77",10).size(),1)
        cs.action(id,"trash","","","",true);@Expect(cs.slot(nid,"lecture"),"");@Expect(arrOf(cs.map(cs.head("course-kb")),"nodes").size(),3);@Expect(PersonalStore(dir).search("SECRET-COURSE-77",10).size(),0)
        @Expect(courseReject({=>PersonalStore(dir).read(id)}),true);@Expect(courseReject({=>LearningStore(dir).resource(strOf(candidate,"id"),1)}),true)
        @Expect(strOf(cs.resource(id,true),"text"),"SECRET-COURSE-77");@Expect(exists(strOf(cs.resource(id,true),"path")),true)
        cs.action(id,"restore","course-kb",nid,"",true);@Expect(cs.slot(nid,"lecture"),id);@Expect(PersonalStore(dir).search("SECRET-COURSE-77",10).size(),1)
        cs.action(id,"trash","","","",true);let copy=strOf(cs.resource(id,true),"path");cs.action(id,"purge","","","",true)
        @Expect(exists(copy),false);@Expect(exists(strOf(candidate,"artifactPath")),true);@Expect(cs.head("course-kb"),strOf(map,"id"))
    }
    @TestCase
    func replacementIsConfirmedAndStaleWritersCannotOverwrite(): Unit{
        let dir=courseTestDir("course-optimistic");let map=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(map)
        let a=cs.start("course-kb",nid,"lecture","",false);let sidA=strOf(a,"sessionId");courseMarkBusy(dir,sidA,true);courseMarkBusy(dir,sidA,false);let stale=cs.start("course-kb",nid,"lecture","",true);let sidB=strOf(stale,"sessionId")
        let first=cs.commit(courseSaveArgs(sidA,courseCandidate(dir,sidA,"lecture","第一版"),""));let firstId=strOf(first,"id")
        let second=courseCandidate(dir,sidB,"lecture","第二版候选");@Expect(cs.slot(nid,"lecture"),firstId);@Expect(courseReject({=>cs.commit(courseSaveArgs(sidB,second,""))}),true)
        let current=cs.commit(courseSaveArgs(sidB,second,firstId));let currentId=strOf(current,"id");@Expect(cs.slot(nid,"lecture"),currentId);@Expect(cs.resources("course-kb","archive").size(),1)
        @Expect(courseReject({=>cs.action(firstId,"restore","course-kb",nid,"",true)}),true)
        cs.action(firstId,"restore","course-kb",nid,currentId,true);@Expect(cs.slot(nid,"lecture"),firstId);@Expect(strOf(cs.resource(currentId,false),"status"),"archive")
    }
    @TestCase
    func rebuildingArchivesAndOldSessionsMustChooseANewNode(): Unit{
        let dir=courseTestDir("course-rebuild");let old=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(old);let t=cs.start("course-kb",nid,"lecture","",false);let sid=strOf(t,"sessionId");let candidate=courseCandidate(dir,sid,"lecture","旧节点候选");let saved=cs.commit(courseSaveArgs(sid,candidate,""))
        let body=validateCourseTree(courseJson(courseTree()),courseDocs());body.put("sourceVersion",JsonString("source-v1"));let draft=cs.saveDraft("course-kb",body,strOf(old,"id"));@Expect(cs.head("course-kb"),strOf(old,"id"))
        @Expect(courseReject({=>cs.publish(strOf(draft,"id"),strOf(old,"id"),false)}),true)
        cs.publish(strOf(draft,"id"),strOf(old,"id"),true);@Expect(cs.resources("course-kb","archive").size(),1);@Expect(boolOf(cs.target(sid),"valid"),false)
        @Expect(courseReject({=>cs.commit(courseSaveArgs(sid,candidate,""))}),true)
        let newNode=firstCourseNode(draft);cs.action(strOf(saved,"id"),"attach","course-kb",newNode,"",true);@Expect(cs.slot(newNode,"lecture"),strOf(saved,"id"));@Expect(arrOf(cs.map(strOf(old,"id")),"nodes").size(),3)
    }
    @TestCase
    func nodeEditsPreserveIdentityAndDeletingParentPromotesChildren(): Unit{
        let dir=courseTestDir("course-nodes");let map=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(map);let child=strOf(objOf(arrOf(map,"nodes")[2]).getOrThrow(),"id")
        let edit=JsonObject();edit.put("title",JsonString("工具契约"));cs.editNode("course-kb",nid,edit);@Expect(strOf(cs.node("course-kb",nid),"title"),"工具契约")
        let move=JsonObject();move.put("parentId",JsonString(child));@Expect(courseReject({=>cs.editNode("course-kb",nid,move)}),true)
        let removal=JsonObject();removal.put("remove",JsonBool(true));removal.put("confirmed",JsonBool(true));cs.editNode("course-kb",nid,removal);@Expect(intOf(cs.node("course-kb",child),"depth"),2)
        let root=strOf(objOf(arrOf(map,"nodes")[0]).getOrThrow(),"id");@Expect(courseReject({=>cs.editNode("course-kb",root,removal)}),true)
    }
    @TestCase
    func evidenceSurvivesArchivalAndRestorationWithoutDoubleCounting(): Unit{
        let dir=courseTestDir("course-evidence");let map=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(map);let sid=strOf(cs.start("course-kb",nid,"quiz","",false),"sessionId");let candidate=courseCandidate(dir,sid,"quiz","测试资源");let saved=cs.commit(courseSaveArgs(sid,candidate,""));let ls=LearningStore(dir)
        ls.answer(strOf(candidate,"id"),1,"q1",0,"attempt-one");ls.answer(strOf(candidate,"id"),1,"q1",0,"attempt-two");@Expect(intOf(cs.report("course-kb"),"quizAttempts"),1)
        cs.action(strOf(saved,"id"),"archive","","","",true);@Expect(intOf(cs.report("course-kb"),"quizAttempts"),1)
        cs.action(strOf(saved,"id"),"restore","course-kb",nid,"",true);@Expect(intOf(cs.report("course-kb"),"quizAttempts"),1)
        let b=JsonObject();b.put("done",JsonBool(true));cs.editNode("course-kb",nid,b);@Expect(intOf(cs.report("course-kb"),"completedNodes"),1)
    }
    @TestCase
    func fixedPipelineReadsAllBatchesAndCancelledRebuildKeepsCurrentMap(): Unit{
        let dir=courseTestDir("course-full-source");courseLibrary(dir);let db=DbHub.open(dir);var text="";for(i in 0..1200){text+="完整资料内容"}
        db.run("INSERT INTO chunks(kb_id,chunk_key,doc_path,doc_title,heading_path,ord,text) VALUES (?,?,?,?,?,?,?)",va([tv("course-kb"),tv("a#1"),tv("a.md"),tv("文档甲"),tv("工具"),nv(0),tv(text+"FIRST-DOC-END")]))
        db.run("INSERT INTO chunks(kb_id,chunk_key,doc_path,doc_title,heading_path,ord,text) VALUES (?,?,?,?,?,?,?)",va([tv("course-kb"),tv("b#1"),tv("b.md"),tv("文档乙"),tv("观察"),nv(1),tv(text+"LAST-DOC-END")]))
        let jobs=CourseJobs(Store(dir));let j=jobs.start("course-kb");let p=CourseTestProvider();jobs.run(strOf(j,"id"),Some(p));@Expect(strOf(jobs.read(strOf(j,"id")),"status"),"completed")
        var seenFirst=false;var seenLast=false;for(s in p.seen){if(s.contains("FIRST-DOC-END")){seenFirst=true};if(s.contains("LAST-DOC-END")){seenLast=true}};@Expect(seenFirst,true);@Expect(seenLast,true)
        let cs=CourseStore(dir);let head=cs.head("course-kb");let cancelledJob=jobs.start("course-kb");jobs.cancel(strOf(cancelledJob,"id"));jobs.run(strOf(cancelledJob,"id"),Some(CourseTestProvider()));@Expect(cs.head("course-kb"),head);@Expect(strOf(jobs.read(strOf(cancelledJob,"id")),"status"),"cancelled")
    }
    @TestCase
    func removedKnowledgeBaseIsRecoverableWithoutTouchingSourceFiles(): Unit{
        let dir=courseTestDir("course-kb-delete");let map=publishedCourse(dir);let cs=CourseStore(dir);let original=dir+Path.Separator+"original.md";fsWrite(original,"原始资料")
        cs.removeKb("course-kb");@Expect(Store(dir).load().findKb("course-kb").isNone(),true);@Expect(exists(original),true);@Expect(cs.deletedKbs().size(),1)
        cs.restoreKb("course-kb",true);@Expect(Store(dir).load().findKb("course-kb").isSome(),true);@Expect(cs.head("course-kb"),strOf(map,"id"))
    }
    @TestCase
    func courseToolsHaveReadWriteParityAndDoNotAcceptUnrequestedDeletion(): Unit{
        let dir=courseTestDir("course-tools");publishedCourse(dir);let names=HashSet<String>();var denied=false
        for(t in courseTools(Store(dir),"s","请看看我的学习进度")){names.add(t.name);if(t.name=="manage_course_resource"){let a=JsonObject();a.put("action",JsonString("trash"));try{t.run(a)}catch(e: Exception){denied=true}}}
        @Expect(names.contains("read_course_map"),true);@Expect(names.contains("generate_course_map"),true);@Expect(names.contains("save_course_resource"),true);@Expect(names.contains("get_course_progress"),true);@Expect(names.contains("get_learning_activity"),true);@Expect(denied,true)
    }
    @TestCase
    func growthActivityCountsOnlyEffectiveLearningEvidence(): Unit{
        @Expect(activityDateAdd("2024-02-28",1),"2024-02-29");@Expect(activityDateAdd("2024-02-28",2),"2024-03-01");@Expect(activityDateAdd("2025-12-31",1),"2026-01-01")
        let dir=courseTestDir("course-activity");seedGrowthActivity(dir)
        let activity=CourseStore(dir).activity("course-alpha")
        @Expect(intOf(activity,"total"),23);@Expect(intOf(activity,"activeDays"),7);@Expect(intOf(activity,"currentStreak"),3);@Expect(intOf(activity,"longestStreak"),3)
        let today=String.fromUtf8(stamp().toArray()[0..10]);let days=arrOf(activity,"days");var todayCount: Int64=-1;var quiz: Int64=0;var node: Int64=0;var completion: Int64=0
        var i: Int64=0
        while(i<days.size()){let d=objOf(days[i]).getOrThrow();i+=1;if(strOf(d,"date")==today){todayCount=intOf(d,"count");quiz=intOf(d,"quiz");node=intOf(d,"node");completion=intOf(d,"completion")}}
        @Expect(todayCount,5);@Expect(quiz,3);@Expect(node,1);@Expect(completion,1)
        let report=CourseStore(dir).report("course-alpha");@Expect(strOf(objOf(report.get("activity").getOrThrow()).getOrThrow(),"to"),today)
    }
    @TestCase
    func retryIsIdempotentAndExistingFilesCanBeExplicitlyLinked(): Unit{
        let dir=courseTestDir("course-retry-import");let map=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(map);let sid=strOf(cs.start("course-kb",nid,"lecture","",false),"sessionId");let candidate=courseCandidate(dir,sid,"lecture","可重试的确认版本");let args=courseSaveArgs(sid,candidate,"");let first=cs.commit(args);let again=cs.commit(args);@Expect(strOf(first,"id"),strOf(again,"id"));@Expect(cs.resources("course-kb","archive").size(),0)
        let file=dir+Path.Separator+"import.md";fsWrite(file,"已有普通讲义");let save=JsonObject();save.put("path",JsonString(file));save.put("confirmed",JsonBool(true));let personal=PersonalStore(dir).save(save)
        let attach=JsonObject();attach.put("personalId",personal.get("id").getOrThrow());attach.put("kbId",JsonString("course-kb"));attach.put("nodeId",JsonString(nid));attach.put("kind",JsonString("lecture"));attach.put("expectedResourceId",first.get("id").getOrThrow());attach.put("confirmed",JsonBool(true));cs.adopt(attach)
        @Expect(cs.slot(nid,"lecture"),strOf(personal,"id"));@Expect(cs.resources("course-kb","archive").size(),1);@Expect(cs.unlinked().size(),0)
    }
    @TestCase
    func journalReplaysFileMovementAfterConnectionRestart(): Unit{
        let dir=courseTestDir("course-journal");let map=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(map);let sid=strOf(cs.start("course-kb",nid,"lecture","",false),"sessionId");let a=cs.commit(courseSaveArgs(sid,courseCandidate(dir,sid,"lecture","重启恢复的副本"),""));let id=strOf(a,"id");let from=strOf(a,"path");let to=PersonalStore(dir).directory()+Path.Separator+"归档"+Path.Separator+"recovered.md";let db=DbHub.open(dir)
        db.run("INSERT INTO course_files VALUES (?,?,?,'pending')",va([tv("replay-one"),tv(from),tv(to)]));db.run("UPDATE personal_resources SET path=? WHERE id=?",va([tv(to),tv(id)]));db.run("UPDATE course_assets SET status='archive' WHERE id=?",va([tv(id)]));db.run("DELETE FROM course_slots WHERE resource_id=?",va([tv(id)]));DbHub.reset()
        CourseStore(dir).recoverFiles();@Expect(exists(to),true);@Expect(exists(from),false);@Expect(slurp(to),"重启恢复的副本");@Expect(strOf(CourseStore(dir).resource(id,false),"status"),"archive")
    }
    @TestCase
    func missingFileKeepsMapAndResourceIdentity(): Unit{
        let dir=courseTestDir("course-missing-file");let map=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(map);let sid=strOf(cs.start("course-kb",nid,"lecture","",false),"sessionId");let candidate=courseCandidate(dir,sid,"lecture","文件外部变化");let a=cs.commit(courseSaveArgs(sid,candidate,""));let id=strOf(a,"id");remove(strOf(a,"path"));@Expect(boolOf(cs.resource(id,false),"missing"),true);@Expect(cs.slot(nid,"lecture"),id);@Expect(arrOf(cs.map(cs.head("course-kb")),"nodes").size(),3)
        let wrong=dir+Path.Separator+"wrong.md";fsWrite(wrong,"不是原文件");@Expect(courseReject({=>cs.relocate(id,wrong,true)}),true);cs.relocate(id,strOf(candidate,"artifactPath"),true);@Expect(boolOf(cs.resource(id,false),"missing"),false);@Expect(cs.slot(nid,"lecture"),id)
    }
    @TestCase
    func deletingSessionDoesNotDeleteConfirmedResource(): Unit{
        let dir=courseTestDir("course-delete-session");let map=publishedCourse(dir);let cs=CourseStore(dir);let nid=firstCourseNode(map);let sid=strOf(cs.start("course-kb",nid,"lecture","",false),"sessionId");let a=cs.commit(courseSaveArgs(sid,courseCandidate(dir,sid,"lecture","会话删除后仍保留"),""));SessionStore(dir).remove(sid);@Expect(boolOf(cs.resource(strOf(a,"id"),false),"sourceSessionDeleted"),true);@Expect(cs.slot(nid,"lecture"),strOf(a,"id"));@Expect(exists(strOf(a,"path")),true)
    }
}
