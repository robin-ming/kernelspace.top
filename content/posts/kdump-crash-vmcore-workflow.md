---
title: kdump 和 crash 分析流程：让 vmcore 变成证据
date: 2026-04-20
summary: vmcore 的价值不在于文件本身，而在于能否用 crash 把崩溃时的任务、内存、锁和对象状态还原成可验证证据。
category: Kdump / Crash
tags: [kdump, crash, vmcore]
---

有 vmcore 不等于会分析崩溃。vmcore 只是崩溃瞬间的一份内存快照，真正有价值的是从这份快照里还原出任务状态、调用栈、对象内容、锁关系和内存分配信息。

kdump 和 crash 的工作流，本质上是把“系统已经死了”变成“系统死前处在什么状态”。

## kdump 要先保证能抓到

很多团队在真正遇到问题时才发现 kdump 没配好。典型问题包括：

- crashkernel 内存没预留
- capture kernel 启不起来
- dump 目标分区空间不足
- initramfs 缺驱动
- panic 后没有触发 kdump
- secure boot 或内核参数影响加载

上线前应该主动测试：

```sh
echo c > /proc/sysrq-trigger
```

测试时要确认：

- 系统是否进入 capture kernel
- vmcore 是否成功写出
- vmcore 文件是否完整
- 对应 vmlinux 是否保存
- crash 能否打开 vmcore

如果没有匹配的 `vmlinux`，vmcore 的分析价值会大幅下降。生产系统应该把内核镜像、调试符号、System.map、config 和构建编号一起归档。

## crash 打开 vmcore 后先看概况

进入 crash 后，先不要急着看某个结构体。建议先建立全局印象：

```text
crash> sys
crash> log
crash> bt
crash> ps
crash> foreach bt
```

重点看：

- 崩溃 CPU
- panic 原因
- uptime
- tainted 状态
- 当前任务
- 其它 CPU 在做什么
- panic 前是否已有 warning
- 是否存在 hung task、RCU stall、soft lockup

很多时候，panic 的当前任务不是根因任务。比如一个 CPU 最终触发 panic，但另一个 CPU 已经持锁不放，或者某个 workqueue 早就破坏了对象。

## bt 不是只看当前 CPU

`bt` 默认看当前上下文，但多核问题必须看所有 CPU：

```text
crash> bt -a
crash> foreach bt
```

如果是死锁或卡死，要特别关注：

- 多个 CPU 是否卡在同一把锁
- 是否有 CPU 长时间关中断
- 是否有 CPU 在持锁路径里等待 IO
- 是否有 workqueue 堆积
- 是否有 kthread 处于不可中断睡眠

调用栈要结合任务状态看。`TASK_UNINTERRUPTIBLE` 不一定是 bug，但如果大量任务卡在同一个资源上，就要看资源 owner。

## log 里找第一次异常

`crash> log` 能看到内核 ring buffer。panic 现场通常有很多噪音，真正关键的是第一次异常。

排查顺序：

1. 找 panic 文本
2. 往前找第一个 warning、BUG、Oops、timeout
3. 继续往前找相关设备或子系统日志
4. 对齐时间戳和 CPU

最后 panic 可能只是系统无法继续运行的结果，第一次 warning 才是状态开始偏离的地方。

例如：

```text
WARNING: refcount_t: underflow
...
Unable to handle kernel paging request
```

这种情况下，真正值得分析的是 refcount 为什么 underflow，而不是只看最终页错误。

## 看对象内容，而不是只看栈

vmcore 最大价值之一是能看崩溃时对象内容。比如栈里显示某个 `struct foo *foo` 参与崩溃，下一步应该查看：

```text
crash> struct foo ffff888012345000
```

关注字段：

- 引用计数
- 状态位
- list 链接
- lock
- work/timer
- ops 函数指针
- device 指针
- 私有数据

如果对象疑似释放过，可以结合 slab 信息：

```text
crash> kmem ffff888012345000
crash> kmem -S
```

如果对象在 slab 中状态异常，方向可能从“空指针”转向“生命周期破坏”。

## list corruption 要检查前后节点

链表损坏类问题不要只看当前节点。要沿着 `next` 和 `prev` 看前后对象是否合理。

典型问题：

- 重复 add
- 重复 del
- del 后没有 reinit
- 对象释放后仍在链表中
- 并发修改没有锁

如果 crash 显示链表指针异常，应该反查：

- 这个对象在哪些路径 add/del
- 是否受同一把锁保护
- remove/error path 是否遗漏 del
- workqueue/timer 是否可能晚到

链表问题往往不是崩溃现场的那一次操作造成，而是更早的状态破坏延迟暴露。

## 内存压力和 OOM 要看系统状态

如果是 OOM 或内存压力相关问题，只看被杀进程没有意义。要看整体内存：

```text
crash> kmem -i
crash> kmem -S
crash> ps
```

关注：

- page cache 是否异常
- slab 是否异常增长
- 某个 cache 是否占用过高
- 是否有大量不可回收内存
- 是否存在内存泄漏路径
- cgroup 限制是否触发

OOM killer 选择了某个进程，不代表它是泄漏者。它只是根据当时策略被选中。

## 符号匹配是底线

crash 分析最基础也最容易忽视的是符号匹配。必须确认：

- vmcore 来自哪个内核
- vmlinux 是否对应同一构建
- 模块符号是否加载
- KASLR 偏移是否处理正确
- debug info 是否完整

如果符号不匹配，栈可能看似合理但实际错误。错误符号分析出来的结论，比没有 vmcore 更危险，因为它会制造错误确定性。

## 一份 vmcore 分析记录模板

每次分析建议留下这样的记录：

```text
输入：
  vmcore、vmlinux、System.map、config、模块列表

系统概况：
  kernel、uptime、tainted、panic CPU、当前任务

关键日志：
  panic 文本、第一次 warning、相关 timeout

任务状态：
  当前 CPU 栈、所有 CPU 栈、异常任务列表

对象状态：
  关键结构体内容、引用计数、链表、slab 状态

判断：
  当前证据支持哪些假设，排除了哪些假设

下一步：
  需要加的 trace、需要复现的场景、需要检查的代码路径
```

这份记录能让 vmcore 分析从“我看了一下”变成可审阅的证据链。

## 结论

kdump 解决的是“系统死了还能留下现场”，crash 解决的是“如何读懂这个现场”。真正的分析不是把 `bt` 贴出来，而是用 vmcore 还原崩溃时的状态，并把状态转化成可验证的根因假设。

vmcore 很大，但证据往往很小。关键是知道从哪里开始看，以及如何避免被最后一个 panic 点带偏。
