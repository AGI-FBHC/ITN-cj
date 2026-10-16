package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.knowledge.KnowledgeStore
import itn_desktop_core.personal.PersonalStore
import itn_desktop_core.store.Store
import itn_desktop_core.agent.personalTools
import itn_desktop_core.agent.learningTools
import itn_desktop_core.util.*

@Test
class KnowledgeStoreTest {
    func point(title: String,definition: String,question: String): JsonObject {
        let b=JsonObject();b.put("title",JsonString(title));b.put("definition",JsonString(definition));b.put("quote",JsonString(question));b.put("note",JsonString("本次讨论保留例子与边界依据"));let aliases=JsonArray();aliases.add(JsonString("I/O"));b.put("aliases",aliases);return b
    }
    @TestCase
    func recordsAreGroundedIdempotentAndPreserveUserEdits(): Unit {
        let dir=freshDir("knowledge-grounding");let ks=KnowledgeStore(dir);let q="请解释输入与输出的约定"
        let first=ks.save(point("输入与输出","明确输入、输出与验收",q),false,"session","turn",q,"D:/workspace")
        let id=strOf(first,"id")
        @Expect(intOf(ks.save(point("输入与输出","其他解释",q),false,"session","turn",q,"D:/workspace"),"recordCount"),1)
        let edited=point("输入输出契约","本人修订的定义",q);edited.put("id",JsonString(id));ks.save(edited,true,"","","","")
        let alias=ks.save(point("I/O","不得覆盖本人编辑",q),false,"session","another",q,"D:/workspace")
        @Expect(strOf(alias,"id"),id);@Expect(strOf(alias,"definition"),"本人修订的定义");@Expect(intOf(alias,"recordCount"),2)
        @Expect(PersonalStore(dir).search("边界依据",10).size(),1)
    }
    @TestCase
    func defaultHasNoLinksAndManualDeleteKeepsNotes(): Unit {
        let dir=freshDir("knowledge-links");let ks=KnowledgeStore(dir)
        let a=ks.save(point("概念甲","定义甲",""),true,"","","","");let b=ks.save(point("概念乙","定义乙",""),true,"","","","")
        @Expect(ks.graph().toString().contains("\"links\":[]"),true)
        let aid=strOf(a,"id");let bid=strOf(b,"id");ks.link(aid,bid,"对比",false);ks.link(bid,aid,"对比",false)
        let links=match(ks.graph().get("links")){case Some(v: JsonArray)=>v;case _=>JsonArray()};@Expect(links.size(),1)
        ks.addNote(aid,"MANUAL-NOTE-9527 本人的理解");ks.delete(aid)
        @Expect(PersonalStore(dir).search("MANUAL-NOTE-9527",10).size(),1)
        let remaining=match(ks.graph().get("links")){case Some(v: JsonArray)=>v;case _=>JsonArray()};@Expect(remaining.size(),0)
    }
    @TestCase
    func nodeColorPersistsAndModelRecordsCannotOverrideIt(): Unit {
        let dir=freshDir("knowledge-color");let ks=KnowledgeStore(dir)
        let first=ks.save(point("配色约定","默认颜色",""),true,"","","","")
        let id=strOf(first,"id");@Expect(strOf(first,"color"),"")
        let edited=point("配色约定","自定义颜色","");edited.put("id",JsonString(id));edited.put("color",JsonString("#e07a5f"))
        ks.save(edited,true,"","","","")
        @Expect(strOf(ks.read(id),"color"),"#E07A5F")
        let recorded=ks.save(point("配色约定","模型补记","请解释配色约定"),false,"s","t","请解释配色约定","")
        @Expect(strOf(recorded,"color"),"#E07A5F")
        var rejected=false
        try{let bad=point("配色约定","坏颜色","");bad.put("id",JsonString(id));bad.put("color",JsonString("red"));ks.save(bad,true,"","","","")}catch(e: Exception){rejected=true}
        @Expect(rejected,true);@Expect(strOf(ks.read(id),"color"),"#E07A5F")
        let noField=point("配色约定","不带颜色字段","");noField.put("id",JsonString(id));ks.save(noField,true,"","","","")
        @Expect(strOf(ks.read(id),"color"),"#E07A5F")
        let cleared=point("配色约定","清空颜色","");cleared.put("id",JsonString(id));cleared.put("color",JsonString(""));ks.save(cleared,true,"","","","")
        @Expect(strOf(ks.read(id),"color"),"")
    }
    @TestCase
    func fabricatedQuotesAndOneOffFileTasksDoNotCreateNodes(): Unit {
        let dir=freshDir("knowledge-filter");let ks=KnowledgeStore(dir);var rejected=false
        try{ks.save(point("编造","定义","没说过"),false,"s","t","你好","")}catch(e: Exception){rejected=true};@Expect(rejected,true)
        rejected=false
        try{ks.save(point("HTML","定义","创建HTML文件"),false,"s","t","创建HTML文件","")}catch(e: Exception){rejected=true};@Expect(rejected,true)
        let nodes=match(ks.graph().get("nodes")){case Some(v: JsonArray)=>v;case _=>JsonArray()};@Expect(nodes.size(),0)
    }

    @TestCase
    func timelineMergesRecordsAndManualNodes(): Unit {
        let dir=freshDir("knowledge-timeline");let ks=KnowledgeStore(dir)
        let a=ks.save(point("时间线甲","定义甲","请解释时间线甲"),false,"s1","t1","请解释时间线甲","")
        let b=ks.save(point("时间线乙","定义乙",""),true,"","","","")
        let tl=ks.timeline(50)
        let items=match(tl.get("items")){case Some(v: JsonArray)=>v;case _=>JsonArray()}
        var record=false;var created=false;var i=0
        while(i<items.size()){
            let o=objOf(items[i]).getOrThrow();i+=1
            if(strOf(o,"type")=="record"&&strOf(o,"nodeId")==strOf(a,"id")&&strOf(o,"question").size>0){record=true}
            if(strOf(o,"type")=="created"&&strOf(o,"nodeId")==strOf(b,"id")){created=true}
        }
        @Expect(record,true);@Expect(created,true)
    }
}
@Test
class PersonalOverviewToolsTest {
    func arr(o: JsonObject,key: String): JsonArray{
        match(o.get(key)){case Some(v: JsonArray)=>return v;case _=>return JsonArray()}
    }
    func seedNode(dir: String): Unit {
        let ks=KnowledgeStore(dir);let b=JsonObject()
        b.put("title",JsonString("MCP 协议"));b.put("definition",JsonString("模型上下文协议：把工具与资源标准化暴露给模型。"))
        b.put("quote",JsonString("请解释 MCP 协议"));b.put("note",JsonString("本轮围绕 MCP 的定位展开。"))
        ks.save(b,false,"s1","t1","请解释 MCP 协议","")
    }
    @TestCase
    func emptyQueryReturnsOverviewInsteadOfBlankHits(): Unit {
        let dir=freshDir("personal-overview");seedNode(dir);let store=Store(dir)
        var hits=-1;var knowledge=-1
        for(d in personalTools(store,"s","t","你能看到我的知识网络吗")){
            if(d.name!="search_personal_resources"){continue}
            let details=objOf(d.run(JsonObject()).details).getOrThrow()
            knowledge=intOf(objOf(details.get("counts").getOrThrow()).getOrThrow(),"knowledge")
            hits=arr(details,"hits").size()
        }
        @Expect(hits>=1,true);@Expect(knowledge,1)
    }
    @TestCase
    func typeFilterListsOneKindAndKeywordSearchStillWorks(): Unit {
        let dir=freshDir("personal-overview-type");seedNode(dir);let store=Store(dir)
        var listed=JsonArray();var invalid=false
        for(d in personalTools(store,"s","t","列出知识点")){
            if(d.name!="search_personal_resources"){continue}
            let args=JsonObject();args.put("type",JsonString("knowledge"))
            listed=arr(objOf(d.run(args).details).getOrThrow(),"hits")
            let bad=JsonObject();bad.put("type",JsonString("draft"))
            try{d.run(bad)}catch(e: Exception){invalid=true}
        }
        @Expect(listed.size(),1);@Expect(strOf(objOf(listed[0]).getOrThrow(),"type"),"knowledge")
        @Expect(invalid,true)
        var keyword=0
        for(d in personalTools(store,"s","t","查 MCP")){
            if(d.name!="search_personal_resources"){continue}
            let args=JsonObject();args.put("query",JsonString("MCP"))
            keyword=arr(objOf(d.run(args).details).getOrThrow(),"hits").size()
        }
        @Expect(keyword>=1,true)
    }
    @TestCase
    func learningContextCarriesTheKnowledgeNetworkSummary(): Unit {
        let dir=freshDir("personal-overview-context");seedNode(dir)
        var seen=false
        for(d in learningTools(Store(dir),"",{=>false},"s","t","你能看到我的知识网络吗",{kind: String,p: JsonObject=>()})){
            if(d.name!="get_learning_context"){continue}
            let details=objOf(d.run(JsonObject()).details).getOrThrow()
            let k=objOf(details.get("knowledge").getOrThrow()).getOrThrow()
            let recent=arr(k,"recent")
            seen=intOf(k,"total")==1&&recent.size()==1&&strOf(objOf(recent[0]).getOrThrow(),"title")=="MCP 协议"
        }
        @Expect(seen,true)
    }
}
