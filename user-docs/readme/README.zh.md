# YuGo Pi

[中文](user-docs/readme/README.zh.md) · [License](LICENSE) · [Upstream](https://github.com/ygncode/pi-web)

YuGo Pi 是 **pi-web** 的独立维护、MIT 许可的衍生版本，原作者为 **Set Kyar Wa Lar (YGNCode)**。它不是官方的 pi-web 或 Pi 发行版。上游版权与许可保持不变。

本项目维护于 [yinniora/yugo-pi](https://github.com/yinniora/yugo-pi)。本衍生版的 bug 报告与贡献请提交至本仓库。

## YuGo Pi 的新增内容

- 原生 Mac 对话窗口与移动端主屏幕 Web 应用。
- 手机主屏幕上的项目与对话、项目菜单与新对话控件、持久化折叠，以及明确的主页返回操作。
- 稳定的移动端键盘布局、受控滚动与页面缩放保护。
- 可展开的模型思考与工具活动、图片/SVG 捏合缩放、原生视频与音频、文件下载，以及独立的 BTW 侧边聊天，附带说明并可将回复显式附加到主草稿。
- 对话回收站与永久删除、可选的已验证生成文件清理、可选的项目文件夹移至 Mac 废纸篓并带确认。
- Mac 认证的一次性配对、设备审批、撤销及精确的设备详情。你的 Mac 掌控身份与访问决策。
- 自有的认证中继、自动 P2P 尝试、加密的 WebRTC/DTLS、真实的 P2P/Relay 状态，以及同步/加载指示器。

- 设置 → 模型：带标签的 API key、按 key 刷新模型、多选应用、移除已应用模型，以及共享的 Mac/移动端对话选择器。

## 构建与安装

前置条件：`go.mod` 所要求的 Go、Node/npm、已配置的 Pi coding agent，以及用于原生 Mac 窗口的 Xcode Command Line Tools。源码不附带任何模型 key、设备、中继凭据或证书。

```bash
git clone https://github.com/yinniora/yugo-pi.git
cd yugo-pi
make check
make build remote-build VERSION=0.1.0-yugo.4
python3 scripts/collect_notices.py
python3 scripts/build_macos.py
python3 scripts/install_remote_macos.py --client https://YOUR-INDEPENDENT-CLIENT/
```

默认本地端点为 `http://127.0.0.1:31415`；远程访问通过独立的已批准设备客户端启用。

全新的 Mac 安装器不会覆盖已有安装。现有用户请遵循[迁移与维护指南](docs/maintenance.md)。内部的 `pi-web` 二进制名称与数据路径保持兼容，因此升级不会重置对话、审批、key 或已有配对来源。

关于手机访问与自建服务器，参见[自托管远程指南](docs/architecture/self-hosted-remote.md)与[安全架构](docs/architecture/remote-security.md)。独立托管的手机程序必须与不可信中继保持隔离。

## 不替换 YuGo 改动的上游更新

YuGo Pi 拥有独立的 `yugo-v*` 发行版。Mac 服务每六小时自动跟踪官方提交，并在 Mac 与手机上显示审查提醒。运行时升级仍为手动：我们审查官方变更、准备 YuGo 补丁并在发布前验证我们的功能。应用与 Pi 扩展不会安装上游 npm 包。官方变更会被拉取到隔离的审查工作树中：

```bash
python3 scripts/sync_upstream.py check
python3 scripts/sync_upstream.py prepare
```

该脚本从不重置或合并到你当前的主分支。冲突停留在审查工作树中等待显式解决。审查 diff、运行衍生版检查、完整测试与移动端回归，然后合并已审查的 PR。上游变更可能产生冲突；任何更新都不会仅因较新而被接受。完整流程见[维护](docs/maintenance.md)。

## 许可与出处

YuGo Pi 保留上游的 [MIT 许可](LICENSE)、作者署名与 Git 历史。[NOTICE](NOTICE) 区分本衍生版与上游。[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) 随分发的客户端、原生应用与发行归档一同提供。独立的工具与模型服务仍受其各自许可与条款约束。

历史上的上游指南与翻译保留以供参考；根 README、YuGo 维护指南与自托管指南描述本衍生版。
