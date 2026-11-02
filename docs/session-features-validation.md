# Terminal 1.6.0 候选验证记录

范围：未发布功能分支；旧公开1.5.3包、市场和已发布Aide附件未修改。关联 Aide #726/#728/#730。

| 验证 | 结果 | 证据与边界 |
| --- | --- | --- |
| 源码 Node 测试 | PASS 56/56，0 skip，14.113s | Linux ARM64、Node24、真实 PTY/OpenSSH/loopback、虚拟串口；不等于原生 Windows/macOS 设备验收 |
| 实际候选 ZIP 解包测试 | PASS 53/53，0 skip，14.246s | 测试仅 require 解包运行时和其捆绑 production dependencies；另3项前端调度测试需要源码，已在源套件执行 |
| 浏览器 UI | PASS | 实际生成HTML +真实Sessions +loopback Telnet；1440/390px、light/dark各一组，输入/复制并连接/关闭隔离/只复制设置/独立SSH X11前提表单 |
| 长粘贴边界 | PASS direct + TLS relay | 同一段16383字节前缀+CRLF，整段与在CR/LF中间分两次输入，真实服务端收到逐字节一致且仅一个换行 |
| X11 通路 | PASS direct + TLS relay | 真实OpenSSH、合成xauth helper、合成X11 endpoint；包含SSH副本独立、主机校验与认证帧。三者不能代替真实XServer |
| 宿主实际安装 | PASS 2/2 | 配套Aide将本候选实际装入隔离App/Node daemon；PTY复制、可见性、Telnet真实连接及动态禁用发送、既有工具兼容 |
| 宿主 focused Go race | PASS 8/8，0 skip，11.463s | 包含上述安装2项和规范context/主socket等6项；go vet ./internal/server PASS |
| 静态/生成物 | PASS | JS语法、git diff --check、重建workbench一致、候选ZIP结构与依赖自检 |
| 真实 X Server 窗口、用户 Telnet 设备、硬件/原生Windows | NOT_RUN | 本机无XQuartz/native XServer，不安装/改权限冒充验证 |
| 新宿主 runtime 镜像 | NOT_RUN | Dockerfile增加xauth，但未重建或部署；旧SDK上的合成helper不证明新镜像包含依赖 |

候选文件 `dist/aide-pkg-terminal-v1.6.0-candidate.zip`（本地候选，不是公开Release附件）：
- 1,071,285 bytes
- SHA256 `5139e8ac8153bdceb4e65a5a2b14fc416edd9ab90793f96c3f13f7531f49669f`
- 测试 SDK `sha256:cbdab7d49e30518d58f6c61adc3b73d3be3d314e8d0ec2c283dbd4facb92b8ee`，隔离容器network=none；loopback测试仅容器内。pyserial3.5仅装入测试临时目录，宿主未全局安装依赖。
- 浏览器桥上下文与保存的工作区profile是夹具；真实宿主安装另外验证。剪贴板是合成ClipboardEvent，不操作系统剪贴板。

本地证据保存在工作树被忽略的 `.agent-state/evidence/final-source-tests.log`、`final-extracted-runtime.log`、`final-browser.log` 与 `.agent-state/session-feature-browser/report.json`/PNG。配套宿主 `.agent-state/host-final-regression.log` 末尾 EXIT0；OPERATION_FAILED记录来自预期隐藏权限/禁用输入负向断言。旧失败证据保留，不用新PASS覆盖其事实：#730修复前真实ControlPath过长、早期合成X11 helper夹具格式问题、旧浏览器输入夹具问题均不作为最终通过记录。

CI将继续在LinuxAMD64/ARM64运行源与解包套件，在Chromium运行UI；远端结果必须另看PR状态。以上本地通过不等于远端CI通过或发布授权。
