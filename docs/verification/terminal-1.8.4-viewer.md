# Terminal 1.8.4 图形窗口验收

验收在隔离 Docker 环境使用 ROS 2 Humble 的 rosbag 回放与 RViz。两轮均使用 `packages/v1.8.4/aide-pkg-terminal-v1.8.4.zip`，归档 1,307,658 bytes，SHA-256 `b4bf3211e9df35ad907e1a16179a2cc86093e365f9bf28424a057407b42e085a`。

- 旧版 Aide 通过标准 ZIP 从 Terminal 1.8.3 升级到 1.8.4。点击图形窗口后，真实 RViz 画面与终端并排出现。图形画面可见时，终端继续接收并执行输入。
- 支持独立窗口的 Aide 中，点击图形窗口创建独立浏览器窗口。其 noVNC 画面显示同一隔离测试环境的真实 RViz。窗口打开期间和关闭后，原终端均可正常输入。
- 两种 Aide 验收的浏览器脚本错误均为零。
- Chromium 测试覆盖旧宿主、可用的弹窗与弹窗被拦截三种响应。测试包含实际 noVNC 和合成 RFB 帧，检查桌面并排与窄屏上下布局、终端输入、切换终端标签以及剪贴板手动复制。
- 从 Linux ARM64 归档提取运行时及打包依赖后的套件 74/74 通过。市场最低 Aide 版本保持 `0.1.18.0 RC3`。

[Aide #950](https://github.com/skyelan1999/aide/issues/950)
