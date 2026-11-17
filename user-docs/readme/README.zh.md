# YuGo Pi

[中文](user-docs/readme/README.zh.md) · [License](LICENSE) · [Upstream](https://github.com/ygncode/pi-web)

YuGo Pi 是 **pi-web** 的独立维护 MIT 授权变体，原作者为 **Set Kyar Wa Lar (YGNCode)**，非 pi-web 或 Pi 官方发布版本。上游版权与许可证保持不变。

项目维护于 [yinniora/yugo-pi](https://github.com/yinniora/yugo-pi)，此变体的问题反馈与贡献请提交至本仓库。

## YuGo Pi 新增内容

- 原生 Mac 对话窗口及移动端主屏幕 Web 应用。
- 手机主屏幕的项目与对话、项目菜单与新建对话控件、持久折叠状态，以及返回主页操作。
- 稳定的移动端键盘布局、滚动边界限制与页面缩放保护。
- 可展开的模型思考与工具活动、图片/SVG 捏合缩放、原生视频与音频、文件下载，以及独立的 BTW 侧边聊天（含介绍说明及将回复显式附加到主草稿的功能）。
- 对话回收站与永久删除、可选的已生成文件清理验证，以及可选的将项目文件夹移至 Mac 回收站（含确认提示）。
- Mac 身份验证一次性配对、设备审批、撤销与精确设备详情。Mac 掌控身份与访问决策。
- 自有认证中继、自动 P2P 尝试、加密 WebRTC/DTLS、实际 P2P/中继状态，以及同步/加载指示器。
- 设置 → 模型：带标签的 API 密钥、按密钥刷新模型、多选应用、移除已应用模型，以及 Mac/移动端共享对话选择器。

## 构建与安装

前提条件：`go.mod` 指定的 Go 版本、Node/npm、已配置的 Pi 编码代理，以及用于原生 Mac 窗口的 Xcode Command Line Tools。源码不附带模型密钥、设备、中继凭据或证书。

```bash
git clone https://github.com/yinniora/yugo-pi.git
cd yugo-pi
make check
make build remote-build VERSION=0.1.0-yugo.3
python3 scripts/collect_notices.py
python3 scripts/build_macos.py
python3 scripts/install_remote_macos.py --client https://YOUR-INDEPENDENT-CLIENT/
```

默认本地端点为 `http://127.0.0.1:31415`；远程访问通过独立的已审批设备客户端启用。

全新 Mac 安装程序拒绝覆盖已有安装。现有用户请参阅[迁移与维护指南](docs/maintenance.md)。内部 `pi-web` 二进制名称与数据路径保持兼容，升级不会重置对话、审批、密钥或已有配对来源。

手机访问与自建服务器，请参阅[自托管远程指南](docs/architecture/self-hosted-remote.md)与[安全架构](docs/architecture/remote-security.md)。独立托管的手机程序必须与不受信任的中继分开部署。

## 在不替换 YuGo 改动的前提下合并上游更新

YuGo Pi 有自己的 `yugo-v*` 发布版本。Mac 服务每六小时自动追踪官方提交，并在 Mac 和手机上显示审查提醒。运行时升级保持手动：我们审查官方变更，准备 YuGo 补丁并在发布前验证功能。应用与 Pi 扩展不安装上游 npm 包。官方变更拉取至独立的审查工作树：

```bash
python3 scripts/sync_upstream.py check
python3 scripts/sync_upstream.py prepare
```

脚本不会重置或合并到你的工作主分支。冲突保留在审查工作树中等待显式解决。审查差异、运行变体检查、完整测试与移动端回归测试后，再合并已审查的 PR。上游变更可能产生冲突，不会仅因更新较新就予以接受。完整流程见[维护文档](docs/maintenance.md)。

## 许可证与来源

YuGo Pi 保留上游 [MIT 许可证](LICENSE)、作者署名与 Git 历史。[NOTICE](NOTICE) 用于区分本衍生版本与上游。[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) 随分发的客户端、原生应用及发布归档一并提供。独立工具与模型服务仍受其各自许可证和条款约束。

历史上游指南与翻译作为参考保留；根目录 README、YuGo 维护指南与自托管指南描述本变体。
