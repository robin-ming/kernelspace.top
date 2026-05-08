---
title: 内核内存泄漏排查：从 slab 增长到对象归属
date: 2026-05-02
summary: 内核内存泄漏排查不能只看 free 下降，要把 slab、page owner、kmemleak、引用计数和对象生命周期串成一条证据链。
category: Kernel Debugging
tags: [memory, slab, kmemleak]
---

内核内存泄漏最容易被误判。`free` 变少不一定是泄漏，page cache、slab cache、网络 buffer、文件系统缓存都可能让可用内存下降。真正的泄漏，是某类对象持续增长，并且没有合理回收路径。

所以排查内核内存问题时，第一步不是问“谁泄漏了”，而是问“内存去了哪里”。

## 先区分内存类型

先看整体内存：

```sh
cat /proc/meminfo
slabtop
cat /proc/slabinfo
```

重点区分：

- page cache
- slab reclaimable
- slab unreclaimable
- vmalloc
- page table
- socket buffer
- driver 私有 DMA buffer

如果 `SReclaimable` 增长，可能是缓存，不一定是泄漏。如果 `SUnreclaim` 持续增长，就要重点关注 slab 对象。

## slabtop 找增长对象

`slabtop` 能快速看到哪些 cache 占用高：

```sh
slabtop -o
```

如果某个 cache 持续增长，例如：

```text
kmalloc-512
dentry
inode_cache
skbuff_head_cache
foo_request
```

下一步要判断这是正常工作负载，还是对象没有释放。

通用 kmalloc cache 比较麻烦，因为很多调用点都会使用 `kmalloc-512` 这类 cache。专用 cache 更容易分析，例如驱动自己创建的 `foo_request`。

## kmemleak 适合找不可达对象

如果内核启用了 kmemleak：

```text
CONFIG_DEBUG_KMEMLEAK=y
```

可以使用：

```sh
echo scan > /sys/kernel/debug/kmemleak
cat /sys/kernel/debug/kmemleak
```

kmemleak 的思路是扫描内存引用，找出已经没有指针可达但仍未释放的对象。

它很适合抓：

- 错误路径漏 `kfree`
- probe 失败后资源未释放
- 初始化中途失败
- 某些 list 上对象被摘掉后没有释放

但 kmemleak 不是万能的。对象仍然被全局链表引用，但逻辑上已经不该存在，这种泄漏 kmemleak 未必会报。

## page_owner 看页分配来源

如果问题不是 slab，而是 page 分配持续增长，可以启用 page owner：

```text
page_owner=on
CONFIG_PAGE_OWNER=y
```

然后查看：

```sh
cat /sys/kernel/debug/page_owner
```

实际使用时通常要配合脚本聚合调用栈。page owner 能回答一个关键问题：这些页是谁分配的。

它适合分析：

- 大量 page allocation
- driver DMA buffer 泄漏
- 网络收包路径积压
- 文件系统或块层 buffer 异常

代价是有额外开销，不建议一直在生产环境打开。

## 引用计数泄漏比内存泄漏更常见

很多内存泄漏表面上是对象没释放，根因是引用计数没有归零。

典型模式：

```c
obj = get_obj(id);
if (!obj)
        return -ENOENT;

ret = do_something(obj);
if (ret)
        return ret;

put_obj(obj);
```

错误路径漏了 `put_obj()`。对象仍然被引用，所以不会释放。kmemleak 也不会报，因为对象仍然可达。

这类问题要追：

- get/put 是否成对
- 错误路径是否覆盖
- 异步 work 是否持有引用
- timer 是否持有引用
- file private data 是否释放
- open/release 是否平衡

refcount 泄漏是内核资源泄漏里非常高频的一类。

## probe 错误路径是高危区

驱动 probe 阶段常见泄漏：

- 分配私有结构后中途失败
- 注册子设备后失败但未注销
- 开启 clock/reset 后失败未关闭
- request irq 后硬件仍可能触发
- 创建 workqueue 后未 destroy
- devm 和非 devm 资源混用

`devm_` 能降低释放负担，但不能覆盖所有资源。比如注册到子系统的对象，通常仍需要显式 unregister。

遇到 probe 失败相关泄漏，建议主动注入失败点。只测试成功路径，很难发现错误路径资源泄漏。

## 网络内存增长要看队列

如果 `skbuff_head_cache` 或网络相关 buffer 增长，要先看队列是否积压：

```sh
ss -m
cat /proc/net/sockstat
cat /proc/net/softnet_stat
```

网络内存不一定是泄漏，可能是：

- 用户态不读 socket
- qdisc 队列积压
- NAPI 处理不过来
- 驱动回收 TX descriptor 异常
- RX buffer replenishment 失衡

如果是驱动问题，要重点看 TX complete 和 RX recycle 路径。很多网卡驱动泄漏不是 `kmalloc` 漏释放，而是 DMA buffer 没有 unmap 或 skb 没有 dev_kfree。

## vmalloc 增长要看模块和映射

vmalloc 区域增长可以看：

```sh
cat /proc/vmallocinfo
```

常见来源：

- ioremap
- module load
- vmalloc 分配的大 buffer
- bpf map
- vmap

如果是驱动 ioremap 泄漏，通常和 probe/remove 或热插拔有关。如果模块反复加载卸载后 vmalloc 增长，就要检查 module exit 路径。

## 一份内存泄漏排查顺序

```text
1. 记录 meminfo，确认增长类型
2. 用 slabtop/slabinfo 找增长 cache
3. 判断是 reclaimable 还是 unreclaimable
4. 如果是 slab，找对象类型和分配路径
5. 如果是 page，启用 page_owner 聚合调用栈
6. 如果疑似不可达对象，使用 kmemleak
7. 检查 get/put、open/release、probe/remove
8. 构造错误路径和反复加载卸载测试
9. 用 trace 或统计计数确认修复
```

## 结论

内核内存泄漏排查的关键是归属。先确认内存属于 page cache、slab、page allocation、vmalloc 还是网络 buffer，再追对应对象的生命周期。

真正可靠的结论不是“内存变少了”，而是“某类对象持续增长，分配路径是这里，释放路径没有走到，补丁后计数稳定”。这才是一条完整证据链。
