---
title: 设备树调试：运行时 dtb 比源码更重要
date: 2025-04-08
summary: 设备树问题不能只看仓库里的 dts，真正参与启动的是运行时加载的 dtb 和内核最终解析出的设备模型。
category: Device Tree
tags: [device-tree, dtb, bringup]
---

设备树调试中最常见的误判之一，是一直盯着源码里的 `.dts` 看，却没有确认板子真正加载了哪个 `.dtb`。

源码正确不代表运行时正确。构建系统可能用了旧文件，bootloader 可能加载了另一个分区里的 dtb，overlay 可能没有应用，甚至启动参数里指定的路径也可能不是你以为的那个。

## 先确认运行时内容

内核启动后，应该优先看运行时设备树：

```sh
ls /sys/firmware/devicetree/base
```

如果系统提供 `dtc`，可以把运行时设备树导出来：

```sh
dtc -I fs -O dts /sys/firmware/devicetree/base > running.dts
```

然后再和源码中的 dts 对比。这个动作经常能直接发现问题，比如节点根本不存在、`status` 没改成 `okay`、pinctrl 引用丢了，或者 overlay 没生效。

## 看设备模型，而不是只看文本

设备树只是输入，内核真正工作的是解析后的设备模型。节点存在不代表设备已经创建，设备创建也不代表驱动已经匹配。

可以检查：

```sh
ls /sys/bus/platform/devices
ls /sys/bus/platform/drivers
dmesg | grep -i probe
```

如果设备没有出现在 platform devices 里，说明问题还在设备树解析或父节点启用阶段。如果设备出现了但没有绑定驱动，就要看 `compatible` 和驱动 match table。

## compatible 要和驱动一起看

`compatible` 不是随便写一个字符串。它必须和驱动里的 `of_device_id` 匹配。

排查时应该同时看：

- dts 中的 compatible
- driver 中的 match table
- binding 文档允许的字符串
- 是否有 fallback compatible

有些问题不是完全不匹配，而是匹配到了错误版本。驱动 probe 成功，但按错误寄存器布局或错误 feature set 工作，后面表现成 timeout 或数据异常。

## overlay 要确认应用顺序

overlay 场景更容易混乱。多个 overlay 修改同一个节点时，最终结果取决于加载顺序。

需要确认：

- overlay 文件是否被 bootloader 加载
- overlay 是否应用成功
- 有没有 fragment target 写错
- 有没有后加载的 overlay 覆盖了前面的属性
- `__symbols__` 是否存在并能被引用

如果运行时 dts 里没有期望的属性，就不要继续调驱动。先把 dtb 链路查清楚。

## 结尾

设备树调试的核心原则是：源码只是候选输入，运行时 dtb 才是事实。

先确认板子实际加载了什么，再看内核解析出了什么，最后才进入驱动逻辑。这个顺序能减少很多无效排查。
