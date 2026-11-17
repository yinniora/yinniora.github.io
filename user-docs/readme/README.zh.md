# YuGo Pi

[中文](user-docs/readme/README.zh.md) · [License](LICENSE) · [Upstream](https://github.com/ygncode/pi-web)

YuGo Pi 是 **pi-web** 的独立维护 MIT 许可变体，原作者为 **Set Kyar Wa Lar (YGNCode)**。本项目并非官方 pi-web 或 Pi 发行版，上游版权与许可保持不变。

项目维护地址：[yinniora/yugo-pi](https://github.com/yinniora/yugo-pi)。与本变体相关的问题反馈和贡献请提交至此仓库。

## YuGo Pi 新增功能

- 原生 Mac 对话窗口及移动端主屏网页应用。
- 手机主屏的项目与对话视图、项目菜单与新建对话控件、持久折叠状态，以及返回主页操作。
- 稳定的移动端键盘布局、有界滚动与页面缩放保护。
- 可展开的模型思考与工具活动、图片/SVG 缩放、原生视频与音频、文件下载，以及带介绍的独立 BTW 侧边对话，支持将回复显式附加至主草稿。
- 对话回收站与永久删除、可选的已生成文件清理验证，以及可选的将项目文件夹移至 Mac 废纸篓（带确认）。
- Mac 认证一次性配对、设备审批、撤销与精确设备详情。Mac 掌管身份与访问决策。
- 自建认证中继、自动 P2P 尝试、加密 WebRTC/DTLS、真实 P2P/中继状态，以及同步/加载指示器。

## 构建与安装

前置条件：`go.mod` 指定的 Go 版本、Node/npm、已配置的 Pi 编程助手，以及用于原生 Mac 窗口的 Xcode Command Line Tools。源码不包含模型密钥、设备、中继凭据或证书。

```bash
git clone https://github.com/yinniora/yugo-pi.git
cd yugo-pi
make check
make build remote-build VERSION=0.1.0-yugo.2
python3 scripts/collect_notices.py
python3 scripts/build_macos.py
python3 scripts/install_remote_macos.py --client https://YOUR-INDEPENDENT-CLIENT/
```

默认本地端点为 `http://127.0.0.1:31415`；远程访问通过独立的已审批设备客户端启用。

全新 Mac 安装程序拒绝覆盖已有安装。现有用户请参阅[迁移与维护指南](docs/maintenance.md)。内部 `pi-web` 二进制名称与数据路径保持兼容，升级不会重置对话、审批、密钥或已有配对来源。

如需手机访问和自建服务器，请参阅[自托管远程指南](docs/architecture/self-hosted-remote.md)与[安全架构](docs/architecture/remote-security.md)。独立托管的手机程序必须与不受信任的中继保持隔离。

## 在不覆盖 YuGo 变更的前提下跟进上游更新

YuGo Pi 有自己的 `yugo-v*` 发行版。Mac 服务每六小时自动追踪官方提交，并在 Mac 和手机上显示审查提醒。运行时升级保持手动：我们审查官方变更、准备 YuGo 补丁并在发布前验证功能。应用与 Pi 扩展不安装上游 npm 包。官方变更会被拉取至隔离的审查工作树：

```bash
python3 scripts/sync_upstream.py check
python3 scripts/sync_upstream.py prepare
```

该脚本不会重置或合并至您的工作主分支。冲突保留在审查工作树中等待显式解决。审查差异、运行变体检查、完整测试和移动端回归测试后，再合并已审查的 PR。上游变更可能存在冲突；不会仅因版本更新就接受变更。完整流程请参阅[维护指南](docs/maintenance.md)。

## 许可证与来源

YuGo Pi 保留上游 [MIT 许可证](LICENSE)、作者署名与 Git 历史。[NOTICE](NOTICE) 将本衍生版本与上游区分。[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) 随分发的客户端、原生应用及发行归档一并提供。独立工具与模型服务仍受其各自许可证和条款约束。

历史上游指南与译文保留供参考；根目录 README、YuGo 维护指南与自托管指南描述本变体。

