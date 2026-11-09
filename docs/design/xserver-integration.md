# 集成式 X Server 方案与第一阶段实现（issue #40）

状态：第一阶段已实现（受管 X display 生命周期）；窗口呈现与 seamless 多窗口未实现，按 NOT_RUN 记录。
更新时间：2026-11-09

## 1. 结论先行

| 问题 | 结论 |
| --- | --- |
| 是否在 Workbench iframe 内嵌 noVNC/Xpra viewer | **否**。AIDE 插件 Workbench iframe CSP 为 `connect-src 'none'`、`frame-src 'none'`，任何 viewer 都需要改宿主 CSP；issue 正文已禁止在无安全评审时改动。且纯 framebuffer noVNC 不能支撑 seamless 多窗口的宣称。 |
| 第一阶段做什么 | 插件在 Aide 运行环境内受管地拉起/回收 Xvfb display，生成每 display 唯一的 `MIT-MAGIC-COOKIE-1` Xauthority，供后续 SSH X11 转发或后续 viewer 使用。零宿主改动、零系统安装。 |
| 是否已宣称 seamless 多窗口 | **否**，也不在文档/UI 中暗示。 |
| 是否需要 aide 宿主改动 | 窗口呈现需要。按用户既定约束，宿主侧方案先出文档、经确认后再动。 |

## 2. 支持的 OS 组合（明确声明）

第一阶段（已实现，仅生命周期）：

- 运行环境：Linux（Xvfb ≥ 21 与 xauth 在 PATH 内）；Windows / macOS 运行环境**不支持**——无 Xvfb，`terminal_xserver_start` 会明确报错，不静默降级。
- 客户端：任意 Aide 桌面端。第一阶段**不产生窗口面**，因此客户端类型不影响能力。
- X11 转发消费方：`terminal_session_create` 的 SSH 会话（`x11Enabled`）。目前该路径仍要求用户提供可达 `x11Display` 与 workspace 内 `x11AuthorityFile`；受管 display 的 cookie 位于运行时私有目录（绝对路径），`prepareX11` 目前拒绝绝对路径，**接入属于第二阶段**。

后续阶段（未实现，需先裁决）：

- 窗口面形态：(A) 原生桌面窗口（需要 Aide 宿主新增窗口管理能力）；(B) 独立受控 viewer 进程 + 宿主 opener（浏览器内仍受 CSP 限制）；(C) 用户自带 Xpra/X2Go 客户端作为外部应用对接（插件只提供 display 与 cookie 分发）。
- 推荐路线：**C → A**。C 不改宿主、可先在受信网络内验证多窗口与剪贴板链路；A 在宿主安全评审通过后再做 seamless 集成。
- XDMCP：第一阶段及推荐路线均**不启用**。若后续引入，仅限受信内网 + 强制认证 + 连接审计，默认关闭。
- 硬件加速：仅当目标主机 `glxinfo` 验证通过且驱动受支持时启用；否则声明为软件渲染（Xvfb 默认无 GLX）。

## 3. 第一阶段实现内容

模块 `xserver.js`（`XServers`）：

- `start({display?, width?, height?, depth?})`：分配 `:90`–`:129` 空闲 display；在 0700 私有临时目录写 `Xauthority`（0600，cookie 32 hex，经 `xauth add` 写入）；以 `Xvfb -auth <file> -nolisten tcp -screen 0 WxHxDy :N` 启动。参数边界：宽 640–7680、高 480–4320、深 16/24；最多 4 个受管 display。
- 状态：`serverId / display / 尺寸 / 状态 / 启动时间 / pid`，**不返回 cookie 内容**。
- `stop(serverId?)`：SIGTERM（500ms 后 SIGKILL 兜底）、删除整个 cookie 目录、从注册表移除；`Sessions.stop()` 会 `stopAll()`。
- 失败清理：xauth 写入失败、spawn 抛错、进程启动即退出，均删除 cookie 目录，不残留凭据。

工具入口（`index.js`）：

- `terminal_xserver_start`、`terminal_xserver_status`、`terminal_xserver_stop`（均需 daemon 常驻与配套宿主策略上下文）。

安全边界：

- 仅 Unix socket（`-nolisten tcp`），不在运行时暴露可远程连接的 TCP display；
- 不读取、不修改用户 `~/.Xauthority`，不使用 `-ac`（不关闭认证）；
- cookie 只存在于 0700 目录内的 0600 文件，stop 即删；
- 不安装系统包、不启动系统级 X Server、不改 CSP。

## 4. 与验收条目的对照

| #40 验收方向 | 状态 | 说明 |
| --- | --- | --- |
| 受管 X display 生命周期（启动/回收/凭据撤销） | 已实现 + 单测 | `test/xserver.test.js`（假 Xvfb/xauth，验证参数、Unix-only、0600/0700、stop 删除与进程终止） |
| 实时窗口呈现（seamless / 多窗口） | NOT_RUN | 受宿主 CSP 与窗口面形态未裁决阻塞 |
| 剪贴板双向 | NOT_RUN | 依赖窗口呈现方案 |
| 软件渲染可用 | 部分 | Xvfb 本身提供软件渲染；未在真实 Linux 主机跑 GLX/X 应用端到端 |
| XDMCP 范围与安全决定 | 已裁决（不启用） | 见 §2 |
| 硬件加速仅限已验证主机 | 已裁决（默认关闭） | 见 §2 |
| 关闭后撤销访问（teardown revokes） | 已实现（display 级） | cookie 目录删除 + 进程终止；会话级撤销随第二阶段接入 SSH 转发 |

## 5. 未验证 / 风险

- 未在真实 Linux + Xvfb + xauth 环境跑过 `terminal_xserver_start`；本机（macOS）只有假二进制单测。
- 未与 SSH X11 转发联通（`prepareX11` 只接受 workspace 相对 Xauthority，需第二阶段设计受管 cookie 的授权传递方式，且不能把 cookie 落到用户工作区）。
- 窗口呈现若选 A（原生窗口），属于 aide 宿主改动，必须先确认；选 C 不需要宿主改动。
- 未运行 Docker 插件套件与真实 AIDE 宿主验收；`npm test` 中 relay/OpenSSH/udevadm 相关 14 项在本机为环境性失败（缺 python cryptography、sshd/PTY、udevadm），已在未改动基线上对照确认同样失败。
