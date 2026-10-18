package web.dto
import std.time.DateTime
// HTTP JSON serialization must omit data when it is None,
// matching the legacy @JsonInclude(NON_NULL) behavior.
public class ApiResponse<T> {
    public let code: Int32
    public let message: String
    public let data: Option<T>
    public let timestamp: String
    public init(code: Int32, message: String, data: Option<T>, timestamp: String) {
        this.code = code
        this.message = message
        this.data = data
        this.timestamp = timestamp
    }
    public static func success(data: T): ApiResponse<T> {
        return ApiResponse<T>(0, "success", Some(data), DateTime.nowUTC().toString())
    }
    public static func success(message: String, data: T): ApiResponse<T> {
        return ApiResponse<T>(0, message, Some(data), DateTime.nowUTC().toString())
    }
    public static func successEmpty(message: String): ApiResponse<T> {
        return ApiResponse<T>(0, message, None, DateTime.nowUTC().toString())
    }
    public static func error(code: Int32, message: String): ApiResponse<T> {
        return ApiResponse<T>(code, message, None, DateTime.nowUTC().toString())
    }
}
