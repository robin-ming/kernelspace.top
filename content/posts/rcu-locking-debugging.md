---
title: RCU 和锁问题排查：先搞清楚谁保护了什么
date: 2026-01-23
summary: RCU、spinlock、mutex 和 refcount 解决的是不同生命周期问题。排查并发 bug 时，先弄清楚对象、访问路径和保护关系，比先加锁更重要。
category: Kernel Debugging
tags: [rcu, locking, concurrency]
---

内核并发问题很少是“少了一把锁”这么简单。很多时候，真正的问题是没有说清楚：这个对象的生命周期由谁负责，字段一致性由谁保护，读路径能否睡眠，释放路径是否等待所有读者退出。

RCU、spinlock、mutex、refcount、atomic、seqlock 都是工具，但它们解决的问题不一样。如果把它们当成“让并发安全”的通用胶水，补丁很容易从一个 bug 变成另一个更隐蔽的 bug。

## 先画对象生命周期

排查并发 bug，第一步不是看锁，而是画对象生命周期：

```text
allocate
  init fields
  publish pointer
  readers access
  remove from lookup path
  wait for readers
  free object
```

这条线里最关键的是两个边界：

- publish：对象什么时候对其它 CPU 可见
- retire：对象什么时候不再能被新读者找到

如果 publish 之前字段没初始化完，读者可能看到半初始化对象。如果 retire 之后没有等待已有读者退出，就可能 use-after-free。

很多 RCU bug 的根源不是 `rcu_read_lock()` 少写了，而是对象 publish 和 free 的顺序没有定义清楚。

## RCU 保护的是指针可达性

RCU 最常见用途是保护指针可达性。读者可以在 `rcu_read_lock()` 内拿到指针，并保证这段读侧临界区内对象不会被释放。

典型读路径：

```c
rcu_read_lock();
obj = rcu_dereference(global_obj);
if (obj)
        use(obj);
rcu_read_unlock();
```

典型更新路径：

```c
old = rcu_replace_pointer(global_obj, new, lockdep_is_held(&mutex));
call_rcu(&old->rcu, obj_free_rcu);
```

这里要注意：RCU 不自动保护对象内部所有字段的一致性。它只保证读者拿到的对象在读侧临界区里不会被释放。如果字段会被并发修改，还需要其它同步机制。

## RCU 读侧不能随便睡眠

普通 RCU 读侧临界区里不能睡眠。下面这种代码通常是危险信号：

```c
rcu_read_lock();
obj = rcu_dereference(table[id]);
mutex_lock(&obj->lock);
...
mutex_unlock(&obj->lock);
rcu_read_unlock();
```

如果确实需要睡眠，要看是否应该使用 SRCU，或者在 RCU 读侧拿到对象后通过 refcount 固定生命周期，再退出 RCU 临界区：

```c
rcu_read_lock();
obj = rcu_dereference(table[id]);
if (obj && refcount_inc_not_zero(&obj->refcnt))
        keep = obj;
rcu_read_unlock();

if (keep) {
        mutex_lock(&keep->lock);
        ...
        mutex_unlock(&keep->lock);
        put_obj(keep);
}
```

这类模式本质上是：RCU 负责查找期间对象不被释放，refcount 负责查找之后对象继续活着。

## spinlock 保护短临界区

spinlock 适合保护短小、不能睡眠的临界区，常用于中断上下文或底层数据结构。

使用 spinlock 时要确认：

- 访问路径是否可能在 IRQ 上下文
- 是否需要 `spin_lock_irqsave()`
- 持锁期间是否调用可能睡眠的 API
- 锁顺序是否和其它路径一致
- 是否在热路径上引入过长临界区

常见错误是为了省事把大段逻辑塞进 spinlock，最后引入 soft lockup 或调度延迟。spinlock 不是“更强的 mutex”，它只是更受约束。

## mutex 保护可睡眠状态转换

mutex 适合保护较长的状态转换，例如 open/close、probe/remove、配置切换、固件加载等。

mutex 的优势是临界区可以睡眠，但代价是不能在中断上下文使用，也不适合极短高频路径。

如果一个对象同时有 fast path 和 slow path，常见结构是：

- fast path 用 RCU 或 spinlock
- slow path 用 mutex 管理状态切换
- 通过状态位或版本号连接两者

不要试图用一把 mutex 保护所有路径。如果 fast path 不能睡眠，设计上就已经不允许这样做。

## refcount 解决引用者数量

refcount 解决的是“还有没有人持有对象”。它不解决查找时对象是否可达，也不解决字段一致性。

典型错误：

- 找到对象后没有 `get`
- 错误路径多 `put`
- RCU 查找后直接 `get`，但对象可能已经进入释放路径
- refcount 从 0 增加，复活已释放对象

如果对象通过 RCU 查找，通常应该使用 `refcount_inc_not_zero()`。这可以避免把已经进入释放流程的对象重新救活。

## lockdep 是早期预警

启用 lockdep 能发现很多锁顺序问题：

```text
CONFIG_LOCKDEP=y
CONFIG_PROVE_LOCKING=y
```

lockdep 报告不要只看最后的 warning，要看它给出的两条锁获取路径。真正的问题通常是锁顺序不一致：

```text
CPU0: lock A -> lock B
CPU1: lock B -> lock A
```

这类问题在压力不大时可能永远不触发死锁，但 lockdep 能提前告诉你存在环。

## KCSAN 能抓数据竞争

KCSAN 适合找无锁数据竞争：

```text
CONFIG_KCSAN=y
```

但 KCSAN 报告也需要判断。不是所有 data race 都是 bug，有些字段是有意的 lockless 访问。关键问题是：

- 这个字段是否要求强一致
- 读到旧值是否安全
- 是否需要 `READ_ONCE()` / `WRITE_ONCE()`
- 是否缺少内存屏障

如果字段是状态位，读到旧值可能只是延迟；如果字段是指针或长度，读到撕裂值就可能严重。

## 一份并发问题排查模板

```text
对象：
  结构体、分配位置、释放位置

可达性：
  指针在哪里 publish，在哪里 remove

读路径：
  是否 RCU，是否能睡眠，是否拿 refcount

写路径：
  哪把锁保护字段修改

释放路径：
  是否等待读者，是否 cancel work/timer

工具：
  lockdep、KCSAN、KASAN、tracepoints
```

这份模板能避免上来就问“要不要加锁”。更好的问题是：这条访问路径到底依赖什么保证。

## 结论

内核并发调试的核心不是记住更多锁 API，而是把对象生命周期和保护关系讲清楚。RCU 保护可达性，refcount 保护持有者数量，spinlock 保护短临界区，mutex 保护可睡眠状态转换。

当你能回答“谁保护了什么”时，修复通常会变得很小；当这个问题回答不了时，任何加锁都可能只是碰运气。
