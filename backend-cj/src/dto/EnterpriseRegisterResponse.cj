package web.dto

public class EnterpriseRegisterResponse {
    public let login: LoginResponse
    public let employeeNo: String
    public let organizationName: String
    public init(login: LoginResponse, employeeNo: String, organizationName: String) {
        this.login = login
        this.employeeNo = employeeNo
        this.organizationName = organizationName
    }
}
