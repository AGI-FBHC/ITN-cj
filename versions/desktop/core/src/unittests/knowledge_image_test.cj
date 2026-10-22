package itn_desktop_core.unittests

import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.kb.*
import itn_desktop_core.store.*
import itn_desktop_core.agent.learningTools
import itn_desktop_core.util.*

@Test
func knowledgeImagesResolveRelativeAndRepositoryMirrorWithinLibrary(): Unit {
    let dir = freshDir("knowledge-images")
    let root = dir + "/docs"
    ensureDir(root + "/chapter8")
    ensureDir(root + "/images/8-figures")
    writeText(root + "/chapter8/第八章.md", "# 记忆\n\n<img src=\"../images/8-figures/8-1.png\">\n")
    File.writeTo(root + "/images/8-figures/8-1.png", [UInt8(137),UInt8(80),UInt8(78),UInt8(71)])
    let store = Store(dir)
    let s = store.load()
    let kb = KnowledgeBase(); kb.id="images"; kb.rootDir=root; s.knowledgeBases.add(kb); store.save(s)
    let idx=chunkAll(root,1200); saveIndex(dir,kb.id,idx)
    let relative=resolveKnowledgeImage(store,kb.id,"chapter8/第八章.md","../images/8-figures/8-1.png",true)
    @Expect(strOf(relative,"kind"),"local")
    @Expect(intOf(relative,"bytes"),4)
    @Expect(strOf(relative,"dataUrl").contains("data:image/png;base64,"),true)
    let remote="https://raw.githubusercontent.com/datawhalechina/Hello-Agents/main/docs/images/8-figures/8-1.png"
    let mirror=resolveKnowledgeImage(store,kb.id,"chapter8/第八章.md",remote,false)
    @Expect(strOf(mirror,"path"),strOf(relative,"path"))
    @Expect(mirror.get("dataUrl").isNone(),true)
    var denied=false
    try{resolveKnowledgeImage(store,kb.id,"chapter8/第八章.md","../../secret.png",false)}catch(e: Exception){denied=true}
    @Expect(denied,true)
    denied=false
    try{resolveKnowledgeImage(store,kb.id,"chapter8/第八章.md","%2e%2e/%2e%2e/secret.png",false)}catch(e: Exception){denied=true}
    @Expect(denied,true)
    let fallback=resolveKnowledgeImage(store,kb.id,"chapter8/第八章.md","https://example.com/missing.png",true)
    @Expect(strOf(fallback,"kind"),"remote")
    @Expect(strOf(fallback,"url"),"https://example.com/missing.png")
    var called=false
    for(tool in learningTools(store,kb.id,{=>false},"s","t","查这张配图",{k: String,p: JsonObject=>()})){
        if(tool.name=="resolve_knowledge_image"){
            let args=JsonObject();args.put("doc_path",JsonString("chapter8/第八章.md"));args.put("source",JsonString(remote))
            let result=tool.run(args);called=result.ok
            @Expect(result.content.contains("base64"),false)
            @Expect(result.content.contains("8-1.png"),true)
        }
    }
    @Expect(called,true)
}
