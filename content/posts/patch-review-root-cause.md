---
title: 补丁复盘怎么写：从现象修复到根因闭环
date: 2026-01-27
summary: 一个好补丁不只改代码，还应该能解释现象、根因、影响范围、验证方法和为什么这个修法是合适的。
category: Patch Notes
tags: [patch, review, workflow]
---

内核工程里，补丁本身只是最终产物。一个补丁是否可靠，很大程度取决于它背后的分析是否闭环。

很多修复看起来很小：加一个判空、调整一个顺序、补一个锁、延后一次初始化。但如果 commit message 只写“fix crash”或“fix probe fail”，reviewer 很难判断这个修复是否正确，更难判断有没有隐藏副作用。

补丁复盘的目标，是把“我改了什么”提升到“为什么这是正确的修复”。

## 先区分现象和根因

现象是用户看到的结果：

- 系统 panic
- 设备 probe 失败
- 网络不通
- suspend 后无法恢复
- 偶现 timeout

根因是导致现象的机制：

- 中断在私有数据初始化前打开
- 错误路径遗漏关闭 clock
- runtime suspend 后 workqueue 仍访问寄存器
- 设备树描述的 reset 极性和硬件不一致
- 引用计数在失败路径多 put 一次

补丁说明里要避免把现象当根因。例如：

```text
Bad:
  Fix NULL pointer dereference in foo_irq_handler.

Better:
  foo_irq_handler can run before foo->bar is initialized because the
  interrupt is unmasked before hardware state is fully configured.
```

前者只说明崩在哪里，后者说明为什么会崩。

## 描述触发路径

一个好的修复说明应该能让 reviewer 在脑子里重放问题路径：

```text
foo_probe()
  request_irq()
  enable hardware interrupt
  initialize foo->bar

hardware interrupt
  foo_irq_handler()
    dereference foo->bar
```

如果中断可能在 `foo->bar` 初始化之前到来，路径就成立。修复可以是调整初始化顺序，也可以是延后 unmask 中断，或者在 handler 中明确状态检查。哪种方式更合理，要看硬件和子系统约定。

只写“add NULL check”通常不够，因为 reviewer 会问：为什么这个对象允许为空？为空时丢弃中断是否安全？后面是否会恢复？有没有掩盖更早的初始化错误？

## 解释为什么不选其它方案

补丁复盘不一定要长，但关键取舍要说清楚。比如：

```text
Do not add a NULL check in the interrupt handler because the interrupt
must not be enabled before the descriptor is ready. Silently ignoring the
interrupt would hide an invalid initialization order and may drop a real
hardware event.
```

这段说明能体现修复意图：问题不是 handler 容错不足，而是初始化顺序错误。

内核补丁常见取舍包括：

- 判空还是修生命周期
- 加锁还是调整调用顺序
- disable IRQ 还是 stop hardware
- runtime PM get/put 放在哪一层
- 修 dts 还是修 driver fallback
- backport 时保守修复还是同步上游重构

这些取舍如果不写，reviewer 只能从 diff 猜。

## Fixes 标签要准确

如果补丁修复了某个已提交的 bug，应该加 `Fixes`：

```text
Fixes: 123456789abc ("foo: add interrupt support")
```

`Fixes` 的意义不仅是标记责任提交，也会影响 stable backport 和自动化工具判断。不要随便找一个相关提交填进去。应该找真正引入问题的提交。

判断引入点时要看：

- 问题路径是不是从这个提交开始存在
- 之前代码是否不可能触发
- 是否有后续提交改变了触发条件
- 是否是配置或设备树变化暴露了旧问题

如果无法确定，不要硬填。错误的 `Fixes` 会误导维护者。

## Cc stable 要谨慎

不是所有 bug fix 都应该进 stable。一般适合 stable 的修复应该：

- 修真实 bug
- 影响已发布版本
- 补丁小而清晰
- 风险可控
- 不依赖大规模重构

如果修复需要改变接口、调整架构、引入新机制，通常不适合直接 stable。可以为 stable 准备更保守的 backport。

稳定分支最看重的是风险控制。一个理论上更优雅但影响面大的修复，不一定适合 stable。

## 验证不能只写编译通过

`build tested` 只是最低线。修复类补丁最好写清楚验证方式：

```text
Tested:
  - Booted on board X for 50 cycles
  - Injected probe defer for regulator path
  - Triggered suspend/resume 200 times
  - Verified no IRQ is reported before descriptor initialization
```

验证要对应根因。如果根因是中断时序，就要验证中断打开顺序；如果根因是 remove 并发，就要验证卸载、热插拔或错误路径；如果根因是内存泄漏，就要验证资源释放。

编译通过不能证明 bug 修复，只能证明补丁能编译。

## 一个补丁说明模板

可以用这个结构写修复说明：

```text
Problem:
  用户可见现象和触发条件。

Root cause:
  代码路径、状态机或资源生命周期上的根因。

Fix:
  补丁具体改变了什么。

Why:
  为什么这个改法符合硬件/框架/生命周期约束。

Validation:
  如何验证修复有效，是否覆盖回归场景。
```

真正提交到内核时不一定保留这些标题，但写作时按这个结构思考，会让 commit message 更扎实。

## 小 diff 也要有大上下文

有些补丁 diff 只有几行，但上下文很大。例如：

```diff
- enable_irq(foo->irq);
  foo->desc = desc;
+ enable_irq(foo->irq);
```

这个 diff 很小，但它改变的是中断可见性和对象初始化之间的顺序。commit message 应该解释这个顺序为什么重要。

小 diff 如果说明不足，reviewer 可能低估风险；说明充分，小 diff 反而会显得非常可靠。

## 结论

补丁复盘的核心是闭环：现象能否被根因解释，根因能否被代码路径证明，修复能否消除这个路径，验证能否覆盖触发条件。

一个好补丁不仅让系统不再崩，也让后来的人知道为什么它不再崩。对长期维护来说，这比多写几行代码更重要。
