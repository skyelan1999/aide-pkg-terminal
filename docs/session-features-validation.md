# Terminal 1.6.0 发行验证记录

发行状态以 GitHub Release 为准；归档准备、PR通过和本文件均不等同于已发布。配套 Aide 最低版本 **0.1.18.0 RC2**，无 sourceCompatibility 降低门槛；可供市场引用的元数据在 [release/market-compatibility.json](../release/market-compatibility.json)。

## 阶段二：正式归档与真实 X Server 验证

正式归档 `packages/v1.6.0/aide-pkg-terminal-v1.6.0.zip`：
- **1,071,482 bytes**
- SHA256 **`c682f56ff469212b8da7f5e4e9e25052d5d8248c3f298345611558578c2b149b`**
- ZIP CRC、167成员与关键运行文件同源码逐字节检查通过；历史1.5.3归档不变。准备命令 `python3 scripts/package.py --release` 不发布且拒绝替换不同的版本归档。

| 验证 | 实测结果 | 范围 |
| --- | --- | --- |
| 源码回归 | PASS56/56，0skip，13.974s | 普通UID1000、隔离LinuxARM64，非root运行；最终README中性状态调整未变产品JS，不重复跑此项 |
| 正式归档解包回归 | PASS53/53，0skip，14.398s | 仅加载该正式ZIP解包运行时及捆绑production dependencies |
| 正式归档真实X11窗口 | PASS2/2，0skip，1.675s | 真实Xvfb、真实xauth、真实OpenSSH客户端和服务端、实际xmessage；直连与TLS relay复制会话在关闭源连接后显示窗口 |
| 浏览器 | PASS | 同字节最终生成HTML，1440/390px × light/dark，真实Sessions与loopback Telnet；复制/连接/关闭隔离、输入、前提表单，零pageerror |
| 原始ZIP App/daemon安装与RC2兼容 | 主程序发行门禁单独记录 | 应直接multipart上传该SHA原档，不用重封装夹具代替原档身份；配套Aide PR731/RC2发行账本为准 |
| macOS XQuartz、用户设备、硬件/原生Windows | NOT_RUN | Linux虚拟X Server真实渲染不等同于上述真机环境 |
| 主程序发行runtime镜像 | 独立门禁 | 插件QA镜像不替代Aide RC2正式runtime的xauth/双架构验收 |

真实窗口证据：
- [直连PNG](images/x11-direct.png)、[中继副本PNG](images/x11-relay.png)。
- 窗口树真实标题 `AIDE-REAL-X11-direct` / `AIDE-REAL-X11-relay`，实际屏幕800×600；不是绘制的UI样稿或合成X11应答。
- 客户端UID1000；原认证文件权限0400、内容和inode保持不变；Xvfb只监听Unix socket并启用cookie认证；sshd只监听容器loopback、public-key认证、StrictModes保持开启。未使用xhost+。
- 新CI `x11-render` 从正式ZIP解包执行相同真实窗口断言，输出PNG、xwd、window-tree和JSON artifact。普通runtime AMD64/ARM64与浏览器CI仍保留。
- 本地QA镜像 `sha256:6eb1ce0dbcce99809e00488f16b783c4dda4bb6224b7ddd65578543052377534`。Debian依赖通过官方签名InRelease与包校验，以TLS下载；未改宿主DNS/代理/授权，未安装XQuartz，未重启生产。
- 初次真实sshd夹具把authorized_keys放在/tmp而被StrictModes拒绝，随后改为设备用户home/.ssh并保留StrictModes；失败历史日志保留，不掩盖为首轮通过。

本地日志：`.agent-state/evidence/release-source-tests.log`、`release-extracted-runtime-x11-final.log`、`release-browser.log`、`real-x11-final/{direct,relay}-window-tree.txt`、`{direct,relay}-report.json`。用户认证cookie/私钥不进入这些证据或Git。所有一次性测试容器结束后移除。

中间d3a549准备归档因README状态文字中性化而作废，未提交/发布，移存在被忽略的 `.agent-state/evidence/pre-final-readme-archive/`，不覆盖已发行1.5.3。

## 阶段一：历史候选验证

下方记录保留先前5139e8候选的身份与测试事实，不把它冒充当前c682f5正式归档。

配套审阅：[Terminal PR #3](https://github.com/skyelan1999/aide-pkg-terminal/pull/3)、[Aide宿主 PR #731](https://github.com/skyelan1999/aide/pull/731)。

范围：未发布功能分支；旧公开1.5.3包、市场和已发布Aide附件未修改。关联 Aide #726/#728/#730。

| 验证 | 结果 | 证据与边界 |
| --- | --- | --- |
| 源码 Node 测试 | PASS 56/56，0 skip，14.113s | Linux ARM64、Node24、真实 PTY/OpenSSH/loopback、虚拟串口；不等于原生 Windows/macOS 设备验收 |
| 实际候选 ZIP 解包测试 | PASS 53/53，0 skip，14.246s | 测试仅 require 解包运行时和其捆绑 production dependencies；另3项前端调度测试需要源码，已在源套件执行 |
| 浏览器 UI | PASS | 实际生成HTML +真实Sessions +loopback Telnet；1440/390px、light/dark各一组，输入/复制并连接/关闭隔离/只复制设置/独立SSH X11前提表单 |
| 长粘贴边界 | PASS direct + TLS relay | 同一段16383字节前缀+CRLF，整段与在CR/LF中间分两次输入，真实服务端收到逐字节一致且仅一个换行 |
| X11 通路 | PASS direct + TLS relay | 真实OpenSSH、合成xauth helper、合成X11 endpoint；包含SSH副本独立、主机校验与认证帧。三者不能代替真实XServer |
| 宿主原始ZIP安装 | PASS 1/1，Go race 3.060s | multipart直接io.Copy原始候选文件，不重构ZIP；日志记录1,071,285bytes及5139e8...SHA，断言PTY复制、隐藏权限、Telnet真实连接与动态禁用发送 |
| 宿主既有安装回归 | PASS 1/1 | 既有夹具将ZIP成员内容重新封装上传，验证原有工具和可见性兼容；不将它当作原档字节身份验收 |
| 宿主 focused Go race | PASS 8/8，0 skip，11.308s | 包含上述安装2项和规范context/主socket等6项；go vet ./internal/server PASS |
| 静态/生成物 | PASS | JS语法、git diff --check、重建workbench一致、候选ZIP结构与依赖自检 |
| 真实 X Server 窗口、用户 Telnet 设备、硬件/原生Windows | NOT_RUN | 本机无XQuartz/native XServer，不安装/改权限冒充验证 |
| 新宿主 runtime 镜像 | NOT_RUN | Dockerfile增加xauth，但未重建或部署；旧SDK上的合成helper不证明新镜像包含依赖 |

候选文件 `dist/aide-pkg-terminal-v1.6.0-candidate.zip`（本地候选，不是公开Release附件）：
- 1,071,285 bytes
- SHA256 `5139e8ac8153bdceb4e65a5a2b14fc416edd9ab90793f96c3f13f7531f49669f`
- 测试 SDK `sha256:cbdab7d49e30518d58f6c61adc3b73d3be3d314e8d0ec2c283dbd4facb92b8ee`，隔离容器network=none；loopback测试仅容器内。pyserial3.5仅装入测试临时目录，宿主未全局安装依赖。
- 浏览器桥上下文与保存的工作区profile是夹具；真实宿主安装另外验证。剪贴板是合成ClipboardEvent，不操作系统剪贴板。

本地证据保存在工作树被忽略的 `.agent-state/evidence/final-source-tests.log`、`final-extracted-runtime.log`、`final-browser.log` 与 `.agent-state/session-feature-browser/report.json`/PNG。配套宿主 `.agent-state/host-final-regression.log` 与原档 `.agent-state/host-original-zip-regression.log` 均末尾 EXIT0；OPERATION_FAILED记录来自预期隐藏权限/禁用输入负向断言。旧失败证据保留，不用新PASS覆盖其事实：#730修复前真实ControlPath过长、早期合成X11 helper夹具格式问题、旧浏览器输入夹具问题均不作为最终通过记录。

CI将继续在LinuxAMD64/ARM64运行源与解包套件，在Chromium运行UI；远端结果必须另看PR状态。以上本地通过不等于远端CI通过或发布授权。
