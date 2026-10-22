# 图片上传服务使用指南

## 服务信息

| 项目 | 地址 |
|------|------|
| 上传接口 | `http://113.249.110.108:28902` |
| 公开访问 | `http://113.249.110.108:28901` |
| 源码目录 | `/home/jnuaipr/Data/Images-code` |
| 使用文档 | `/home/jnuaipr/Data/Images-code/README.md` |

## Token

```
<IMAGE_UPLOAD_TOKEN>
```

保存位置：`/home/jnuaipr/Data/Images-code/.env`

## 功能特性

- ✅ 单文件上传：`POST /api/assets/images`
- ✅ 批量上传：`POST /api/assets/images/batch`
- ✅ 指定 `directory` 自动创建目录
- ✅ 保留原文件名
- ✅ 重名文件禁止覆盖，返回 409 错误
- ✅ 100MB 单文件限制
- ✅ 不限制文件类型
- ✅ Token Bearer 鉴权

## 使用示例

### 单文件上传

```bash
curl -X POST \
  "http://113.249.110.108:28902/api/assets/images" \
  -H "Authorization: Bearer <IMAGE_UPLOAD_TOKEN>" \
  -F "directory=knowledge/hello-agents/chapter-01" \
  -F "file=@./1757242319667-0.png"
```

### 批量上传

```bash
curl -X POST \
  "http://113.249.110.108:28902/api/assets/images/batch" \
  -H "Authorization: Bearer <IMAGE_UPLOAD_TOKEN>" \
  -F "directory=knowledge/hello-agents/chapter-01" \
  -F "files=@./1.png" \
  -F "files=@./2.png" \
  -F "files=@./3.png"
```

## 返回格式

### 单文件上传返回

```json
{
  "code": 0,
  "data": {
    "success": true,
    "filename": "test-image.png",
    "path": "knowledge/test/images/test-image.png",
    "url": "http://113.249.110.108:28901/knowledge/test/images/test-image.png",
    "size": 70,
    "error": null
  }
}
```

### 批量上传返回

```json
{
  "code": 0,
  "data": [
    {
      "success": true,
      "filename": "1.png",
      "path": "knowledge/test/1.png",
      "url": "http://113.249.110.108:28901/knowledge/test/1.png",
      "size": 1024,
      "error": null
    }
  ]
}
```

### 重名文件返回 (409)

```json
{
  "detail": "File already exists: test-image.png in directory 'knowledge/test/images'. Delete it first or rename."
}
```

## 文件访问

上传成功后，通过公开访问地址 + 文件路径访问：

```
http://113.249.110.108:28901/{path}
```

示例：`http://113.249.110.108:28901/knowledge/test/images/test-image.png`

## 测试记录

测试日期：2026-07-28

| 测试项 | 结果 | 状态码 |
|--------|------|--------|
| 单文件上传 | ✅ 成功 | 200 |
| 批量上传 | ✅ 成功 | 200 |
| 文件访问 | ✅ 可访问 | - |
| 重名拒绝 | ✅ 正确拒绝 | 409 |
