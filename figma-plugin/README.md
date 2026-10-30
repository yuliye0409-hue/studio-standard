# Studio Standard Figma 原生图层导入

1. 解压插件包到固定目录，不要删除其中的文件。
2. 打开 Figma 桌面版，进入任一可编辑的 Design 文件。
3. 菜单 → Plugins → Development → Import plugin from manifest，选择本目录 manifest.json。
4. 如果 Figma 要求重新生成开发插件 ID，先创建一个本地插件，再使用其 ID 替换 manifest.json 的 id；代码与数据格式不变。
5. 运行 Studio Standard，选择网站导出的 figma-import.json，再点击「创建原生图层」。
6. 检查字体替换和文字高度差异提示。必要时安装网站报告的字体，再重新导入。

矩形、文字、商品图片会成为独立节点；不会用一张截图冒充可编辑稿。插件不覆盖原有图层；失败会移除本次新建画板。

图片为原素材转换的 PNG 图层，最大 4096px（超出时仅等比例缩小供 Figma 使用）；原图二进制及校验值仍保存在完整交付包。照片内部不会自动变为矢量对象。

本插件不使用网络。浏览器 Canvas 与 Figma 的文本排版引擎不同，即使字体相同也需要检查换行、基线和高度。文字保持完整，绝不为匹配截图而静默裁切。
