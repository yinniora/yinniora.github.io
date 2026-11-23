# YuGo Pi 安装与配对

## 安装主机和客户端

1. 在运行 Pi 的电脑上下载 **YuGo Pi**。macOS 使用 `.pkg`，Windows 使用 `-setup.exe`，Debian 和 Ubuntu 桌面使用 `.deb`。安装后打开 YuGo Pi，首次选择「在这台电脑运行 Pi」即启动内置后端。已有 Pi 用户可直接使用原有配置，新用户在「模型」中添加 API 密钥。 [YuGo Pi 发行页](https://github.com/yinniora/yugo-pi/releases)
2. 在 iPhone 或 iPad 上用 Safari 打开 YuGo Pi，选择「分享 → 添加到主屏幕」。Android 可安装发行页上的 APK。另一台电脑可在浏览器打开同一地址，也可安装同一个 **YuGo Pi** 桌面版并选择「连接另一台电脑」。之后可以在「设置 → 连接 → 桌面模式」切换。 [打开 YuGo Pi](https://yinniora.github.io/) · [各平台下载说明](../apps/README.md)

## 配置连接并扫码

在主机打开「设置 → 远程控制和设备」，启用你要使用的连接方式。

| 已有条件 | 设置步骤 |
| --- | --- |
| 主机和手机已加入同一个 Tailscale 网络 | 点「启用 Tailscale 连接」，按提示授权 Tailscale HTTPS。 |
| 只有自己的 VPS | 在服务器运行发行版自带的中继安装器，把一次性配置码粘贴到主机。已配置 SSH 密钥和主机指纹时，也可从主机界面部署。 [中继安装说明](architecture/self-hosted-remote.md) |
| Tailscale 和 VPS 都可用 | 两项都启用。客户端在已授权的线路中尝试连接。 |
| 仅同一 Wi‑Fi | 在主机启用局域网，两端接入同一网络。Android、iOS、iPadOS、Windows、macOS 和 Linux 原生客户端可扫码或粘贴配对链接。网页客户端可使用 Tailscale 或中继。 [iOS 安装说明](../apps/ios/README.md) |

在主机的「设备」中完成系统认证，生成一个二维码，然后用远程设备上要长期使用的 YuGo Pi 客户端扫码。二维码涵盖当时已启用的连接方式。以后添加 VPS 或 Tailscale 时，用同一个客户端重新扫码即可补上线路，保留设备名称和原有授权。浏览器、主屏幕网页和原生 App 各有自己的设备身份。

## 更新

- **主机**在版本窗口点「下载并安装更新」。兼容的 Mac 和 Linux 后端更新只下载后端，等会话空闲后重启。需要更新桌面窗口或运行时的版本会打开已校验的系统安装包。
- **Android**从 App 菜单检查更新，经校验后使用系统安装。**iOS 和 iPadOS 主屏幕网页**会获取新版网页，也可在版本窗口手动刷新。原生 iOS 的外壳更新走 TestFlight 或 App Store。
- **自建中继**可在服务器运行 `sudo yugo-pi-relay-setup --check-update`，按显示的命令安装目标版本。
