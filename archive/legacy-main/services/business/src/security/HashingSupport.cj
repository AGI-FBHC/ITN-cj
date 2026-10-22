package web.security
import stdx.crypto.digest.SHA256
import stdx.encoding.hex.toHexString
public class HashingSupport {
    private init() {}
    public static func sha256(value: String): String {
        let hash = SHA256()
        hash.write(value.toArray())
        return toHexString(hash.finish())
    }
}
