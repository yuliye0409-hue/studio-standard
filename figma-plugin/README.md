# Studio Layers · 原生图层导入
在 Figma 桌面端打开可编辑的 Design 文件，选择 Plugins → Development → Import plugin from manifest，选择本目录 manifest.json。运行插件，选择导入包中的 figma-import.json，再点击创建原生图层。

插件兼容 studio-reconstruction/1 和旧 studio-standard/2。创建新画板，不修改现有设计；失败移除本次创建的画板。文字为 Text，矩形/椭圆为原生形状，复杂画面为图片填充。原图对照层隐藏且锁定，清底图片层锁定，可自行解锁。长图切片保持原像素坐标，每片≤4096px，画板尺寸不缩小。

没有启用项时只有图片层，内部内容不可编辑。照片内部不自动矢量化，不能恢复原始设计图层、被遮挡背景或精确字体。字体缺失时会替换并提示，请在 Figma 再次核对原文、换行、基线、清底与所有图层。

插件完全离线，不发送图片和密钥；输出并非 .fig 文件。工作台验证使用模拟插件宿主，真实编辑器仍需人工视觉验收。
