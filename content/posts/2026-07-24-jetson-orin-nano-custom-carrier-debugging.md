---
title: "Jetson Orin Nano 自研底板 Bring-up 全过程：刷机、无 EEPROM 启动、Type-C 与双 USB 相机"
date: 2026-07-24
summary: "Jetson Orin Nano 自研底板 Bring-up 全过程：刷机、无 EEPROM 启动、Type-C 与双 USB 相机"
category: jetson
tags: [codex, "nvidia_jetson_orin_nano_4gb"]
source_project: "NVIDIA_Jetson_Orin_Nano_4GB"
source_path: "/home/robin/Storage/Project/NVIDIA_Jetson_Orin_Nano_4GB/docs/bringup/2026-07-24_jetson_orin_nano_custom_carrier_debugging_notes.md"
synced_at: "2026-07-24T17:48:48+08:00"
---

# Jetson Orin Nano 自研底板 Bring-up 全过程：从刷机、无 EEPROM 启动到 Type-C 与双 USB 相机

日期：2026-07-24

## 1. 项目背景与最终进展

本项目的目标，是完成 NVIDIA Jetson Orin Nano 4GB/8GB 核心板与 Seeed reComputer J401 底板、自研底板之间的系统刷写、启动适配和外设联调，并最终固化自研底板所需的设备树、内核配置及相机测试流程。

截至 2026-07-24，已经形成以下可复现结果：

- L4T R35.4.1/R35.5.0 BSP、RootFS、内核源码和 Bootlin 交叉编译环境已搭建。
- Orin Nano 4GB 在 J401 底板完成 QSPI 与 256 GB NVMe 全量刷写、OEM 初始化和常用接口验证。
- Orin Nano 8GB 在 J401 底板完成 QSPI 与 NVMe 全量刷写，随后迁移到自研底板启动。
- 自研底板无 CVB EEPROM 导致的 MB2 启动卡点已解决，HDMI、千兆网口和两个 USB 2.0 Type-A 接口可用。
- 自研 Type-C Host/Source 设备树与内核支持已固化；USB 2.0 Host 可用，USB 3.0 正反插均以 5 Gbit/s 枚举。
- 系统已配置 J401 与自研底板双内核、双 DTB 启动菜单，默认使用安全的 J401 启动项。
- L640 红外相机已通过 UVC/V4L2 完成 640×512 YUYV 基础取流。
- 海康 MV-CB016-10UC-S 已通过 MVS ARM64 SDK 在 Jetson 上完成 USB3 枚举、取流和 JPEG 保存。
- 两台相机经同一个 USB Hub 短时间同时取流成功，且普通用户可直接运行演示脚本。

本文不只记录最后可用的命令，而是按问题复盘整个调试过程。每个问题都尽量保留故障现象、定位思路、根因、处理方法、验证标准和可复用经验。

## 2. 首先要分清的三个对象

这个项目最容易出现的错误，是把“核心板型号”“底板型号”和“刷机时使用的配置”混在一起。

项目中实际涉及：

| 核心板 | 常见搭配 | Force Recovery USB ID | CVM EEPROM SKU | 目标 DTB |
| --- | --- | --- | --- | --- |
| Orin Nano 4GB | J401/Seeed 开发板 | `0955:7623` | `0004` | `tegra234-p3767-0004-p3509-a02.dtb` |
| Orin Nano 8GB | J401 或自研底板 | `0955:7523` | `0003` | `tegra234-p3767-0003-p3509-a02.dtb` 或自研 DTB |

自研底板没有 CVB EEPROM，因此不能依靠载板 EEPROM 自动识别。刷机与启动配置必须同时考虑：

1. Recovery USB ID，用来判断当前连接的是哪一种核心板。
2. CVM EEPROM SKU，用来确定核心板的 P3767 SKU 和内存型号。
3. 实际底板连接方式，用来选择 J401 DTB、自研 DTB和对应的 UPHY/USB 配置。

只看“J3010”“J3011”或底板名称推断核心板，已经在实测中证明不可靠。

## 3. BSP 环境搭建阶段的问题

### 3.1 RootFS 展开与 `apply_binaries` 不是简单解压

最初需要把 NVIDIA Driver Package、Sample RootFS、内核源码和交叉编译工具链整理为可重复构建的 BSP 目录。实际问题是 RootFS 内已有默认 README 等内容，旧脚本把“目录非空”误判为已完成，导致后续闭源库没有正确安装。

处理方式是修正 `setup_bsp.sh` 的判断逻辑，把以下步骤明确拆开：

- 解压 L4T Driver Package。
- 解压 Sample RootFS。
- 执行 `apply_binaries.sh` 安装 NVIDIA 用户态闭源组件。
- 提取内核源码。
- 应用项目自有补丁和板级配置。

经验是：判断 BSP 是否就绪，不能只检查目录存在或非空，应检查关键产物，例如 `Linux_for_Tegra/rootfs/etc/nv_tegra_release`、目标 DTB、内核镜像和 `apply_binaries` 的完成状态。

### 3.2 Seeed R36 代码不能直接混入 R35 BSP

项目中存在 Seeed Studio 的参考源码，但版本为 R36.4.3/JetPack 6.x，而当前主线最初使用 R35.4.1，后续稳定在 R35.5.0。

跨大版本直接覆盖设备树、BCT 或脚本会引入难以识别的结构差异。因此采用的原则是：

- 参考 Seeed 的板级连接与节点写法。
- 不直接用 R36 文件覆盖 R35 BSP。
- 所有改动基于目标 L4T 版本做最小化移植。
- 自研配置保存在 `bsp/custom-carrier/`，通过脚本应用到解压生成的 `Linux_for_Tegra`。

### 3.3 只修改展开目录会在重建后丢失

`bsp/.../Linux_for_Tegra` 是生成目录。直接在其中修改 BCT、配置或 DTB，重新搭建 BSP 后就会丢失。

项目最终把持久化内容放到受版本控制的目录，并提供幂等应用脚本。脚本遇到相同补丁时跳过，遇到同一节点但值不同时停止并报冲突。这一点避免了“上次能刷、重新解压后又失败”的隐性问题。

## 4. 刷机准备阶段的问题

### 4.1 初始底板配置选错

最初计划使用 `jetson-orin-nano-devkit`。该配置面向 NVIDIA P3768 官方开发套件底板，不适合 J401/P3509 类 HDMI 底板。

修正为：

```text
p3509-a02-p3767-0000
```

并保留 SKU 自动判断逻辑，使 4GB、8GB 核心板分别选择正确的 P3767 DTB。

可复用判断方法是：刷机配置描述的是“模组 + 底板 + 存储/分区方案”，不是一个可以仅凭商品名称选择的通用模板。

### 4.2 Recovery USB ID 记录错误

早期文档使用了 `0955:7323`，该 ID 对应 Orin NX 16GB。实际测试得到：

```text
Orin Nano 8GB: 0955:7523
Orin Nano 4GB: 0955:7623
```

这次错误的影响不仅是预检失败，还可能导致用错 DTB、BCT 或刷机入口。因此刷机脚本现在先检查 USB ID，再结合 CVM EEPROM SKU 判断核心板，而不是默认相信人工填写的板型。

### 4.3 J401 HDMI Hot-Plug 的 MB2 SCR 补丁缺失

J401 的 HDMI Hot-Plug 使用 `GPIO_M_0`，需要允许 DCE 固件访问。R35.4.1 原始 BSP 缺少对应 SCR 覆盖，补丁为：

```dts
reg@322 {
    exclusion-info = <2>;
    value = <0x38009696>;
};
```

网上资料曾出现格式和值不一致，因此最终以 NVIDIA 对应版本 Release Notes 为准，而不是机械复制第三方页面。

此问题说明：HDMI 不亮不一定是 Linux DRM、显示设备树或线缆问题，也可能在 MB2/DCE 权限阶段已经埋下原因。

### 4.4 Ubuntu 24.04 主机不在官方支持范围

R35.x 官方刷机主机主要是 Ubuntu 18.04/20.04，而实际主机是 KDE neon/Ubuntu 24.04。出现的兼容点包括：

- `/usr/bin/python` 指向已不存在的 Python 2。
- 刷机依赖不完整。
- NetworkManager 自动管理临时 USB RNDIS 网卡。
- IPv6 链路本地路由行为与 NVIDIA 脚本预期不完全一致。

项目没有修改系统全局 Python，而是在项目内提供 `python -> python3` 兼容入口，并编写主机依赖准备和刷机预检脚本。

这套方案已经成功完成刷机，但必须保留结论边界：Ubuntu 24.04 是项目实测兼容环境，不是 NVIDIA 官方认证环境。若出现无法解释的工具链或网络问题，Ubuntu 20.04 主机仍是重要的对照基线。

## 5. QSPI 成功但 NVMe 未写入：initrd flash 的 IPv6 卡点

### 5.1 故障现象

Orin Nano 8GB 首次执行完整 NVMe 刷机时，设备能从 APX 模式进入 initrd flashing mode：

```text
0955:7035 NVIDIA Corp. Jetson device in initrd flashing mode
```

主机也能枚举 RNDIS 网卡和 USB Mass Storage，但流程随后停在：

```text
Waiting for device to expose ssh ......
Error: ipv6: address already assigned.
Timeout
```

### 5.2 容易产生的误判

看到 QSPI 擦写完成或 `0955:7035`，不代表 NVMe rootfs 已写入。真正的 NVMe 写入依赖 initrd 环境通过 USB RNDIS 建立 IPv6 SSH/NFS 通道。

同样，`ipv6: address already assigned` 只是脚本重复配置地址时打印出的症状，不是唯一根因。

### 5.3 根因定位

实际问题在主机侧 USB RNDIS 接口的 IPv6 路由。NetworkManager 会自动接管临时出现的 `enx...`，而 NVIDIA 脚本也会配置：

```text
fc00:1:1::1/64
fe80::2/128
```

未指定接口直接 ping IPv6 地址时，流量还可能错误地走 Wi-Fi 公网 IPv6 默认路由。

最终在 4GB/J3010 全量刷机中验证有效的处理，是为 Jetson USB RNDIS 接口增加显式链路本地主机路由：

```text
目标：fe80::1/128
接口：Jetson 对应的 enx...
源地址：fe80::2
```

路由正确后，SSH 阶段继续，QSPI 与 NVMe 全量刷写完成。

### 5.4 临时绕过与正确结论

在尚未解决 USB 网络阶段时，可以使用 `flash.sh` 只刷 QSPI：

```bash
sudo ./flash.sh \
  -c bootloader/t186ref/cfg/flash_t234_qspi.xml \
  --no-systemimg \
  p3509-a02-p3767-0000 internal
```

这适合验证启动固件修改，但必须明确记录：

- QSPI 已写入。
- NVMe/rootfs 未写入。
- 完整 Ubuntu 启动尚未验证。

## 6. 自研底板上电卡在 MB2：不存在的 CVB EEPROM

### 6.1 故障现象

自研底板上电后，串口能运行到 MB2，随后出现：

```text
I> Task: Prepare eeprom data
E> I2C: slave not found in slaves.
E> I2C_DEV: Could not read ... from slave 0xae
E> eeprom: Failed to read I2C slave device
I> Busy Spin
```

### 6.2 定位方法

日志已经给出三个关键事实：

- 卡点在 MB2，不在 Linux 内核。
- 访问的是 I2C slave `0xae`。
- `0xae` 是 8-bit 地址，对应 7-bit 地址 `0x57`。

核对 J401 原理图后，`0x57` 正是 Carrier Board Config EEPROM。再核对自研底板，确认没有该器件。

因此 HDMI、rootfs、内核驱动此时都不是排查重点。系统甚至还没有走到它们。

### 6.3 修复

新增 no-EEPROM MB2 BCT，保留核心板 CVM EEPROM 读取，只禁用载板 CVB EEPROM：

```dts
eeprom {
    cvm_eeprom_i2c_instance = <0>;
    cvm_eeprom_i2c_slave_address = <0xa0>;
    cvm_eeprom_read_size = <0x100>;
    cvb_eeprom_i2c_instance = <0>;
    cvb_eeprom_i2c_slave_address = <0xae>;
    cvb_eeprom_read_size = <0x0>;
};
```

通过只刷 QSPI 进行最小验证后，系统越过 MB2，HDMI 点亮。

### 6.4 经验

无 CVB EEPROM 底板不是简单“少焊一个器件”。它改变了启动配置来源，意味着：

- MB2 BCT 必须明确跳过 CVB EEPROM。
- 底板差异要固化在配置、设备树和刷机脚本中。
- 仍应保留 CVM EEPROM 读取，用来识别核心板 SKU。

## 7. 自研底板 Type-C 调试

### 7.1 先从原理图建立物理事实

自研 Type-C 第一版映射为：

```text
FUSB302:  I2C 地址 0x22
CC_INT:   PP.06
VBUS EN:  PZ.01
USB 2.0:  usb2-2
USB 3.x:  P0/P1 两组 SuperSpeed 通道
角色:      固定 Host/Source
```

内核中把 FUSB302/TCPM 支持编为 built-in，并配套自研 DTB、构建脚本和部署脚本。

### 7.2 “连接电脑没有 README Gadget 盘”不是 Host 失败

J401 的 Type-C 可用于 Device/Gadget/Recovery，连接电脑时可能出现 NVIDIA README Gadget 盘。自研当前配置固定为 Host/Source，同时禁用 XUDC，因此电脑不枚举 Gadget 盘符合设计。

判断 Host 是否成功，应检查：

- VBUS 是否输出。
- XHCI 是否枚举设备。
- `lsusb -t` 是否显示正确速率。
- U 盘块设备和文件系统是否可访问。

不能拿 J401 的 Device 行为作为自研 Host 的验收标准。

### 7.3 USB 2.0 通过不代表 USB 3.0 与正反插通过

Type-C 正反插涉及两组 SuperSpeed 物理通道。验证时先用 USB 2.0 U 盘确认 VBUS、CC、D+/D−、XHCI 和文件系统闭环，再用同一个 USB 3.0 U 盘分别翻转插头。

最终两种方向均显示：

```text
Mass Storage ... 5000M
```

这才证明 P0/P1 两组高速路径和方向切换均实际通过，而不是只证明 Type-C 外形接口能用。

### 7.4 必须证明系统实际加载了自研内核和 DTB

功能“碰巧能用”不能证明新设备树已加载。调试中保存了运行态证据，确认实际启动的是：

```text
Image.custom-carrier
自研底板 DTB
```

并结合 `/proc/device-tree`、启动参数、FUSB302/TCPM、XHCI、XUDC 和 role-switch 状态判断。设备树调试应始终检查运行态 FDT，不能只检查 `/boot` 目录中存在某个 DTB。

## 8. 自研 DTB 为什么不能用于 J401 initrd 刷机

这是整个项目中最容易混淆的一组现象：

- 自研底板的运行态 Type-C Host 可以正常工作。
- 把同一套自研 DTB 用于 J401 上的 initrd 刷机，却无法建立 RNDIS/SSH。

根因是物理端口不同：

```text
J401 Recovery Type-C: usb2-0
自研 Type-C:         usb2-2
```

在 J401 上使用自研 DTB 时，XUDC 被路由到错误的 USB2 端口，主机无法枚举刷机所需 Gadget/RNDIS。这个失败不说明自研 Host DTS 错误，而是说明“运行态 Host DTB”和“刷机载板的 Recovery DTB”不能混用。

最终流程为：

1. 在 J401 上使用公共内核和 J401/P3509 DTB 完成 QSPI+NVMe 全量刷写。
2. QSPI 使用 no-EEPROM MB2 BCT，为后续迁移到无 EEPROM 自研底板做准备。
3. 在系统内安装 J401 与自研底板双内核、双 DTB 菜单。
4. 默认启动项保留为 J401，自研项命名为 `custom-carrier`。
5. 模组和 NVMe 迁移到自研底板后，从串口选择自研启动项。

这也形成了一条重要原则：刷机路径、Force Recovery 路径和系统运行态 USB Host 路径要独立设计、独立验证。

## 9. 双启动项与安全回退

直接替换唯一的内核或 DTB，一旦 Type-C、显示或启动配置错误，就会失去板端修复入口。

项目采用双启动方案：

```text
默认项：j401
可选项：custom-carrier
```

同时保留原始 `extlinux.conf` 备份。默认超时回到已验证的 J401 配置，自研项使用独立的 `Image.custom-carrier` 和自研 DTB。

这样做的意义不只是方便切换，而是让设备树开发具备可恢复性。对于远程板卡或没有稳定显示输出的设备，这是比“覆盖后祈祷能启动”可靠得多的固化方式。

## 10. L640 红外 USB 相机调试

### 10.1 两个 `/dev/video*` 节点不代表两路图像

L640 枚举信息为：

```text
USB ID:     0424:6000
产品字符串: Thermal Camera
速率:       USB2 480M
驱动:       uvcvideo
节点:       /dev/video0、/dev/video1
```

通过 `v4l2-ctl --all` 和格式枚举确认，实际采集节点是 `/dev/video0`：

```text
640x512
YUYV 4:2:2
最高 50 fps
```

因此发现两个节点时，不能盲目按编号轮流打开；要检查各节点 capability 和支持格式。

### 10.2 `ffmpeg` 偶发 I/O error

`ffmpeg` 直接打开该相机时偶发 `Input/output error`，而：

```bash
v4l2-ctl --stream-mmap --stream-to=...
```

更稳定。测试脚本因此采用 V4L2 MMAP 保存原始 YUYV，再生成普通 JPEG、灰度增强 JPEG 和伪彩增强 JPEG。

100 帧连续取流实测约 50 fps，散热器场景可见明显热区，证明 USB、UVC、V4L2、YUYV 解码和图像保存链路打通。

### 10.3 设备忙和 UVC 状态异常

多个程序同时访问 `/dev/video0` 会出现：

```text
Device or resource busy
```

严重时还可能出现 UVC probe control 查询失败或 I/O error。恢复方式包括：

- 关闭占用进程。
- 重新插拔相机。
- 必要时通过 sysfs `authorized` 做 USB 设备复位。

### 10.4 基础取流不等于完整热成像能力

当前图像还可能有竖纹和固定纹理。灰度增强、伪彩只是显示处理，不能替代厂家 NUC/AGC/坏点校正，更不能证明温度数据可读。

仍待确认：

- NUC/快门校正。
- 自动增益。
- 厂家伪彩模式。
- 温度数据读取。
- 坏点与竖纹校正。
- 长时间稳定性。

## 11. 海康 USB3 工业相机调试

### 11.1 它不是普通 UVC 相机

海康 `MV-CB016-10UC-S` 使用 USB3 Vision/MVS SDK，`v4l2-ctl` 看不到 `/dev/video*` 并不代表设备异常。

正确的分层检查顺序是：

1. `lsusb` 是否出现 `2bdf:0001`。
2. `lsusb -t` 是否为 `5000M`。
3. MVS 是否能枚举和打开设备。
4. udev 权限是否正确。
5. `usbfs_memory_mb` 是否足够。
6. SDK 是否与 CPU 架构匹配。

### 11.2 PC SDK 与 Jetson SDK 不能混用

PC 使用 MVS x86_64 包，Jetson 使用 aarch64/ARM64 包。把 PC 动态库复制到 Jetson 不会得到可用结果。

Jetson 也不应执行 MVS 提供的 `IOMMU_Open.sh`，该脚本面向 Intel/AMD 与 GRUB 环境，不适用于 Jetson 的启动链路。

### 11.3 黑图和模糊都不是驱动故障

PC 侧最初能取流但画面接近全黑。调整曝光到：

```text
ExposureTime = 50000 us
```

后亮度恢复，帧率约 20 fps。随后仍然模糊，最终定位为镜头对焦环未调好，手动对焦后图像正常。

这说明“能枚举、能收帧、画面异常”应优先检查曝光、增益、触发模式、像素格式和光学对焦，不能立即归因于驱动。

### 11.4 Jetson 侧的可复现验证

Jetson 安装 MVS V5.0.1 aarch64 后，配置：

```text
udev 权限:       0666/root:plugdev
usbfs_memory_mb: 2000
TriggerMode:     Off
ExposureTime:    50000 us
Gain:            0
```

项目编写了非交互抓图工具，验证流程完整通过：

```text
MV_CC_Initialize
MV_CC_EnumDevices
MV_CC_OpenDevice
MV_CC_StartGrabbing
MV_CC_GetImageBuffer
MV_CC_SaveImageToFileEx2
```

保存帧为 `1440x1080` JPEG，型号和序列号为：

```text
MV-CB016-10UC-S
DB1186404
```

## 12. 双 USB 相机同时取流

两台相机最终均按 USB 方案联调，不再按双 MIPI CSI 方案规划：

```text
海康: USB3 5000M，MVS SDK
L640: USB2 480M，UVC/V4L2
```

短时间并行测试中：

- L640 后台连续抓取 100 帧 raw，约 48 fps。
- 海康同时保存 3 张 JPEG。
- 两路日志、USB 拓扑和输出图像均归档。
- 普通用户 `robin` 具备 `video`、`plugdev` 权限，可运行相机测试，不依赖 root。

普通用户演示入口：

```bash
cd ~/camera_bringup
./scripts/test_dual_usb_cameras.sh
```

当前结论只覆盖短时间功能验证。最终产品验收仍需：

- 30 分钟、2 小时、8 小时连续运行。
- 双相机热插拔与自动恢复。
- 重启、断电冷启动后的节点和权限稳定性。
- 独立供电 USB3 Hub 的供电与负载验证。
- 应用层并行取流、超时、重试和日志策略。

## 13. 调试方法总结

### 13.1 先确认失败发生在哪一层

Jetson bring-up 可以按以下层次切开：

```text
Force Recovery/APX
        ↓
MB1/MB2 与 BCT
        ↓
UEFI/QSPI
        ↓
Kernel + DTB
        ↓
RootFS
        ↓
USB/网络/显示等内核子系统
        ↓
V4L2、MVS SDK 与应用
```

例如：

- `Busy Spin` 且提示 EEPROM：优先看 MB2 BCT 和原理图。
- initrd 等待 SSH：优先看 USB Gadget、RNDIS 和 IPv6 路由。
- `lsusb` 有设备但无图：进入驱动、SDK、参数或光学层。
- Host U 盘可用但 PC 无 Gadget：先确认设计角色，而不是认定 Type-C 失败。

### 13.2 串口是启动问题的第一证据

Debug UART 参数：

```text
115200 8N1
无硬件流控
3.3V TTL
```

串口可覆盖 UEFI、Bootloader、Kernel 和 initrd。没有串口日志时，“黑屏”“卡住”“没反应”无法区分发生在哪个阶段。

### 13.3 每个结论都要有可复现的通过标准

本项目使用的典型证据包括：

- `lsusb`：设备身份和 Recovery 模式。
- `lsusb -t`：USB2/USB3 实际速率和拓扑。
- 串口日志：MB2、UEFI、Kernel 阶段。
- `/proc/device-tree` 和启动参数：实际加载的 DTB/内核。
- `v4l2-ctl`：节点能力、格式和连续取流。
- MVS API 日志：枚举、打开、参数、取帧和保存。
- 样图、raw、测试日志和时间戳目录：应用层交付证据。

### 13.4 最小改动、单变量验证

关键问题的解决都遵循了同一策略：

- EEPROM 卡点先只改 MB2 BCT，并只刷 QSPI。
- Type-C 先验证 USB2，再验证 USB3，最后验证正反插。
- 双相机先 PC 单测，再 Jetson 单测，最后并行。
- 先保留 J401 安全启动项，再增加自研 DTB。

单变量验证能把“偶然启动成功”变成有因果关系的工程结论。

## 14. 当前未闭环事项

截至本文日期，以下事项仍应明确标记为待完成：

1. L640 厂家 SDK/控制协议：NUC、快门、AGC、温度数据、坏点与竖纹校正。
2. 双相机长稳、热插拔、冷启动、独立供电 Hub 和应用异常恢复。
3. Type-C USB2 反向专项和 VBUS 带载测试。
4. 按需验证自研底板 Device/Gadget 与 Force Recovery；不得用 J401 端口映射直接推断。
5. 分析目标 UART/RS-422 的原理图、物理引脚、收发器方向控制和协议要求。
6. 根据 UART/RS-422 实测结果继续调整 pinmux、DTS 和内核配置，并完成固化。

## 15. 项目中的可复用资料

主要设计与调试记录：

```text
docs/bringup/2026-07-06_reComputer_J3010刷机准备工作总结.md
docs/bringup/2026-07-11_reComputer_J3011刷机排障与QSPI进展.md
docs/bringup/2026-07-14_custom_carrier_no_eeprom_hdmi_bringup.md
docs/bringup/2026-07-16_j3010_ubuntu_nvme_install.md
docs/bringup/2026-07-16_custom_carrier_typec_analysis_and_test_plan.md
docs/bringup/2026-07-19_custom_carrier_force_recovery_and_usb0_flash_analysis.md
docs/bringup/2026-07-23_l640_thermal_uvc_v4l2_validation.md
docs/bringup/2026-07-23_usb_dual_camera_debug_workflow.md
docs/bringup/2026-07-23_jetson_dual_usb_camera_progress_summary.md
```

关键脚本和入口：

```text
bsp/custom-carrier/scripts/apply_to_l4t.sh
bsp/custom-carrier/scripts/build_typec_support.sh
tools/flash_recomputer_j3010.sh
tools/flash_recomputer_j3011.sh
tools/flash_custom_carrier_no_eeprom.sh
tools/flash_custom_carrier_firmware_only.sh
scripts/camera_bringup_commands/test_l640_thermal_uvc.sh
scripts/camera_bringup_commands/hikrobot_mvs_snapshot.cpp
```

## 16. 最终结论

这次联调最重要的结果，不只是“板子点亮、USB 能用、相机能出图”，而是建立了一套可恢复、可重复、可验证的 Jetson 自研底板 bring-up 方法：

- 用 USB ID 和 CVM SKU 识别核心板，不按底板名称猜测。
- 用 no-EEPROM MB2 BCT 解决无 CVB EEPROM 的启动前置条件。
- 把刷机 Recovery 路径和运行态 Host 路径分开设计。
- 用双内核、双 DTB 菜单保留安全回退。
- 用 USB 拓扑、运行态设备树、驱动日志和样图形成证据闭环。
- 把基础取流与厂家完整功能、短测与稳定性验收严格区分。

在此基础上，后续 UART/RS-422、相机厂家控制能力和长期稳定性工作，都可以沿用同样的分层定位和单变量验证方法继续推进。
