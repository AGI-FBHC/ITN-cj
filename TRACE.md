# 本地恢复与开发交接记录

## 2026-10-20（Asia/Shanghai）下载并预览28801线上旧前端

### 用户目标与范围
- 用户要求定位 http://113.249.110.108:28801/ 在服务器43.160.236.121上的位置，随后要求把源码拉到本地并部署，确认页面后准备开发。
- 此页面与此前7月31日紫色React历史版本、newfront_khea6压缩包不能视为同一套。用户已明确改为以28801线上页面为当前目标。
- 服务器只读访问；不修改线上文件、服务、数据库或防火墙。SSH凭据不写入项目。

### 下载证据
- Nginx配置：/etc/nginx/sites-available/zhixun-yunshu-28801，sites-enabled内是它的软链接；宿主机Nginx监听28801，无需前端容器。
- 网站root：/var/www/zhixun-yunshu/current，软链接目标为 /var/www/zhixun-yunshu/releases/20260803-112502。
- SFTP下载了该发布目录的全部8个文件，共2,552,751字节，保存至本目录deployed；另下载Nginx配置，生成SHA256SUMS.txt。
- 入口HTML外网/远程磁盘/本地哈希：2aad0e7b28010754279746d5be5cd76337e62b5a1b2a13d545b242927b08888a。
- 主JS assets/index-Dla-aRwf.js 外网/远程磁盘/本地哈希：84a5a915c003d50509415a59179ede4e8c7f8a2211beb84549a2002f3016feaf。

### 源码查找与限制
- 发布目录只有index.html、JS、CSS和5张courses图片，无src、package.json或source map。
- 检查服务器/home/ubuntu、/root、/opt、/srv、/tmp、/var/www、/www/wwwroot、/data中的项目与压缩包候选，排除了依赖/缓存/编辑器目录；尚未找到对应原始React工程。
- /tmp/itn-front只剩node_modules。ds-platform及其cloud_src是DataSphere Vue工程，与目标不符。
- 检查本机front_6BhE2.tar.gz与front_JtdhW.tar.gz，均为其他版本，构建入口脚本与线上index-Dla-aRwf.js不同，不能冒充目标源码。
- 已告知用户：当前可原样预览的是构建产物；继续开发需要找回源码，或明确开展源码重建。

### 本地启动
- 新增preview_server.py，使用Python标准库HTTP服务，只监听127.0.0.1:3005；/courses及单页路由回退到index.html，已存在的静态文件直接提供。
- 启动命令：python preview_server.py --port 3005。
- 本地初始化独立Git仓库并保存恢复基线，以便后续回滚；不向远端推送，不改现有ITN工作区。
- 运行与浏览器验证结果继续追加本文件。

### 已完成验证
- 运行进程exec session_id=65755，绑定127.0.0.1:3005；服务启动输出Preview: http://localhost:3005/。
- 对SHA256SUMS.txt逐项校验，8个下载文件全部一致。
- GET /、/courses、/courses/、主JS与课程图片均HTTP 200，HTML/JS/PNG响应类型正确。
- 浏览器真实加载首页，标题“智训云枢”，显示“计算机核心课程，从难懂到真正掌握”。点击“开始学习”可显示身份选择弹窗。
- 用户随后在浏览器继续操作，页面已进入“个人档案”，显示角色、学习统计、继续学习、推荐课程与最近记录。本次保留用户当前页面，不再强制跳转。
- 本次只验证静态加载和入口交互，没有确认演示数据与真实业务后端的关联；未修改下载的HTML/JS/CSS。
