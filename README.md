# Studio Standard v0.3

本地优先的设计规范与电商排版工作台。网站外观采用用户提供的 Apple-design-analysis，完整原文见 UI-DESIGN.md。项目出图风格来自项目自己的 DESIGN.md，不强制套用 Apple 风格。

## 启动

需要 Node.js 22+、pnpm。网站仅分析图片；网页与 PDF 请截图后上传。

```powershell
npx --yes pnpm@11.25.0 install
node server.mjs
```

打开 http://127.0.0.1:4174 。可用 STUDIO_PORT 更换端口。此版本仅监听本机，不应直接暴露到公网。

## 公开部署（Render）

GitHub Pages 只能托管静态文件，不能运行本项目的 Node API。仓库已提供 Dockerfile 与 render.yaml，可在 Render 中连接本仓库并部署；Render 会从 GitHub 自动构建并在成功后提供 HTTPS 地址。部署前核对后台实例方案，当前 render.yaml 的 starter 为付费方案；试运行请在后台明确选择 Free。网页捕获入口与 API 已移除。

部署前必须设置 `STUDIO_VISION_KEY` 等服务端环境变量，不要把密钥写进仓库。公开部署前还应增加登录/访问控制、限流和云端项目存储；当前项目数据仍保存在每个用户自己的浏览器 IndexedDB，公开网址不会自动共享项目。

这样不需要全局安装 pnpm，也不需要管理员权限执行 `corepack enable`。如果你已经安装了 pnpm，直接运行 `pnpm install` 也可以。

当前机器若没有 Node.js，可先安装 Node.js 22+；不能只下载 GitHub 网页文件运行。

当前机器若已有项目目录，更新源码：

```powershell
git pull
npx --yes pnpm@11.25.0 install
node server.mjs
```

旧环境的备用运行时命令：

```powershell
& 'C:\Users\19708\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' install
node server.mjs
```

## 已实现

- 上传 PNG/JPG/WebP 参考图片，一套最多 20 张；网页或 PDF 需自行截图。
- 真实像素色盘、边缘背景、内容密度与重心测量，提供核对模型结果的测量证据；不使用 OCR 识字或推断版面。
- 必须配置视觉模型才能分析参考设计，支持 Responses 和 Chat Completions 图片输入；模型失败时明确报错，不生成本地替代分析。
- 带来源与推测标记的 MD 生成、导入、编辑、导出、确认和最近 10 次确认版本。
- 结构化版面证据图：模型推断的图文/商品区域带坐标、来源和置信度，可在界面人工校正角色；不复制图中文字。
- 可上传品牌 Logo 与 TTF/OTF/WOFF/WOFF2 字体；Logo 进入独立图层，品牌字体优先驱动浏览器排版并写入交付包。
- 每张原图独立匹配标题/正文/补充信息，三种排版，四种尺寸预设及自定义尺寸。
- STEP 3 通过独立图文卡片添加、替换、排序和删除，最多 20 张；图文绑定同一素材 ID。全部预览逐张确认后才能导出，修改后需重新生成并确认。
- 使用同一份图层数据绘制真实 PNG/JPG、原生 Figma 图层数据，完整 ZIP 交付。
- IndexedDB 项目保存、多项目切换、JSON 备份恢复、源图片 SHA-256 核对。
- Figma 桌面端开发插件：创建 Frame、可编辑 Text、独立图片 Rectangle。源照片仍然是照片，不会被伪称为全部可编辑矢量。

## 视觉模型（参考设计分析必需）

在界面「模型设置」填写准确接口、模型和密钥；也可复制 .env.example 为 .env 自行配置。网页填写的密钥只留在服务进程内存，不进 IndexedDB、项目导出或日志。发送参考图前有确认；会产生服务商费用。重启服务后需重新填写网页配置。

像素测量无需密钥，仅用于提供颜色、尺寸和内容分布证据；它不读取图片文字、不推断模块，也不会单独生成 DESIGN.md。长图会连同总览和局部切片发给视觉模型。模型输出仍须人工核对，复杂视觉还原和字体识别不能保证完全准确。

## 参数支持边界

排版执行颜色 canvas/ink；标题 display 或 hero-display；body 的字体、字号、字重、行高、字距；layout 的 mode、align、padding、gap、imageFraction、baseWidth。颜色支持 {colors.token} 引用。规范的其他组件、动效、品牌语气与正文作为可读规范保留，不会自动编译任意 CSS/任意布局。

三种布局是可验证的初版排版引擎，不是无限制生成任意海报的通用设计智能体。每张素材对应一个画板；不自动抠图，不将原图内的文字拆成可编辑文字。复杂拼贴、曲线文字和图像内局部编辑不在此版本范围。

## 检查

```powershell
node --test tests/core.test.mjs tests/figma.test.mjs
node tests/e2e.mjs
```

端到端测试会使用独立 4184 端口、临时项目与合成测试素材，不占用用户项目。实际模型和真实 Figma 宿主联调仍需要用户自己的接口/桌面环境；接口夹具和插件 API 模拟不能替代此项验收。

完整操作和验收说明见 SOP.md。不要提交 .env、.data 或用户项目备份到公开仓库。manifest 中的 0000000000000000000 是占位 ID；按 Figma 官方开发插件流程创建本地插件后，替换成 Figma 分配的数字 ID。v0.3 仍不能从栅格图保证恢复原始字体/图层，证据必须人工确认。
