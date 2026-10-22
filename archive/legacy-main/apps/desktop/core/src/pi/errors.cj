package itn_desktop_core.pi

/**
 * 运行时自己的异常类型。
 *
 * 单独立一个类型是为了让宿主能区分"运行时内部错"和"用户取消"（内核 llm.cj 里
 * LlmException / CancelException 是同一个套路：取消要能被原样重抛，不能被包成网络错）。
 */
public open class PiException <: Exception {
    public init(message: String) {
        super(message)
    }
}
