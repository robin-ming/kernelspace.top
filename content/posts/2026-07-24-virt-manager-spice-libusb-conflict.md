---
title: "virt-manager SPICE 控制台故障：MVS libusb 冲突分析与修复"
date: 2026-07-24
summary: "virt-manager SPICE 控制台故障：MVS libusb 冲突分析与修复"
category: linux-virtualization
tags: [codex, "kvm"]
source_project: "kvm"
source_path: "/home/robin/Storage/Project/kvm/virt-manager-spice故障分析与修复记录.md"
synced_at: "2026-07-24T17:36:47+08:00"
---

# virt-manager SPICE 控制台故障分析与修复记录

## 1. 故障概述

- 发生日期：2026-07-24
- 宿主机：Ubuntu 24.04 系列环境，Linux 6.17
- 虚拟机：`MicrosoftWindows11`
- 管理工具：virt-manager 4.1.0
- 显示协议：SPICE

virt-manager 打开 Windows 虚拟机图形控制台时显示：

```text
连接到图形控制台出错：
could not get a reference to type class
```

虚拟机窗口无法显示，但虚拟机并未停止。

## 2. 诊断结论

故障发生在宿主机的 SPICE/GTK 图形客户端，不是 Windows 虚拟机、虚拟磁盘或 QEMU 本身损坏。

检查时虚拟机仍处于运行状态：

```text
Id   Name                 State
1    MicrosoftWindows11   running
```

虚拟机的 SPICE 服务也在正常监听：

```text
spice://127.0.0.1:5900
```

独立运行 virt-viewer 后获得了真正的底层错误：

```text
virt-viewer: symbol lookup error:
/lib/x86_64-linux-gnu/libusbredirhost.so.1:
undefined symbol: libusb_set_option
```

## 3. 根本原因

海康 MVS SDK 安装程序在以下三个登录配置文件中全局设置了动态库搜索路径：

```text
/etc/profile
/home/robin/.profile
/home/robin/.bashrc
```

原设置为：

```bash
export LD_LIBRARY_PATH=/opt/MVS/lib/64:/opt/MVS/lib/32:$LD_LIBRARY_PATH
```

这使所有桌面程序优先加载 MVS 附带的动态库。virt-viewer/virt-manager 因而加载了：

```text
/opt/MVS/lib/64/libusb-1.0.so.0
```

而不是 Ubuntu 系统提供的：

```text
/lib/x86_64-linux-gnu/libusb-1.0.so.0
```

MVS 自带的 libusb 版本较旧，不提供 `libusb_set_option` 符号；系统的
`libusbredirhost.so.1` 则依赖该符号。两者 ABI 不兼容，导致 SPICE 客户端组件加载失败。
virt-manager 最终只显示了较笼统的 Python/GObject 错误
`could not get a reference to type class`。

故障链路如下：

```text
全局 LD_LIBRARY_PATH
  -> 优先加载 MVS 自带的旧 libusb
  -> libusbredirhost 找不到 libusb_set_option
  -> SPICE GTK 组件初始化失败
  -> virt-manager 无法打开图形控制台
```

## 4. 修复措施

从以下文件中移除了全局 `LD_LIBRARY_PATH` 设置，并加入说明注释：

```text
/etc/profile
/home/robin/.profile
/home/robin/.bashrc
```

修改后的对应内容为：

```bash
# MVS.sh supplies the MVS-only library path when the application starts.
```

没有删除 MVS 所需的其他环境变量。

MVS 自带的桌面启动项执行 `/opt/MVS/bin/MVS.sh`，该脚本已经为 MVS 进程单独设置：

```bash
export LD_LIBRARY_PATH=${ROOT_PATH}:/opt/MVS/lib/64
```

因此，取消全局设置不会影响通过 MVS 桌面图标或该脚本启动 MVS，同时可以避免其私有库污染
virt-manager 及其他系统程序。

## 5. 验证结果

修复后，新登录 Shell 中 `LD_LIBRARY_PATH` 未被全局设置：

```text
LD_LIBRARY_PATH=<unset>
```

`libusbredirhost.so.1` 已改为加载正确的系统库：

```text
libusb-1.0.so.0 => /lib/x86_64-linux-gnu/libusb-1.0.so.0
```

再次启动 virt-viewer 进行 SPICE 连接测试，未再出现
`undefined symbol: libusb_set_option` 或
`could not get a reference to type class`。

修复生效后需要关闭并重新启动 virt-manager；如果桌面会话仍继承旧环境，则注销后重新登录。
重启 virt-manager 不会关闭正在运行的 Windows 虚拟机。

## 6. 备份与回滚

修复前的配置已备份：

```text
/etc/profile.codex-backup-20260724
/home/robin/.profile.codex-backup-20260724
/home/robin/.bashrc.codex-backup-20260724
```

如需回滚，可恢复对应备份。一般不建议恢复全局 MVS `LD_LIBRARY_PATH`；如果其他 MVS
工具需要私有库，应为该工具创建独立启动脚本，只在相应进程内设置环境变量。

## 7. 后续建议

- 第三方 SDK 的私有动态库路径不应写入全局登录环境。
- 优先使用厂商提供的启动脚本，使环境变量只作用于对应程序。
- 遇到 virt-manager 图形控制台错误时，先使用 `virsh list --all` 判断虚拟机是否仍在运行。
- 使用独立的 `virt-viewer --debug` 获取比 virt-manager 界面更具体的底层错误。
- 软件升级或重新安装 MVS 后，应检查安装程序是否再次向登录配置追加
  `LD_LIBRARY_PATH`。
