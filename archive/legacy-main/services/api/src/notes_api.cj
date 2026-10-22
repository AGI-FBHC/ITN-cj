package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the notes + note-categories module.
 * Path/method/status/body contracts mirror
 * src/agents/app/routers/public.py note endpoints so the old frontend
 * can point at this service unchanged.
 */
public func registerNotesRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/notes") {
        ctx => handleListNotes(ctx, cfg)
    }
    app.mapPost("v1/notes") {
        ctx => handleCreateNote(ctx, cfg)
    }
    app.mapPatch("v1/notes/{note_id}") {
        ctx => handleUpdateNote(ctx, cfg)
    }
    app.mapDelete("v1/notes/{note_id}") {
        ctx => handleDeleteNote(ctx, cfg)
    }
    app.mapGet("v1/note-categories") {
        ctx => handleListCategories(ctx, cfg)
    }
    app.mapPost("v1/note-categories") {
        ctx => handleCreateCategory(ctx, cfg)
    }
    app.mapPatch("v1/note-categories/{category_id}") {
        ctx => handleUpdateCategory(ctx, cfg)
    }
    app.mapDelete("v1/note-categories/{category_id}") {
        ctx => handleDeleteCategory(ctx, cfg)
    }
}

/* -------- notes -------- */

func handleListNotes(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Note storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = NotesStore(conn)
                        let notes = store.listNotes(userId)
                        conn.close()
                        let arr = JsonArrWriter()
                        for (n in notes) {
                            arr.addRaw(n)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("notes", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listNotes: " + e.message)
                    }
            }
    }
}

func handleCreateNote(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            /* FastAPI validates the body before the handler's available() check. */
            match (readJsonObjectBody(ctx)) {
                case None => return
                case Some(root) =>
                    match (parseNoteCreate(ctx, root)) {
                        case None => return
                        case Some(req) =>
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Note storage is unavailable")
                                return
                            }
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = NotesStore(conn)
                                        let note = store.createNote(userId, req)
                                        conn.close()
                                        match (note) {
                                            case Some(n) => writeJson(ctx.response, 201, n)
                                            case None => writeInternalDebug(ctx.response, "createNote returned None")
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "createNote: " + e.message)
                                    }
                            }
                    }
            }
    }
}

func handleUpdateNote(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "note_id")) {
                case None => return
                case Some(noteId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseNoteUpdate(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalError(ctx.response)
                                        case Some(conn) =>
                                            try {
                                                let store = NotesStore(conn)
                                                let note = store.updateNote(userId, noteId, req)
                                                conn.close()
                                                match (note) {
                                                    case Some(n) => writeJson(ctx.response, 200, n)
                                                    case None => writeDetail(ctx.response, 404, "Note not found")
                                                }
                                            } catch (e: Exception) {
                                                writeInternalError(ctx.response)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleDeleteNote(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "note_id")) {
                case None => return
                case Some(noteId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = NotesStore(conn)
                                let deleted = store.deleteNote(userId, noteId)
                                conn.close()
                                if (deleted) {
                                    ctx.response.statusCode = 204
                                } else {
                                    writeDetail(ctx.response, 404, "Note not found")
                                }
                            } catch (e: Exception) {
                                writeInternalError(ctx.response)
                            }
                    }
            }
    }
}

/* -------- categories -------- */

func handleListCategories(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeInternalError(ctx.response)
                case Some(conn) =>
                    try {
                        let store = NotesStore(conn)
                        let cats = store.listCategories(userId)
                        conn.close()
                        let arr = JsonArrWriter()
                        for (c in cats) {
                            arr.addRaw(c)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("categories", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        writeInternalError(ctx.response)
                    }
            }
    }
}

func handleCreateCategory(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonObjectBody(ctx)) {
                case None => return
                case Some(root) =>
                    /* NoteCategoryCreateRequest (models.py:216): name 1-80,
                     * color Field(pattern="^#[0-9a-fA-F]{6}$") default #5b7f68. */
                    let bag = PyBag()
                    let parentRaw = jsonObjectToRaw(root)
                    var rawName = ""
                    match (pyField(root, "name", "name")) {
                        case None => bag.add(pyMissing(["body", "name"], parentRaw))
                        case Some(f) =>
                            match (pyStr(bag, f, 1, 80)) {
                                case Some(n) => rawName = n.trimAscii()
                                case None => ()
                            }
                    }
                    var color = "#5b7f68"
                    match (pyField(root, "color", "color")) {
                        case None => ()
                        case Some(f) =>
                            match (pyStrPattern(bag, f, "^#[0-9a-fA-F]{6}$")) {
                                case Some(c) => color = c
                                case None => ()
                            }
                    }
                    if (!bag.ok()) {
                        bag.write(ctx.response)
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = NotesStore(conn)
                                let result = store.createCategory(userId, rawName, color)
                                conn.close()
                                if (result.duplicate) {
                                    writeDetail(ctx.response, 409, "Category name already exists")
                                    return
                                }
                                match (result.category) {
                                    case Some(c) => writeJson(ctx.response, 201, c)
                                    case None => writeInternalDebug(ctx.response, "createCategory returned no row")
                                }
                            } catch (e: MySqlError) {
                                conn.close()
                                if (e.code == 1062 || e.messageText.contains("Duplicate")) {
                                    writeDetail(ctx.response, 409, "Category name already exists")
                                } else {
                                    writeInternalDebug(ctx.response, "createCategory MySQL: " + e.message)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "createCategory: " + e.message)
                            }
                    }
            }
    }
}

func handleUpdateCategory(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "category_id")) {
                case None => return
                case Some(categoryId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            /* NoteCategoryUpdateRequest (models.py:221). Both
                             * fields Optional — measured {"name":"","color":"red"}
                             * returns both items in one 422. */
                            let bag = PyBag()
                            var hasName = false
                            var name: ?String = None
                            match (pyFieldOpt(root, "name", "name")) {
                                case None => ()
                                case Some(f) =>
                                    match (pyStr(bag, f, 1, 80)) {
                                        case Some(n) =>
                                            hasName = true
                                            name = Some(n.trimAscii())
                                        case None => ()
                                    }
                            }
                            var hasColor = false
                            var color: ?String = None
                            match (pyFieldOpt(root, "color", "color")) {
                                case None => ()
                                case Some(f) =>
                                    match (pyStrPattern(bag, f, "^#[0-9a-fA-F]{6}$")) {
                                        case Some(c) =>
                                            hasColor = true
                                            color = Some(c)
                                        case None => ()
                                    }
                            }
                            if (!bag.ok()) {
                                bag.write(ctx.response)
                                return
                            }
                            let req = CategoryUpdate(hasName, name, hasColor, color)
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalError(ctx.response)
                                case Some(conn) =>
                                    try {
                                        let store = NotesStore(conn)
                                        let cat = store.updateCategory(userId, categoryId, req)
                                        conn.close()
                                        match (cat) {
                                            case Some(c) => writeJson(ctx.response, 200, c)
                                            case None => writeDetail(ctx.response, 404, "Note category not found")
                                        }
                                    } catch (e: MySqlError) {
                                        if (e.code == 1062) {
                                            writeDetail(ctx.response, 409, "Category name already exists")
                                        } else {
                                            writeInternalError(ctx.response)
                                        }
                                    } catch (e: Exception) {
                                        writeInternalError(ctx.response)
                                    }
                            }
                    }
            }
    }
}

func handleDeleteCategory(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "category_id")) {
                case None => return
                case Some(categoryId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = NotesStore(conn)
                                let deleted = store.deleteCategory(userId, categoryId)
                                conn.close()
                                if (deleted) {
                                    ctx.response.statusCode = 204
                                } else {
                                    writeDetail(ctx.response, 404, "Note category not found")
                                }
                            } catch (e: Exception) {
                                writeInternalError(ctx.response)
                            }
                    }
            }
    }
}

/* -------- request parsing / validation -------- */

func storageUnavailable(cfg: AppConfig): Bool {
    match (cfg.platformDbUrl) {
        case None => return true
        case Some(url) => return url.trimAscii().size == 0
    }
}

/*
 * Shared body reader for the business routes. Delegates to readPyBodyObject
 * so every module emits the same measured body-level 422 (missing / json_invalid
 * / model_attributes_type).
 */
func readJsonObjectBody(ctx: HttpContext): ?JsonObject {
    readPyBodyObject(ctx)
}

/*
 * Path UUID. Delegates to parsePathUuidValidated — uuid_parsing with the
 * uuid-crate diagnostic in both msg and ctx.error, loc ["path", <name>].
 */
func parseRouteUuid(ctx: HttpContext, name: String): ?Array<Byte> {
    parsePathUuidValidated(ctx, name)
}

/*
 * NoteCreateRequest (models.py:165). Fields are validated in declaration
 * order and every failure is collected — pydantic puts all of them in one
 * `details` array (measured: {"title":"","content":""} yields two items).
 *
 * Null handling follows the model exactly: `str`/`list[str]`/`Literal[...]`
 * reject an explicit null, `X | None` treats it as absent.
 */
func parseNoteCreate(ctx: HttpContext, root: JsonObject): ?NoteCreate {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)

    /* title: str = Field(min_length=1, max_length=160) */
    match (pyField(root, "title", "title")) {
        case None => bag.add(pyMissing(["body", "title"], parentRaw))
        case Some(f) => pyDrop(pyStr(bag, f, 1, 160))
    }
    /* content: str = Field(min_length=1, max_length=20000) */
    match (pyField(root, "content", "content")) {
        case None => bag.add(pyMissing(["body", "content"], parentRaw))
        case Some(f) => pyDrop(pyStr(bag, f, 1, 20000))
    }
    /* status: Literal["pending_review", "approved"] = "approved" */
    match (pyField(root, "status", "status")) {
        case None => ()
        case Some(f) => pyDrop(pyLiteralField(bag, f, ["pending_review", "approved"]))
    }
    /* source_type: str = Field(default="manual", max_length=32) — not Optional */
    match (pyField(root, "source_type", "sourceType")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 32))
    }
    /* learner_id: UUID | None */
    var learnerId: ?Array<Byte> = None
    match (pyFieldOpt(root, "learner_id", "learnerId")) {
        case None => ()
        case Some(f) => learnerId = pyUuidField(bag, f)
    }
    /* kp_id: str | None = Field(max_length=64) */
    match (pyFieldOpt(root, "kp_id", "kpId")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 64))
    }
    /* source_kind: str | None = Field(max_length=32) */
    match (pyFieldOpt(root, "source_kind", "sourceKind")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 32))
    }
    /* kb_refs: list[str] = Field(default_factory=list, max_length=20) */
    match (pyField(root, "kb_refs", "kbRefs")) {
        case None => ()
        case Some(f) => pyDrop(pyStrList(bag, f, 20))
    }
    /* source_ref: str | None = Field(max_length=128) */
    match (pyFieldOpt(root, "source_ref", "sourceRef")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 128))
    }
    /* source_context: str | None = Field(max_length=500) */
    match (pyFieldOpt(root, "source_context", "sourceContext")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 500))
    }
    /* category_id: UUID | None */
    match (pyFieldOpt(root, "category_id", "categoryId")) {
        case None => ()
        case Some(f) => pyDrop(pyUuidField(bag, f))
    }
    /* knowledge_category_id: int | None = Field(ge=1) */
    match (pyFieldOpt(root, "knowledge_category_id", "knowledgeCategoryId")) {
        case None => ()
        case Some(f) => pyDrop(pyInt(bag, f, Some(1), None))
    }
    /* knowledge_category_name: str | None = Field(max_length=160) */
    match (pyFieldOpt(root, "knowledge_category_name", "knowledgeCategoryName")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 160))
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(buildNoteCreate(root))
}

func buildNoteCreate(root: JsonObject): NoteCreate {
    let title = strField(root, "title", "title") ?? ""
    let content = strField(root, "content", "content") ?? ""
    var status = "approved"
    match (strField(root, "status", "status")) {
        case Some(s) =>
            if (s == "pending_review" || s == "approved") {
                status = s
            }
        case None => ()
    }
    var sourceType = "manual"
    match (strField(root, "source_type", "sourceType")) {
        case Some(s) =>
            if (charCount(s) <= 32) {
                sourceType = s
            }
        case None => ()
    }
    let learnerId = uuidField(root, "learner_id", "learnerId").value
    let kpId = strField(root, "kp_id", "kpId")
    let sourceKind = strField(root, "source_kind", "sourceKind")
    var kbRefs = Array<String>(0, repeat: "")
    match (stringArrayField(root, "kb_refs", "kbRefs")) {
        case Some(items) => kbRefs = items
        case None => ()
    }
    let sourceRef = strField(root, "source_ref", "sourceRef")
    let sourceContext = strField(root, "source_context", "sourceContext")
    let categoryId = uuidField(root, "category_id", "categoryId").value
    let knowledgeId = intField(root, "knowledge_category_id", "knowledgeCategoryId")
    let knowledgeName = strField(root, "knowledge_category_name", "knowledgeCategoryName")
    var hasKnowledge = false
    match (knowledgeId) {
        case Some(v) => hasKnowledge = v >= 1
        case None => ()
    }
    NoteCreate(title, content, status, sourceType, learnerId, kpId, sourceKind,
               kbRefs, sourceRef, sourceContext, categoryId, hasKnowledge,
               knowledgeId, knowledgeName)
}

/*
 * NoteUpdateRequest (models.py:196). Every field is Optional, so an explicit
 * null is "leave unchanged" (measured 200 for {"title": null}). No source_type
 * / source_ref / source_context here — they exist only on the create model.
 */
func parseNoteUpdate(ctx: HttpContext, root: JsonObject): ?NoteUpdate {
    let bag = PyBag()

    /* title: str | None = Field(min_length=1, max_length=160) */
    match (pyFieldOpt(root, "title", "title")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 1, 160))
    }
    /* content: str | None = Field(min_length=1, max_length=20000) */
    match (pyFieldOpt(root, "content", "content")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 1, 20000))
    }
    /* status: Literal[...] | None */
    match (pyFieldOpt(root, "status", "status")) {
        case None => ()
        case Some(f) => pyDrop(pyLiteralField(bag, f, ["pending_review", "approved"]))
    }
    /* learner_id: UUID | None */
    match (pyFieldOpt(root, "learner_id", "learnerId")) {
        case None => ()
        case Some(f) => pyDrop(pyUuidField(bag, f))
    }
    /* kp_id: str | None = Field(max_length=64) */
    match (pyFieldOpt(root, "kp_id", "kpId")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 64))
    }
    /* source_kind: str | None = Field(max_length=32) */
    match (pyFieldOpt(root, "source_kind", "sourceKind")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 32))
    }
    /* kb_refs: list[str] | None = Field(max_length=20) */
    match (pyFieldOpt(root, "kb_refs", "kbRefs")) {
        case None => ()
        case Some(f) => pyDrop(pyStrList(bag, f, 20))
    }
    /* category_id: UUID | None */
    match (pyFieldOpt(root, "category_id", "categoryId")) {
        case None => ()
        case Some(f) => pyDrop(pyUuidField(bag, f))
    }
    /* knowledge_category_id: int | None = Field(ge=1) */
    match (pyFieldOpt(root, "knowledge_category_id", "knowledgeCategoryId")) {
        case None => ()
        case Some(f) => pyDrop(pyInt(bag, f, Some(1), None))
    }
    /* knowledge_category_name: str | None = Field(max_length=160) */
    match (pyFieldOpt(root, "knowledge_category_name", "knowledgeCategoryName")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 160))
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(buildNoteUpdate(root))
}

func buildNoteUpdate(root: JsonObject): NoteUpdate {
    let hasTitle = jsonHas(root, "title")
    let title = strField(root, "title", "title")
    let hasContent = jsonHas(root, "content")
    let content = strField(root, "content", "content")
    let hasStatus = jsonHas(root, "status")
    let status = strField(root, "status", "status")
    let catRes = uuidField(root, "category_id", "categoryId")
    var hasCategoryId = false
    match (catRes.kind) {
        case UuidFieldKind.Missing => hasCategoryId = false
        case _ => hasCategoryId = true
    }
    let categoryId = catRes.value
    let learnerRes = uuidField(root, "learner_id", "learnerId")
    var hasLearnerId = false
    match (learnerRes.kind) {
        case UuidFieldKind.Missing => hasLearnerId = false
        case _ => hasLearnerId = true
    }
    let learnerId = learnerRes.value
    let hasKpId = jsonHas(root, "kp_id") || jsonHas(root, "kpId")
    let kpId = strField(root, "kp_id", "kpId")
    let hasSourceKind = jsonHas(root, "source_kind") || jsonHas(root, "sourceKind")
    let sourceKind = strField(root, "source_kind", "sourceKind")
    let hasKbRefs = jsonHas(root, "kb_refs") || jsonHas(root, "kbRefs")
    var kbRefs = Array<String>(0, repeat: "")
    match (stringArrayField(root, "kb_refs", "kbRefs")) {
        case Some(items) => kbRefs = items
        case None => ()
    }
    let hasKnowledge = jsonHas(root, "knowledge_category_id") || jsonHas(root, "knowledgeCategoryId")
    let knowledgeId = intField(root, "knowledge_category_id", "knowledgeCategoryId")
    let knowledgeName = strField(root, "knowledge_category_name", "knowledgeCategoryName")
    NoteUpdate(hasTitle, title, hasContent, content, hasStatus, status,
               hasCategoryId, categoryId, hasLearnerId, learnerId,
               hasKpId, kpId, hasSourceKind, sourceKind, hasKbRefs, kbRefs,
               hasKnowledge, knowledgeId, knowledgeName)
}

/* -------- shared helpers -------- */
