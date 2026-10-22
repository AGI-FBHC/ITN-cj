package web.exception
public class BusinessException <: Exception {
    public let code: Int32
    public let status: Int32
    public init(code: Int32, status: Int32, message: String) {
        super(message)
        this.code = code
        this.status = status
    }
    public override func getClassName(): String {
        return "BusinessException"
    }
}
