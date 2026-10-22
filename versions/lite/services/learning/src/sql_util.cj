package zhixun_learning

import std.collection.*
import std.core.*

public func sqlQuote(value: String): String {
    let bytes = value.toArray()
    let out = ArrayList<Byte>()
    out.add(39)
    for (b in bytes) {
        let n = Int64(b)
        if (n == 92 || n == 39 || n == 34) {
            out.add(92)
            out.add(b)
        } else if (n == 10) {
            out.add(92)
            out.add(110)
        } else if (n == 13) {
            out.add(92)
            out.add(114)
        } else if (n == 0) {
            out.add(92)
            out.add(48)
        } else if (n == 26) {
            out.add(92)
            out.add(90)
        } else {
            out.add(b)
        }
    }
    out.add(39)
    String.fromUtf8(out.toArray())
}
