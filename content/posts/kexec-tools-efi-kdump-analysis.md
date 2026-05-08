# LoongnixServer23 kexec-tools EFI kdump 问题分析记录

## 1. 背景

LoongnixServer23 在 LoongArch 平台上原先主要使用 ELF 格式内核作为 `/boot/vmlinuz-*`。
为了支持 EFI/Secure Boot 场景，内核 RPM 额外打包了 EFI 格式内核：

```text
/boot/vmlinuz-<kernel-release>-efi
```

EFI 内核可以正常由固件/GRUB 启动，但进入系统后，原有 `kexec-tools` 在 kdump 场景下不能正确处理
该 EFI 内核，导致 kdump arming 或 crash capture kernel 启动失败。

本次分析和修复目标是：

1. 让 `kexec-tools` 支持 LoongArch EFI zboot 内核。
2. 修复 EFI kdump 捕获内核跳转后不继续启动的问题。
3. 保持补丁最小化，避免把临时 workaround 一起提交。

最终提交到 `kexec-tools-LoongnixServer23` 的 commit 为：

```text
a492a7f5b90d LoongArch: support EFI zboot kernels for kdump
```

最终本地改动只包含：

```text
LoongArch-support-PE-zboot-kernel-images.patch
kexec-tools.spec
```

## 2. 初始现象

EFI 内核启动后，`kdump.service` 曾出现两类问题。

### 2.1 rtc_efi 模块配置导致 kdump 启动失败

系统日志中出现：

```text
kdump: Error: (builtin) not found.
kdump: Starting kdump: [FAILED]
```

当时运行内核为：

```text
6.6.52-1.10.lns23.loongarch64
```

检查结果显示：

```text
modinfo --filename rtc_efi
(builtin)

CONFIG_RTC_DRV_EFI=y
```

而 `kdump.conf` 中存在：

```text
extra_modules rtc_efi
```

因此，问题不是 EFI kdump 主问题，而是当前运行内核中 `rtc_efi` 为 builtin，
`kdumpctl` 按额外模块处理时拿到 `(builtin)`，后续按模块路径使用导致失败。

后来确认最新内核源码 tag `6.6.52-1.11` 中：

```text
CONFIG_RTC_DRV_EFI=m
```

所以最终 kexec-tools 补丁中不再修改 `kdump.conf`，也不提交删除 `extra_modules rtc_efi` 的 workaround。

### 2.2 EFI kdump capture kernel 无法继续启动

`kdumpctl` 能够加载 crash kernel 后，手动触发 crash：

```bash
echo c > /proc/sysrq-trigger
```

崩溃内核日志显示已跳转：

```text
Starting crashdump kernel...
EFI boot flag 0x1
Command line at 0x9000000000108000
System table at 0xfdf50018
We will call new kernel at 0x90000000b9e41000
Bye ...
```

但 EFI 捕获内核没有继续打印后续启动日志。对比 ELF 捕获内核路径，ELF 是正常的。

## 3. EFI 内核格式识别问题

检查 EFI 内核文件头后确认，该内核不是普通 PE payload，而是 EFI zboot 格式：

```text
MZ ... zimg ... gzip
```

也就是说，它是一个带 PE/COFF wrapper 的压缩内核，真正的 PE 内核 payload 需要先从 zboot header
中取出并解压，再交给已有 PE loader 处理。

旧 `kexec-tools` 对 LoongArch 只注册了：

```text
elf-loongarch
pei-loongarch
```

没有注册：

```text
pez-loongarch
```

因此 EFI zboot 内核会落入普通 `pei-loongarch` 逻辑，被当成普通 LoongArch PE image 解析。
结果是 image header 字段解析错误，例如：

```text
image_size: 0
text_offset: 0
kernel_entry: invalid/high address
kexec_load failed: Cannot assign requested address
```

该问题对应上游 kexec-tools 已有的 PE zboot 支持思路：

1. 增加通用 `kexec-pe-zboot.c`。
2. 根据 zboot header 找到 compressed payload。
3. 支持 gzip/lzma 解压。
4. 将解压后的内核 buffer 交给架构已有 PE loader。
5. LoongArch 注册 `pez-loongarch` loader。

本次补丁就是基于上游实现，适配 LoongnixServer23 使用的 kexec-tools 2.0.26 代码结构。

## 4. PE zboot 修复内容

补丁新增或修改的主要内容：

```text
include/kexec-pe-zboot.h
kexec/kexec-pe-zboot.c
kexec/arch/loongarch/kexec-pez-loongarch.c
kexec/arch/loongarch/Makefile
kexec/arch/loongarch/kexec-loongarch.c
kexec/arch/loongarch/kexec-loongarch.h
kexec/Makefile
include/Makefile
```

关键逻辑：

```text
pez_loongarch_probe()
  -> 检查 PE signature
  -> 检查 zboot image_type == "zimg"
  -> 调用 pez_prepare()

pez_prepare()
  -> 读取 payload_offset/payload_size
  -> 解压 gzip/lzma payload
  -> 生成解压后的临时 kernel fd

pez_loongarch_load()
  -> 读取解压后的 kernel buffer
  -> 调用 pei_loongarch_load()
```

这样 EFI zboot 内核最终仍走已有的 LoongArch PE loader，不需要重新实现 PE 加载逻辑。

## 5. crash PE 放置地址问题

补齐 PE zboot 后，`kdumpctl` 能成功解压并调用 PE loader，但捕获内核跳转后仍不继续启动。

加载日志中可见：

```text
pei_loongarch_load: kernel_segment: 00000000b9000000
pei_loongarch_load: kernel_entry:   00000000b9e41000
pei_loongarch_load: text_offset:    0000000000200000
```

当前 crash reserved 起点为：

```text
crash_reserved_start = 0xb8800000
```

LoongArch PE 内核的正确放置关系是：

```text
kernel_segment = crash_reserved_start + text_offset
```

代入当前值：

```text
0xb8800000 + 0x200000 = 0xb8a00000
```

也就是说，期望的 kernel segment 是：

```text
0xb8a00000
```

但实际加载到了：

```text
0xb9000000
```

原因是 LoongnixServer23 现有补丁栈中，crash kernel segment 对齐被改成了 16MiB：

```c
hole = _ALIGN_UP(hole, MiB(16));
```

当 `crash_reserved_start + text_offset` 不是 16MiB 对齐时，这个对齐会把 PE image 从 link placement
移动到另一个地址。对于旧 `kexec_load` 路径，PE 内核并不会像完整 EFI boot 那样重新做运行时重定位，
因此 capture kernel 的入口和内部地址关系被破坏，表现为跳转后停止在 `Bye ...` 之后。

修复是将该路径改回上游 1MiB 对齐：

```c
hole = _ALIGN_UP(hole, MiB(1));
```

修复后日志变为：

```text
pei_loongarch_load: kernel_segment: 00000000b8a00000
pei_loongarch_load: kernel_entry:   00000000b9e41000
pei_loongarch_load: image_size:     00000000034e0000
pei_loongarch_load: text_offset:    0000000000200000
```

随后 EFI capture kernel 能继续启动并完成 vmcore dump。

## 6. 关于 16MiB 对齐和 initrd 互踩的疑问

你提出的关键疑问是：之前把 crash PE 路径对齐到 16MiB，印象中是为了避免 kernel 和 initrd 互踩。
改回 1MiB 是否有风险？

结论：

1. 这次 16MiB 对齐实际破坏的是 PE kernel 的 link placement。
2. kernel 和 initrd 是否互踩，不应该靠移动 PE kernel link placement 解决。
3. 当前 kexec-tools 的 segment 放置会通过 `add_buffer()` 查找 hole，并以已有 segment 为约束。
4. 如果 crashkernel 空间不足，正常应表现为 hole 查找失败或 `kexec_load` 失败，而不是静默互踩。

当前成功加载时的 segment 布局为：

```text
segment[0].mem   = 0xb8a00000
segment[0].memsz = 0x34e0000

segment[1].mem   = 0xbbee0000
segment[1].memsz = 0x3fd0000

segment[2].mem   = 0xbfeb0000
segment[2].memsz = 0x4000

segment[3].mem   = 0xf87fc000
segment[3].memsz = 0x4000
```

用半开区间看：

```text
kernel:  [0xb8a00000, 0xbbee0000)
initrd:  [0xbbee0000, 0xbfeb0000)
cmdline: [0xbfeb0000, 0xbfeb4000)
```

三者边界相接，但没有重叠。

曾重点关注过 cmdline 是否和 initrd 尾部重叠：

```text
initrd base  = 0xbbee0000
initrd memsz = 0x3fd0000
initrd end   = 0xbfeb0000

cmdline base = 0xbfeb0000
cmdline size = 0x4000
```

这也是半开区间的相邻边界，不是重叠。

如果未来 initrd 变大，cmdline 不应该固定压在当前地址，而应由 `add_buffer()` 根据已有 segment
重新寻找合适位置。若 crashkernel 空间不足，应失败，而不是和 initrd 互踩。

因此，本次不引入 initrd top-down 分配。先保持最小修复：恢复 PE kernel 正确 link placement。

## 7. 关于 loongarch64-fix-kernel-image-size-error.patch 的疑问

你提到 `loongarch64-fix-kernel-image-size-error.patch` 之前似乎也修复过互踩问题。

这类补丁主要关注 LoongArch kernel image size/text offset 等字段计算，避免因 image size 错误导致
segment 范围计算不正确。它解决的是“内核 segment 自身大小描述是否正确”的问题。

本次 16MiB 对齐问题不同：

```text
image_size/text_offset 已经正确
但 kernel_segment 被额外 16MiB 对齐移动了
```

所以即便 `loongarch64-fix-kernel-image-size-error.patch` 已经存在，仍然不能解决 PE image 被放到
错误 link placement 的问题。

两者关系可以理解为：

```text
loongarch64-fix-kernel-image-size-error.patch
  -> 确保 image_size/text_offset 等基础信息正确

本次 crash PE placement 修复
  -> 确保 crash PE image 按 crash_reserved_start + text_offset 放置
```

## 8. 关于 KASLR/运行时重定位的疑问

如果开启运行时重定位或 KASLR，PE 内核理论上可能对加载地址有更强适应能力。
但本次验证环境命令行包含：

```text
nokaslr
```

你也确认不会开启运行时重定位/KASLR。因此本次分析按固定 link placement 处理即可。

在这个前提下，`kernel_segment = crash_reserved_start + text_offset` 是必须保证的条件。

## 9. 关于 rtc_efi 的最终处理

最初为了快速验证 kdump，曾临时删除 `kdump.conf` 中：

```text
extra_modules rtc_efi
```

但这不是最终补丁的一部分。

原因：

1. 旧内核 `6.6.52-1.10` 中 `rtc_efi=y`，确实会触发 `(builtin) not found`。
2. 最新内核 `6.6.52-1.11` 中 `rtc_efi=m`，该配置行可以继续保留。
3. 当前要提交的是 kexec-tools 对 EFI zboot kdump 的支持，不应混入临时配置 workaround。

最终 kexec-tools 补丁中：

```text
kdump.conf 不修改
extra_modules rtc_efi 保留
```

## 10. 最终补丁形态

最终采用一个补丁文件，不拆分两个补丁：

```text
LoongArch-support-PE-zboot-kernel-images.patch
```

该补丁同时包含：

1. LoongArch PE zboot loader 支持。
2. crash PE kernel segment 对齐从 16MiB 改回 1MiB。

之所以合为一个补丁，是因为两者共同修复同一个用户可见问题：

```text
EFI 内核作为 kdump capture kernel 时无法正常完成 kdump
```

单独只有 zboot 支持，会解决 arming/解压问题，但 capture kernel 仍可能因错误放置地址无法启动。
单独只有 1MiB 对齐，也不能让旧 kexec-tools 识别 EFI zboot 内核。

因此合并成一个补丁更便于提交说明：

```text
LoongArch: support PE zboot kernels for kdump
```

## 11. 验证记录

### 11.1 构建验证

在验证机上使用干净 `kdump.conf` 重新构建：

```bash
rpmbuild -ba --nodeps kexec-tools.spec
```

结果：

```text
ret:0
Wrote: /root/rpmbuild/RPMS/loongarch64/kexec-tools-2.0.26-11.lns23.loongarch64.rpm
```

### 11.2 kdump arming 验证

安装修复后的 kexec-tools 后，`kdumpctl status`：

```text
kdump: Kdump is operational
```

加载日志显示走 PE zboot 解压路径：

```text
pez_loongarch_probe: PROBE.
pez_prepare: decompressed size 55443456
pez_prepare: done
pei_loongarch_load: kernel_segment: 00000000b8a00000
pei_loongarch_load: kernel_entry:   00000000b9e41000
pei_loongarch_load: image_size:     00000000034e0000
pei_loongarch_load: text_offset:    0000000000200000
pei_loongarch_load: PE format:      yes
```

### 11.3 crash dump 验证

触发 crash 后，EFI capture kernel 能继续执行并完成 dump。
验证目录中生成 vmcore、kexec dmesg 和 vmcore dmesg：

```text
/var/crash/127.0.0.1-2026-04-28-10:10:28/vmcore
/var/crash/127.0.0.1-2026-04-28-10:10:28/kexec-dmesg.log
/var/crash/127.0.0.1-2026-04-28-10:10:28/vmcore-dmesg.txt
```

需要注意：早先有一次 dump 是 ELF capture kernel 完成的，不能作为 EFI 修复依据。
后续确认 EFI capture kernel 成功，是在 1MiB placement 修复后完成的。

## 12. 当前结论

本次 kdump EFI 问题根因有两层：

1. 旧 kexec-tools 没有 LoongArch PE zboot loader，无法正确解压 EFI zboot kernel。
2. LoongnixServer23 补丁栈把 crash PE segment 对齐到 16MiB，破坏了 PE 内核在 crash reserved
   区域内的 link placement。

最终修复策略是：

1. 引入上游 PE zboot helper。
2. 注册 LoongArch `pez-loongarch` loader。
3. 解压后复用已有 `pei-loongarch` loader。
4. crash PE kernel segment 对齐恢复为 1MiB，保证：

```text
kernel_segment = crash_reserved_start + text_offset
```

最终补丁保持为一个 kexec-tools patch，未混入 `rtc_efi` 配置变更、内核 RPM 打包变更或其他临时验证改动。
