---
title: 设备树问题排查方法：不要只盯着 dts
date: 2026-04-26
summary: 设备树问题通常不是单纯写错一个属性，而是硬件连接、binding、驱动匹配、资源获取和 probe 时序共同作用的结果。
category: Device Tree
tags: [device-tree, driver, bringup]
---

设备树问题看起来像文本问题，实际是硬件、驱动和内核框架之间的接口问题。很多排查会卡在一个误区：只盯着 `.dts` 文件看，认为属性名对了、地址写了、compatible 填了，问题就应该解决。

但内核并不直接理解“这块板子应该这样工作”。它只按照设备树描述创建设备，再由驱动按 binding 解释资源。如果描述和硬件不一致，或者描述和驱动期望不一致，probe 失败只是最后的表现。

## 先确认设备有没有被创建

排查设备树问题，第一步不是看驱动，而是确认设备是否进入了内核设备模型。

常用检查点：

```sh
ls /sys/firmware/devicetree/base
ls /sys/bus/platform/devices
dmesg | grep -i "of:"
dmesg | grep -i "probe"
```

如果设备没有出现，重点看：

- 节点路径是否在实际加载的 dtb 中
- `status` 是否为 `okay`
- 父节点是否启用
- `compatible` 是否存在
- 地址单元 `#address-cells` 和 `#size-cells` 是否匹配
- overlay 是否真正应用

这里有一个常见陷阱：源码里的 `.dts` 正确，不代表运行时加载的 `.dtb` 正确。调试时应该反编译运行中的 dtb 或检查 `/sys/firmware/devicetree/base`，不要只看源码。

## compatible 是匹配入口，不是注释

`compatible` 决定驱动匹配。它不是给人看的注释，而是设备和驱动建立关系的入口。

驱动里通常会有类似：

```c
static const struct of_device_id foo_of_match[] = {
        { .compatible = "vendor,foo-v2" },
        { .compatible = "vendor,foo-v1" },
        { }
};
```

设备树里如果写成：

```dts
compatible = "vendor,foo";
```

驱动可能根本不会 probe。更隐蔽的情况是写了一个能匹配的通用 compatible，但硬件实际是另一个版本，驱动按错误版本解释寄存器布局，最后表现成 timeout、IRQ 不来、DMA 不工作。

推荐做法是把 compatible 写成从具体到通用：

```dts
compatible = "vendor,foo-v2", "vendor,foo";
```

但前提是 binding 和驱动真的支持这种兼容关系。

## reg 错了不一定马上崩

`reg` 属性错误是 bring-up 中很常见的问题。它可能导致：

- `devm_platform_ioremap_resource()` 失败
- 驱动访问到错误寄存器区域
- 多个设备资源重叠
- 访问被总线返回错误
- 写寄存器没有效果但不报错

如果驱动 probe 成功但功能不工作，要检查 `/proc/iomem` 和驱动打印的资源范围。不要只看 dts 中写的地址，要确认内核最终解析出来的资源。

地址相关问题还要注意父总线的 `ranges`。很多外设节点的地址不是 CPU 物理地址，而是相对父总线的地址。如果 `ranges` 错了，子节点 reg 看起来正确，转换后的资源仍然可能错。

## 中断问题要分三层看

中断不来时，不要只改 `interrupts` 属性。至少要分三层：

1. 设备是否真的拉了中断线
2. interrupt-controller 和 irq domain 是否正确
3. 驱动是否正确 request 和 enable

设备树侧重点包括：

- `interrupt-parent` 是否指向正确控制器
- `interrupts` 或 `interrupts-extended` 格式是否符合 binding
- 触发类型是否正确，edge 和 level 不能随便猜
- GPIO 中断是否需要 pinctrl 配置
- 中断控制器本身是否启用

驱动侧还要看 `platform_get_irq()` 返回值。很多驱动没有打印具体 IRQ 号，导致排查时不知道它到底拿到了什么。

建议临时加一行明确日志：

```c
dev_info(dev, "irq=%d\n", irq);
```

这类日志虽然简单，但能快速区分“设备树没解析到 IRQ”和“解析到了但硬件不触发”。

## pinctrl 经常是沉默的根因

很多外设问题最后不是驱动逻辑，也不是寄存器地址，而是 pinmux 或 pinconf。

典型表现：

- I2C 扫不到设备
- SPI 有 clock 没有 data
- UART TX 有输出 RX 没输入
- GPIO 中断不触发
- RGMII/RMII 网络不稳定

设备树里有 pinctrl 节点，不代表已经生效。要确认设备节点引用了正确状态：

```dts
pinctrl-names = "default";
pinctrl-0 = <&foo_pins>;
```

如果涉及低功耗，还要看 `sleep` 状态是否切换后无法恢复。驱动 runtime PM、系统 suspend/resume 和 pinctrl state 之间的关系，经常会引入只在休眠后出现的问题。

## clock 和 reset 要看顺序

时钟和复位问题通常表现为 timeout。驱动写了寄存器，但硬件没有响应；等状态位超时后，日志只留下一个 `timeout waiting for ready`。

排查时要确认：

- clock 名称和驱动 `devm_clk_get()` 期望一致
- reset line 是否存在且极性正确
- enable clock 和 deassert reset 顺序是否符合手册
- 是否还有 bus clock、apb clock、core clock 多路时钟
- 固件或 bootloader 是否提前打开了某些资源，掩盖了内核问题

一个危险信号是：冷启动失败，重启成功。这通常说明硬件复位、时钟默认状态或 bootloader 残留状态影响了内核行为。

## binding 是约束，不是文档摆设

现代内核里，设备树 binding schema 很重要。它不仅说明属性含义，还能在编译或检查阶段发现错误。

如果你在维护可长期演进的 BSP，不建议只靠人工 review dts。至少应该跑：

```sh
make dtbs_check
```

schema 能发现很多肉眼容易漏的问题：

- 属性名拼错
- `reg` cell 数量不对
- clock/reset 数量不匹配
- 缺少 required 属性
- 使用了 binding 未定义的私有属性

当然，schema 不能证明硬件连接正确。它只能证明描述形式符合约束。硬件真实连线仍然要靠原理图和寄存器验证。

## 运行时 dtb 比源码更可信

设备树排查最好始终遵循这个优先级：

1. 运行中的 `/sys/firmware/devicetree/base`
2. bootloader 实际加载的 dtb
3. 构建产物中的 dtb
4. 源码中的 dts

如果系统支持多个 dtb、overlay、bootloader 动态修改节点，源码就更不能直接当作事实。很多问题最后发现不是 dts 写错，而是板子启动时加载了另一个 dtb。

## 一份排查清单

遇到设备树相关问题，可以按这个顺序走：

```text
1. 确认运行时 dtb 是否包含目标节点
2. 确认 status 和父节点状态
3. 确认 compatible 是否能匹配驱动
4. 确认 reg 解析出的资源范围
5. 确认 irq 编号和触发类型
6. 确认 pinctrl default/sleep 状态
7. 确认 clock/reset/regulator 是否齐全
8. 确认 probe defer 是否长期未解决
9. 对照 binding schema 做 dtbs_check
10. 对照原理图确认硬件连接
```

这份清单不复杂，但能避免一上来就在 dts 里盲改属性。

## 结论

设备树不是“让驱动跑起来的配置文件”，而是硬件事实和内核设备模型之间的契约。排查设备树问题时，要同时看运行时 dtb、driver match、resource parse、probe log、binding schema 和硬件原理图。

只改 dts 很快，但如果不知道内核最后如何解释这些属性，改动就只是试错。真正可靠的方法，是把设备树当成接口来调试。
