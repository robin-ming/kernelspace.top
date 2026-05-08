---
title: Linux 启动流程调试：从 bootloader 到第一个 userspace
date: 2026-05-01
summary: 启动失败要按阶段定位：镜像加载、解压、early console、设备树、initcall、rootfs 和 init，每一段都有不同的证据来源。
category: Boot Flow
tags: [boot, initcall, rootfs]
---

Linux 启动失败经常被描述成一句话：“板子起不来”。但从 bootloader 跳到内核，到第一个 userspace 进程运行，中间有很多阶段。不同阶段失败，证据来源和排查方法完全不同。

如果不先判断卡在哪一段，就很容易在错误层面浪费时间。比如 rootfs 挂载失败时去改设备树 pinctrl，或者 early boot 卡死时去看 systemd 日志。

## 先按阶段切分

一个简化启动链路：

```text
ROM / SPL
  bootloader
    load kernel image
    load dtb / initrd
    jump to kernel
      decompress / relocate
      early setup
      start_kernel()
      initcalls
      mount rootfs
      exec init
```

排查时先回答：

- bootloader 是否能加载内核
- 内核是否有第一行日志
- early console 是否工作
- 是否进入 `start_kernel`
- initcall 是否卡住
- rootfs 是否挂载
- `/sbin/init` 是否执行

每个问题的答案都会把排查范围缩小一大截。

## 没有任何内核日志

如果 bootloader 打印正常，但内核没有任何输出，可能原因包括：

- kernel image 格式不对
- load address 错误
- entry address 错误
- boot protocol 不匹配
- decompressor 早期崩溃
- early console 未配置
- 串口时钟或 pinmux 被改坏
- 设备树传参错误

第一步是确认 bootloader 加载地址和启动命令。比如 U-Boot 中：

```text
booti ${kernel_addr_r} ${ramdisk_addr_r} ${fdt_addr_r}
```

要确认 kernel、initrd、dtb 没有重叠，地址符合平台要求。

如果怀疑只是串口没输出，可以加 early console：

```text
earlycon console=ttyS0,115200
```

具体参数要看平台串口驱动和设备树。

## 有 early log 但很快卡住

如果能看到早期日志，但卡在 `start_kernel` 前后，要注意：

- 时钟初始化
- MMU/page table
- interrupt controller
- timer
- early memory setup
- reserved memory
- command line

这类问题通常还没有进入完整驱动模型，普通设备驱动日志不会出现。需要依赖 earlycon、initcall_debug 之前的日志、平台代码和启动参数。

如果卡在 timer 或 sched clock 附近，要检查时钟源和中断控制器。系统没有可靠 timer，后面很多机制都会异常。

## 用 initcall_debug 找卡住的驱动

如果内核能跑到 initcall 阶段，但中途卡住，可以加：

```text
initcall_debug
```

日志会显示每个 initcall 的开始和返回：

```text
calling  foo_driver_init+0x0/0x100 @ 1
initcall foo_driver_init+0x0/0x100 returned 0 after 1234 usecs
```

如果最后一条是 `calling` 但没有 `returned`，说明卡在这个 initcall 或它调用的路径里。

注意 initcall 不是只有驱动 probe。它可能是子系统初始化、总线注册、文件系统、网络协议栈等。要看函数所属模块和 initcall level。

## probe defer 可能拖慢启动

启动过程中大量 `-EPROBE_DEFER` 可能导致设备晚起来。它不一定阻塞启动，但会影响关键设备。

例如 rootfs 在 eMMC 上，如果 mmc host 依赖 regulator 或 clock，而 provider 没 ready，就可能导致 rootfs 迟迟不可用。

检查：

```sh
cat /sys/kernel/debug/devices_deferred
```

如果系统还没进 userspace，就只能依赖 dmesg。建议关键 provider 驱动保留清晰日志。

## rootfs 挂载失败

rootfs 挂载失败通常会看到：

```text
VFS: Cannot open root device
Kernel panic - not syncing: VFS: Unable to mount root fs
```

要检查：

- `root=` 参数是否正确
- 存储驱动是否内建
- 文件系统驱动是否内建
- 分区是否存在
- initramfs 是否包含必要模块
- rootwait 是否需要

常用参数：

```text
root=/dev/mmcblk0p2 rootwait rw
```

如果驱动是模块，但 rootfs 还没挂载，模块当然无法加载。根文件系统所依赖的存储和文件系统驱动通常要内建。

## 找不到 init

如果 rootfs 挂载成功，但报：

```text
No working init found
```

说明内核已经尝试启动 userspace，但找不到可执行 init。

检查：

- `/sbin/init`
- `/etc/init`
- `/bin/init`
- `/bin/sh`
- 可执行权限
- 动态链接器是否存在
- 架构是否匹配

一个常见问题是 init 文件存在，但动态链接器缺失，执行时也会失败。可以用静态 busybox 做最小验证。

## systemd 阶段属于 userspace

如果已经看到 systemd 日志，问题就不再是内核启动本身，而是 userspace 初始化。

这时应该用：

```sh
journalctl -b
systemctl status
systemd-analyze blame
```

不要再只盯着内核 dmesg。内核已经把控制权交给 userspace，剩下的问题可能是 service、mount unit、udev rule、权限、依赖顺序。

## 启动调试参数清单

```text
earlycon
console=ttyS0,115200
ignore_loglevel
loglevel=8
initcall_debug
dyndbg="file drivers/foo/* +p"
rootwait
panic=10
init=/bin/sh
```

这些参数不要一股脑全加。每个参数都应该服务于一个明确问题：需要早期串口、需要更多日志、需要定位 initcall、需要绕过 systemd。

## 结论

启动问题排查要按阶段推进。没有内核日志，就先看镜像、入口和 early console；卡在 initcall，就用 `initcall_debug`；rootfs 挂载失败，就看 `root=`、存储驱动和文件系统；进入 systemd 后，就切换到 userspace 调试方法。

“起不来”不是一个问题，它是一段启动链路上某个阶段的失败。先定位阶段，才有可能快速定位根因。
