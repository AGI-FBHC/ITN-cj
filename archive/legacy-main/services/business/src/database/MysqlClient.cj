package web.database
foreign func mysql_get_client_info(): CString
public class MySqlClient {
    private init() {}
    public static func version(): String {
        unsafe {
            return mysql_get_client_info().toString()
        }
    }
}
