package sqlite_driver

import std.database.sql.ColumnInfo as StdColumnInfo

/** std.database.sql 列元数据。 */
public class SqliteColumnInfo <: StdColumnInfo {
    private let nameValue: String
    private let typeNameValue: String
    private let lengthValue: Int64
    private let scaleValue: Int64
    private let nullableValue: Bool
    private let displaySizeValue: Int64

    public prop name: String {
        get() {
            nameValue
        }
    }

    public prop typeName: String {
        get() {
            typeNameValue
        }
    }

    public prop length: Int64 {
        get() {
            lengthValue
        }
    }

    public prop scale: Int64 {
        get() {
            scaleValue
        }
    }

    public prop nullable: Bool {
        get() {
            nullableValue
        }
    }

    public prop displaySize: Int64 {
        get() {
            displaySizeValue
        }
    }

    public init(name: String, typeName: String, length: Int64, scale: Int64, nullable: Bool, displaySize: Int64) {
        this.nameValue = name
        this.typeNameValue = typeName
        this.lengthValue = length
        this.scaleValue = scale
        this.nullableValue = nullable
        this.displaySizeValue = displaySize
    }
}
