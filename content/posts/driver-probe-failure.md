---
title: 驱动 probe 失败排查：从错误码看资源依赖
date: 2026-05-06
summary: probe 失败不是一个点，而是一条资源依赖链。错误码、defer、devm 生命周期和日志位置决定了排查效率。
tags: [driver, probe, kernel]
---

驱动 probe 失败是内核 bring-up 里最常见的问题之一。它看起来很直接：驱动没有起来，日志里有一个错误码。但真正排查时，经常会变成漫长的试错。

原因在于 probe 不是单个动作，而是一条资源依赖链：设备匹配、内存资源、中断、时钟、复位、电源、pinctrl、DMA、PHY、子设备、固件。链条里任何一环失败，最后都可能表现成 probe 失败。

## 先看错误码

错误码是第一条线索。几个常见错误码含义不同：

- `-ENODEV`：设备不存在、不支持、匹配后主动拒绝
- `-EINVAL`：设备树属性、参数或配置格式错误
- `-ENOMEM`：内存分配失败，也可能是资源管理路径错误
- `-ENXIO`：资源不存在或无法映射
- `-EPROBE_DEFER`：依赖资源尚未 ready
- `-ETIMEDOUT`：硬件状态等待超时
- `-EIO`：底层访问失败，常见于总线或寄存器访问

如果驱动只打印：

```text
probe failed: -22
```

这对排查帮助有限。更好的日志应该告诉你哪个资源失败：

```text
failed to get core clock: -ENOENT
failed to deassert reset: -ETIMEDOUT
failed to request irq 42: -EBUSY
```

错误码要和失败位置一起看。只有错误码，没有上下文，价值会打折。

## EPROBE_DEFER 不是错误，但可能掩盖错误

`-EPROBE_DEFER` 的意思是依赖资源还没有准备好，驱动请求稍后再 probe。比如 regulator、clock、GPIO、PHY、backlight、panel 等资源还没注册。

合理的 defer 是正常机制。但长期 defer 就是问题。

可以检查：

```sh
cat /sys/kernel/debug/devices_deferred
```

如果看到设备一直在 deferred 列表里，要看后面的原因。有些内核版本会显示具体等待的资源，有些只显示设备名。

常见原因：

- provider 驱动没有编进内核或模块没加载
- 设备树 phandle 指向错误
- clock/reset/regulator 名称和驱动期望不一致
- provider 自己 probe 失败
- probe 顺序被模块加载策略影响

不要看到 `-EPROBE_DEFER` 就放过。它是“稍后再试”，不是“没有问题”。

## devm 简化释放，不简化状态机

现代驱动大量使用 `devm_` API，例如：

```c
priv = devm_kzalloc(dev, sizeof(*priv), GFP_KERNEL);
base = devm_platform_ioremap_resource(pdev, 0);
irq = platform_get_irq(pdev, 0);
ret = devm_request_irq(dev, irq, handler, 0, name, priv);
```

`devm_` 能减少错误路径释放代码，但它不能替你设计正确的状态机。

比如：

- request_irq 之前是否已经初始化 handler 需要的数据
- 中断打开之前硬件状态是否清干净
- workqueue 是否可能在 probe 失败后仍然运行
- runtime PM 是否在资源准备前启用
- remove 时是否需要先停止硬件再释放资源

`devm_` 负责生命周期释放，不负责并发顺序。很多 use-after-free 和空指针问题，恰恰出现在“资源会自动释放”的错觉之后。

## probe 日志应该放在关键边界

驱动日志太少，排查会盲；日志太多，长期维护又会污染输出。比较实用的方式是在关键边界打日志：

- match 成功后
- 解析设备树关键属性后
- 获取 clock/reset/regulator 后
- 资源映射后
- 中断申请后
- 硬件初始化前后
- 注册子系统对象前后

例如：

```c
dev_dbg(dev, "mapped regs %pr\n", res);
dev_dbg(dev, "irq=%d\n", irq);
dev_dbg(dev, "rate=%lu\n", clk_get_rate(priv->clk));
```

这些日志不一定默认打开，但在 dynamic debug 下非常有用。

```sh
echo 'file drivers/foo/* +p' > /sys/kernel/debug/dynamic_debug/control
```

一个可维护的驱动，不应该依赖临时 printk 才能知道 probe 到哪一步。

## 硬件 timeout 要回到手册

`-ETIMEDOUT` 是 bring-up 里最容易被误判的错误。驱动等待某个位变成 1，最后超时：

```text
timeout waiting for controller ready
```

这个日志本身只能说明硬件没按预期响应。原因可能很多：

- clock 没开
- reset 没释放
- 电源域没上电
- 寄存器地址错
- pinmux 错
- 固件没加载
- 外部 PHY 没 ready
- 需要先清状态位
- 写寄存器顺序不符合手册

遇到 timeout，应该回到硬件初始化序列，而不是只加大 timeout。加大 timeout 只有在硬件确实慢、手册允许、且能解释时才合理。

## 错误路径也要测试

probe 成功路径通常会被反复测试，错误路径却容易被忽视。错误路径不干净，会导致二次 probe、模块卸载、热插拔、suspend/resume 时出问题。

可以主动构造失败：

- 注释某个 clock 节点
- 改错 regulator 名称
- 让 `platform_get_irq()` 失败
- 模拟 firmware 加载失败
- 强制某个资源返回 `-EPROBE_DEFER`

观察驱动是否：

- 留下已打开的 clock
- 留下已释放但仍会使用的对象
- 注册了未注销的子对象
- 开了中断但没有关闭
- 启用了 runtime PM 但没有 disable

很多“偶现 panic”其实是 probe 错误路径长期未测试。

## probe 和 remove 要成对思考

写 probe 时就应该想 remove。初始化顺序和释放顺序应该成镜像关系：

```text
probe:
  allocate priv
  map regs
  get clock
  deassert reset
  init hardware
  request irq
  register subsystem object

remove:
  unregister subsystem object
  disable irq or stop hardware
  assert reset
  disable clock
  release managed resources
```

并不是所有资源都需要手工释放，但逻辑状态一定要关闭。尤其是硬件还可能发中断、DMA 还可能写内存、work 还可能排队时，不能只依赖 devm。

## 一份 probe 排查模板

遇到 probe 失败，可以按这个模板记录：

```text
设备：
  节点路径、compatible、运行时 dtb 是否存在

匹配：
  驱动 of_match_table 是否匹配

失败位置：
  具体 API、错误码、日志上下文

资源：
  reg、irq、clock、reset、regulator、pinctrl、dma、phy

依赖：
  是否 EPROBE_DEFER，provider 是否 ready

硬件状态：
  clock rate、reset 状态、寄存器读写是否有效

下一步：
  加 dynamic debug、验证 dtb、对照手册初始化序列
```

模板的意义是逼自己把“驱动没起来”拆成可验证的链条。

## 结论

probe 失败不是一个错误点，而是资源依赖链断在某处。高效排查依赖三个东西：准确的错误码、清晰的失败位置、对资源生命周期的理解。

驱动能 probe 成功只是第一步。真正可靠的驱动，还要在 probe defer、错误路径、remove、runtime PM 和并发中断下都保持状态一致。
