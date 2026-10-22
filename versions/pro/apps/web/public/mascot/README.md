# 小鼋龙桌宠资产 v1

江南大学吉祥物“小鼋龙”的网页桌宠动作资产。全部 PNG 为 362×362、透明背景，
角色尺寸和视角统一。

| 状态 | 文件 | 后续 Agent 含义 |
| --- | --- | --- |
| idle | `xiaoyuanlong-idle.png` | 空闲待命 |
| breathe | `xiaoyuanlong-breathe.png` | 待机呼吸 |
| blink | `xiaoyuanlong-blink.png` | 待机眨眼 |
| wake | `xiaoyuanlong-wake.png` | 被点击或语音唤醒 |
| listen-1/2 | `xiaoyuanlong-listen-*.png` | 接收文字或语音 |
| think-1/2 | `xiaoyuanlong-think-*.png` | LLM 推理与意图识别 |
| speak-1/2 | `xiaoyuanlong-speak-*.png` | 流式文字或语音回答 |
| working | `xiaoyuanlong-working.png` | 执行网页操作或生成任务 |
| success | `xiaoyuanlong-success.png` | 操作完成 |

`xiaoyuanlong-sprite-v1.png` 是 4×3 总表，按上述顺序从左到右、从上到下排列。
部分姿态会越过固定网格边界，不能直接按 362×362 硬切。修改总表后应运行：

```bash
python scripts/extract_mascot_frames.py
```

脚本按透明像素连通区域提取每个完整角色，再缩放、居中到带安全留白的
362×362 画布，防止相邻格残片出现在画面右侧或底部。

## 角色不变量

- 天蓝色圆头与身体、浅青色口鼻和腹部
- 两只浅黄色短角、蓝色鳍状额发
- 金色旋纹眉、深蓝大眼与黄色高光
- 粉色腮红、短圆四肢、浅黄色卷尾
- 深蓝粗轮廓和扁平二维校园吉祥物风格

生成方式：内置图像生成工具参考用户提供的三张小鼋龙图片生成绿色键控动作总表，
再使用 imagegen 技能的 `remove_chroma_key.py` 转换为透明 PNG，并按 4×3 网格切帧。
