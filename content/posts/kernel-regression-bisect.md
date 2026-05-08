---
title: 内核回归定位：让 bisect 成为工程流程
date: 2026-04-12
summary: 回归定位不是机械运行 git bisect，而是定义好现象、构建可重复测试、控制变量，并在坏提交出现后验证根因。
category: Patch Notes
tags: [regression, bisect, git]
---

内核回归问题最怕描述成“新版本不行，旧版本可以”。这句话有方向，但还不是一个可执行的问题。真正能推动修复的是：哪个版本好，哪个版本坏，触发条件是什么，能否稳定复现，最终是哪一个提交引入。

`git bisect` 是定位回归的核心工具，但它不是魔法。bisect 结果是否可靠，取决于你给它的测试是否可靠。

## 先定义 good 和 bad

开始 bisect 前，必须明确两个点：

```text
good: 已知没有问题的提交、tag 或版本
bad: 已知存在问题的提交、tag 或版本
```

例如：

```sh
git bisect start
git bisect bad v6.8
git bisect good v6.7
```

如果 good/bad 之间差异太大，bisect 时间会变长，干扰因素也会增加。能缩小范围就先缩小，例如先在厂商分支、stable tag 或合入窗口之间做粗定位。

## 现象必须可判定

bisect 需要一个二元判断：

- good
- bad

如果现象偶现，就要定义测试次数。例如：

```text
每个提交启动 10 次，出现 1 次 panic 判定为 bad。
```

或者：

```text
运行 stress 30 分钟，期间无 warning 判定为 good。
```

不要凭感觉判断。偶现问题如果测试不充分，bisect 很容易走错方向。

## 控制变量

bisect 期间要尽量保持不变：

- kernel config
- toolchain
- rootfs
- bootloader
- dtb
- firmware
- 测试脚本
- 硬件连接

如果每次测试都顺手改一点环境，最后得到的坏提交可能只是环境变化的产物。

设备树尤其要注意。有些提交需要配套 dts 变化，如果你在 bisect 过程中始终使用外部 dtb，可能会测出错误结果。要明确使用“内核构建出的 dtb”还是“固定 dtb”。

## 构建失败怎么处理

bisect 过程中某些提交可能编译不过。不要直接标 bad，而应该：

```sh
git bisect skip
```

skip 会降低定位精度，但比错误标记好。错误标记会把搜索路径带偏。

如果大范围编译失败，说明 good/bad 区间可能跨过了较大的构建系统或依赖变化。可以先缩小区间，或者临时应用最小构建修复补丁，但要记录清楚。

## 自动化测试脚本

如果现象能自动判断，最好写脚本：

```sh
#!/bin/sh
set -eu

make olddefconfig
make -j"$(nproc)"
./deploy-and-boot.sh
./run-test.sh
```

然后：

```sh
git bisect run ./bisect-test.sh
```

脚本返回值约定：

- `0`: good
- `1-127`: bad
- `125`: skip

自动化的价值不只是省时间，更重要是减少人工判断波动。

## bisect 出来的提交还不是结论

bisect 找到的 first bad commit 是强证据，但还不是完整结论。还需要验证：

- revert 这个提交是否修复问题
- 在 good 版本 cherry-pick 是否引入问题
- 这个提交的代码路径是否能解释现象
- 是否依赖后续提交才真正触发
- 是否是配置或设备树变化暴露了旧 bug

有时 bisect 指向的是“暴露问题的提交”，不是“根因提交”。例如某个提交打开了新功能，真正 bug 在旧驱动错误路径里。

## 合并提交和大补丁要小心

如果 first bad 是 merge commit，情况会复杂。需要判断问题来自哪个分支：

```sh
git show --summary <merge>
git log --oneline <parent1>..<merge>
git log --oneline <parent2>..<merge>
```

有时要在 merge 的两个父分支之间继续 bisect。

如果 first bad 是大补丁，也不要只把整块补丁当结论。要读 diff，找到真正改变行为的部分。一个补丁可能同时改了重构、配置、时序和错误路径。

## 回归报告要写清楚

给维护者的回归报告至少包括：

```text
现象：
  触发条件和错误日志。

good:
  commit/tag

bad:
  commit/tag

first bad:
  commit id 和标题

验证：
  revert 是否恢复，cherry-pick 是否复现

环境：
  架构、板卡、config、dtb、toolchain

日志：
  panic、warning、dmesg、测试脚本输出
```

这类报告比“这个提交有问题”更容易被维护者接受，也更容易进入修复流程。

## 回归修复要避免只修表象

回归修复常见两种：

- revert 或恢复旧行为
- 在新行为下修正根因

如果新提交本身方向正确，只是暴露了旧 bug，直接 revert 可能不是最佳方案。反过来，如果新提交违反了已有 ABI 或硬件约束，revert 可能是最稳妥的短期修复。

选择哪种方案，要看影响范围、stable 风险、维护者意图和是否有清晰根因。

## 一份 bisect 操作模板

```sh
git bisect start
git bisect bad <bad>
git bisect good <good>

# 手动测试每个提交
make -j"$(nproc)"
./deploy-and-test.sh
git bisect good   # 或 git bisect bad

# 完成后
git bisect log > bisect.log
git bisect reset
```

保留 `bisect.log` 很重要。它能让别人复查你的路径，也能在误判后重新 replay。

## 结论

bisect 是工程流程，不只是 Git 命令。可靠的 bisect 需要稳定复现、明确判定、控制变量、记录日志，以及对 first bad commit 的二次验证。

真正好的回归定位，不只是找到一个提交，而是能解释为什么这个提交让问题出现，并给出可被维护者信任的证据。
