# Studio Standard v0.2

本地优先的设计规范与电商排版工作台。网站外观采用用户提供的 Apple-design-analysis，完整原文见 UI-DESIGN.md。项目出图风格来自项目自己的 DESIGN.md，不强制套用 Apple 风格。

## 启动

需要 Node.js 22+、pnpm，以及 Chrome / Edge（用于网页捕获）。

```powershell
npx --yes pnpm@11.25.0 install
node server.mjs
```

打开 http://127.0.0.1:4174 。可用 STUDIO_PORT 更换端口。此版本仅监听本机，不应直接暴露到公网。

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

- 多张参考图、PDF 逐页渲染、隔离浏览器捕获网页。
- 真实像素色盘、边缘背景、内容密度与重心测量；本地中英文 OCR。
- 可配置视觉模型，支持 Responses 和 Chat Completions 图片输入；未配置时不会伪装成深度分析。
- 带来源与推测标记的 MD 生成、导入、编辑、导出、确认和最近 10 次确认版本。
- 每张原图独立匹配标题/正文/补充信息，三种排版，四种尺寸预设及自定义尺寸。
- 使用同一份图层数据绘制真实 PNG/JPG、原生 Figma 图层数据，完整 ZIP 交付。
- IndexedDB 项目保存、多项目切换、JSON 备份恢复、源图片 SHA-256 核对。
- Figma 桌面端开发插件：创建 Frame、可编辑 Text、独立图片 Rectangle。源照片仍然是照片，不会被伪称为全部可编辑矢量。

## 视觉模型（可选，但推荐用于理解风格）

在界面「模型设置」填写准确接口、模型和密钥；也可复制 .env.example 为 .env 自行配置。网页填写的密钥只留在服务进程内存，不进 IndexedDB、项目导出或日志。发送参考图前有确认；会产生服务商费用。重启服务后需重新填写网页配置。

本地测量/OCR 不需要密钥，也不上传参考图到第三方。仅靠测量不能识别复杂设计意图、准确字体或完整还原截图图层。模型输出也须人工确认。无密钥时不要把本地测量当作专业设计师视觉评审。

## 参数支持边界

排版执行颜色 canvas/ink；标题 display 或 hero-display；body 的字体、字号、字重、行高、字距；layout 的 mode、align、padding、gap、imageFraction、baseWidth。颜色支持 {colors.token} 引用。规范的其他组件、动效、品牌语气与正文作为可读规范保留，不会自动编译任意 CSS/任意布局。

三种布局是可验证的初版排版引擎，不是无限制生成任意海报的通用设计智能体。每张素材对应一个画板；不自动抠图，不将原图内的文字拆成可编辑文字。复杂拼贴、曲线文字和图像内局部编辑不在此版本范围。

## 检查

```powershell
node --test tests/core.test.mjs tests/figma.test.mjs
node tests/e2e.mjs
```

端到端测试会使用独立 4184 端口、临时项目与合成测试素材，不占用用户项目。实际模型和真实 Figma 宿主联调仍需要用户自己的接口/桌面环境；接口夹具和插件 API 模拟不能替代此项验收。

完整操作和验收说明见 SOP.md。不要提交 .env、.data 或用户项目备份到公开仓库。manifest 中的 0000000000000000000 是占位 ID；按 Figma 官方开发插件流程创建本地插件后，替换成 Figma 分配的数字 ID。
