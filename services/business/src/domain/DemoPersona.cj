package web.domain

public class DemoPersona {
    public let email: String
    public let name: String
    public let avatar: String
    public let role: String
    public let education: String
    public let targetJob: String
    public let weeklyHours: Int64
    public let learningStyles: String
    public let scores: String
    public let goal: String
    public let blindSpots: String
    public let diagnosis: String
    public init(email: String, name: String, avatar: String, role: String, education: String, targetJob: String, weeklyHours: Int64, learningStyles: String, scores: String, goal: String, blindSpots: String, diagnosis: String) {
        this.email = email
        this.name = name
        this.avatar = avatar
        this.role = role
        this.education = education
        this.targetJob = targetJob
        this.weeklyHours = weeklyHours
        this.learningStyles = learningStyles
        this.scores = scores
        this.goal = goal
        this.blindSpots = blindSpots
        this.diagnosis = diagnosis
    }
    public static func select(persona: String): DemoPersona {
        match (persona) {
            case "beginner" => return beginner()
            case "practitioner" | "advanced" => return practitioner()
            case _ => return research()
        }
    }
    private static func beginner(): DemoPersona {
        return DemoPersona(
            "guest-beginner@itn.local",
            "小明",
            "/avatar-lin.png",
            "本科 · 在校学生",
            "本科",
            "Agent工程师",
            6,
            "[\"图示学习\",\"步骤清单\",\"案例迁移\",\"实操驱动\"]",
            "{\"kp-ds\":42,\"kp-co\":38,\"kp-os\":35,\"kp-network\":32,\"kp-db\":36,\"kp-agent\":18}",
            "先建立 Agent 基础认知，能够理解核心概念并完成简单的工具调用应用。",
            "[\"Agent核心概念\",\"工具调用\",\"记忆机制\"]",
            "具备基础编程认知，但尚未系统学习 Agent。适合从术语解释、生活化类比和分步实操开始。"
        )
    }
    private static func research(): DemoPersona {
        return DemoPersona(
            "guest@itn.local",
            "小智",
            "/avatar-chen.png",
            "硕士 · 在校学生",
            "硕士",
            "多智能体开发工程师",
            10,
            "[\"理论先行\",\"碎片化学习\",\"视频演示\",\"项目实战\"]",
            "{\"kp-ds\":54,\"kp-co\":28,\"kp-os\":45,\"kp-network\":25,\"kp-db\":74,\"kp-agent\":69}",
            "3 个月内补齐问题诊断与逻辑推理短板，对齐多智能体开发工程师岗位能力。",
            "[\"问题诊断\",\"逻辑推理\"]",
            "理论基础和系统设计能力较好，Agent 基础较强；当前重点是强化复杂流程推理、故障诊断与证据分析。"
        )
    }
    private static func practitioner(): DemoPersona {
        return DemoPersona(
            "guest-practitioner@itn.local",
            "小李",
            "/avatar-zhao.png",
            "中级工程师（3-5年） · 后端开发",
            "本科",
            "RAG应用工程师",
            8,
            "[\"实操驱动\",\"项目实战\",\"案例迁移\",\"步骤清单\"]",
            "{\"kp-ds\":61,\"kp-co\":56,\"kp-os\":68,\"kp-network\":72,\"kp-db\":76,\"kp-agent\":46}",
            "形成完整的 RAG 与 Agent 工程方法，能够独立完成检索、评估、部署和故障排查。",
            "[\"RAG评估体系\",\"多智能体协作\",\"模型效果诊断\"]",
            "具有后端开发与简单 RAG 应用经验，工程基础扎实；需要补齐评估方法、多智能体协作和系统化理论。"
        )
    }
}
