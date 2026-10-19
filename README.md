# Terminal · Aide 命令提案与目录工具

Aide `terminal` 插件的独立分发仓库，版本 **1.0.0**，MIT 许可。原始源码来自 [Aide f795a240](https://github.com/skyelan1999/aide/tree/f795a240cdb37e9b92a37d91664bd1bb3053b809/plugins/terminal)。

## 实际能力

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `terminal-run` | `command` | 返回命令提案，等待用户在 Aide 中审阅和手动运行；插件不自动执行 shell |
| `terminal-history` | `path`，默认 `.` | 只读列出当前绑定工作区内的目录内容，子目录名称带 `/` |

两个工具都有 handler。`terminal-history` 名称沿用原插件，它列举的是目录，不是历史命令。插件不提供交互式终端、PTY、终端会话或命令历史存储。`terminal-panel` 只是槽位声明，Aide v1 宿主不渲染通用 UI 槽位。

例如，在已配置可用模型的 Aide 中，可要求使用 `terminal-run` 准备一条命令，或用 `terminal-history` 查看当前目录；产生提案不等于命令已运行。目录访问通过宿主的工作区 API，拒绝 `..` 越界和指向工作区外的符号链接。

## 安装

需要支持插件导入的 Aide，市场兼容基线为 `0.1.17.0 RC2`，以及宿主 Node.js 插件运行环境。没有 npm 依赖。

从 [Release](https://github.com/skyelan1999/aide-pkg-terminal/releases/tag/v1.0.0) 说明中的固定提交链接下载 `aide-pkg-terminal-v1.0.0.zip` 和 `SHA256SUMS`，核对摘要后通过 Aide 插件管理导入；也可在[官方插件市场](https://skyelan1999.github.io/aide-pkg-shop/)搜索 `terminal`。

```sh
sha256sum -c SHA256SUMS
```

安装 ZIP 与既有市场 1.0.0 包逐字节一致，根目录包含 `index.js`、`manifest.json`、`LICENSE`。已有同 ID、同版本的插件无需重复安装。

## 分发与验证

安装 ZIP 与摘要由仓库 `packages/v1.0.0/` 目录托管；Release 说明提供固定提交链接，不额外上传附件。市场分发相同字节的包。

发布验证包含 Node 语法、ZIP 完整性和摘要、实际安装包的宿主入口与 surface，以及通过真实宿主调用验证命令只生成提案、目录列举、目录穿越与外部符号链接拒绝。没有调用付费模型或实际运行提案命令。

插件通过可信 Node 宿主运行，插件机制不是权限沙箱。SHA-256 用于完整性校验，不是发布者签名。
