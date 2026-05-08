# crash 解析 openEuler 2403 SP2 vmcore 报错问题分析

## 1. 问题背景

虚拟化团队在 openEuler 2403 SP2 LoongArch 虚拟机中执行：

```bash
virsh dump --domain loongnix --file /home/core --memory-only --live
```

随后使用 crash 工具解析生成的 vmcore，出现如下错误：

```text
invalid
crash: invalid kernel virtual address: ccccccccccccccd4  type: "first vmlist addr"
```

同样流程在 Server23.2 / Loongnix 虚拟机上正常。

当前调用栈显示，crash 在初始化 vmalloc 信息时失败：

```text
#0 readmem(..., "first vmlist addr", ...)
#1 first_vmalloc_address()
#2 vm_init()
#3 main_loop()
```

失败点位于 crash 工具 `memory.c:first_vmalloc_address()` 中读取 `vmlist->addr` 的路径。

## 2. 当前结论

初步判断这是 crash 工具与 openEuler 2403 SP2 LoongArch 内核 vmalloc 元数据布局之间的不兼容问题，不像是 vmcore 内容整体损坏，也不是 Server23.2 与 openEuler vmcore 生成命令本身的直接差异。

关键点：

- Server23.2 内核仍保留并导出 `vmap_area_list`，旧 crash 可以走有效路径。
- openEuler 2403 SP2 内核已经切换到 `vmap_nodes` 管理 vmalloc 区域。
- openEuler SP2 中的 `vmlist` 是 `__initdata`，启动后不能作为运行期 vmalloc 链表使用。
- openEuler SP2 已经通过 vmcoreinfo 导出 `NUMBER(VMALLOC_START)`，crash 正确做法应优先使用该值。
- 虚拟化团队临时跳过 `vmlist` 分支能绕开崩溃，但不是完整修复。

## 3. crash 工具相关逻辑

crash 在 `vm_init()` 中调用架构相关的 `machdep->vmalloc_start()`，LoongArch 侧最终进入通用函数：

```c
loongarch64_vmalloc_start(void)
{
        return first_vmalloc_address();
}
```

旧逻辑大致是：

```c
if (vt->flags & USE_VMAP_AREA) {
        get_symbol_data("vmap_area_list", sizeof(void *), &vmap_area);
        readmem(vmap_area - OFFSET(vmap_area_list) +
                OFFSET(vmap_area_va_start), KVADDR,
                &vmalloc_start, sizeof(void *),
                "first vmap_area va_start", RETURN_ON_ERROR);
} else if (kernel_symbol_exists("vmlist")) {
        get_symbol_data("vmlist", sizeof(void *), &vm_struct);
        readmem(vm_struct + OFFSET(vm_struct_addr), KVADDR,
                &vmalloc_start, sizeof(void *),
                "first vmlist addr", RETURN_ON_ERROR);
}
```

如果内核没有旧的 `vmap_area_list`，但仍有符号名 `vmlist`，旧 crash 就会退回读取 `vmlist`。

openEuler SP2 的问题正发生在这个退回路径。

## 4. 为什么 Server23.2 没有问题

远端 Server23.2 内核代码路径：

```text
/home/robin/Gerrit/linux-6.6-gerrit
```

该树中仍有全局 `vmap_area_list`，并且导出给 vmcoreinfo：

```text
kernel/crash_core.c: VMCOREINFO_SYMBOL(vmap_area_list)
mm/vmalloc.c: LIST_HEAD(vmap_area_list)
```

因此 crash 解析 Server23.2 vmcore 时，可以走 `vmap_area_list` 路径。该链表是运行期有效的 vmalloc 管理结构，读取第一项 `va_start` 可以得到合理的 vmalloc 起始地址。

这也是 Server23.2 不触发 `first vmlist addr` 报错的直接原因。

## 5. openEuler SP2 的差异

远端 openEuler 内核代码路径：

```text
/home/robin/Gitee/kernel-openeuler
```

在 `openEuler-24.03-LTS-SP2` tag 中，vmalloc 管理已经切换到 `vmap_nodes`：

```text
mm/vmalloc.c: static struct vmap_node *vmap_nodes = &single;
```

同时 `vmlist` 是初始化阶段临时数据：

```text
mm/vmalloc.c: static struct vm_struct *vmlist __initdata;
```

`__initdata` 段在内核启动完成后会被释放或复用。crash 在解析运行中的 vmcore 时读取该符号，可能读到已释放内存中的填充值或无效指针。

本次报错地址：

```text
0xccccccccccccccd4
```

很符合读取到 `0xcccccccccccccccc` 一类污染值后，再加上 `vm_struct.addr` 字段偏移得到的结果。因此该地址不是正常内核虚拟地址。

## 6. openEuler 已提供正确信息源

openEuler SP2 内核已经在 vmcoreinfo 中导出 `VMALLOC_START`：

```text
openEuler-24.03-LTS-SP2:kernel/crash_core.c:
vmcoreinfo_append_str("NUMBER(VMALLOC_START)=0x%lx\n",
                      (unsigned long) VMALLOC_START);
```

因此，适配这类内核时，crash 应优先从 vmcoreinfo 读取：

```text
NUMBER(VMALLOC_START)
```

而不是退回读取 `vmlist`。

本地 crash rpm 源码中已有对应补丁：

```text
/home/robin/Storage/LSwork/37579/crash_rpm_source/0004-support-vmp_area_list-replaced-with-VMALLOC_START.patch
```

该补丁的核心方向是：

```c
vmalloc_start_string = pc->read_vmcoreinfo("NUMBER(VMALLOC_START)");
if (vmalloc_start_string) {
        vmalloc_start = htol(vmalloc_start_string, QUIET, NULL);
        free(vmalloc_start_string);
} else if (vt->flags & USE_VMAP_AREA) {
        ...
} else if (kernel_symbol_exists("vmlist")) {
        ...
}
```

这个修复方向与 openEuler SP2 内核的 vmcoreinfo 导出逻辑匹配。

## 7. 对虚拟化团队临时补丁的评价

虚拟化团队临时修改如下：

```c
} else if (kernel_symbol_exists("vmlist")) {
        return 0;
        /*
        get_symbol_data("vmlist", sizeof(void *), &vm_struct);
        ...
        */
}
```

这个修改能绕过崩溃，说明问题确实集中在 `vmlist` 读取路径上。但它不是严格正确的最终方案。

原因：

- `vt->vmalloc_start` 会被设置为 0。
- `IS_VMALLOC_ADDR()` 依赖 `vt->vmalloc_start` 判断地址是否属于 vmalloc 区域。
- 后续模块、vmalloc 区域、页表翻译、内存映射相关命令可能出现误判。

因此该补丁只能作为定位问题的临时手段，不能作为正式修复。

## 8. 仍需验证的问题

目前还没有实际 openEuler 2403 SP2 测试 vmcore，因此还需要验证 `virsh dump --memory-only --live` 生成的 vmcore 是否携带 VMCOREINFO。

这一点很关键：

- 如果 vmcore 中有 `VMCOREINFO` 和 `NUMBER(VMALLOC_START)`，带上述补丁的 crash 应该可以正常解析。
- 如果 vmcore 中没有 VMCOREINFO，crash 即使支持优先读取 `NUMBER(VMALLOC_START)`，也读不到该值，仍可能退回到 `vmlist` 路径。

后者需要进一步确认 QEMU/virsh dump 是否正确携带 VMCOREINFO，或者在 crash 侧为 LoongArch/openEuler 增加额外兜底逻辑，避免读取 `__initdata` 的 `vmlist`。

## 9. 后续验证清单

openEuler 2403 SP2 环境准备好后，建议按以下步骤验证。

确认系统版本：

```bash
uname -a
cat /etc/os-release
```

确认内核符号：

```bash
grep -wE 'vmlist|vmap_area_list|vmap_nodes|vmcoreinfo_data|vmcoreinfo_note' /proc/kallsyms
```

预期：

- 有 `vmlist`
- 有 `vmap_nodes`
- 没有旧的全局 `vmap_area_list`
- 有 `vmcoreinfo_data` / `vmcoreinfo_note`

生成 vmcore：

```bash
virsh dump --domain loongnix --file /home/core --memory-only --live
```

用 crash 高调试级别解析：

```bash
crash -d8 vmlinux /home/core
```

重点观察：

- crash 是否识别到 `VMCOREINFO`
- 是否能读取 `NUMBER(VMALLOC_START)`
- 是否仍进入 `first vmlist addr` 路径
- 带 `0004-support-vmp_area_list-replaced-with-VMALLOC_START.patch` 的 crash 是否可正常进入交互界面

## 10. 建议结论

当前建议将问题定性为 crash 工具对 openEuler 2403 SP2 LoongArch vmalloc 元数据变化的兼容性问题。

正式修复方向优先考虑：

1. 在 crash 中优先读取 vmcoreinfo 的 `NUMBER(VMALLOC_START)`。
2. 对 `vmap_nodes` 结构提供完整支持，避免依赖旧 `vmap_area_list`。
3. 避免在运行期读取 openEuler SP2 中 `__initdata` 的 `vmlist`。

在没有确认 vmcore 是否携带 VMCOREINFO 前，暂不建议把问题归因到内核 vmcore 生成错误。更准确的说法是：openEuler SP2 内核已经提供了 `NUMBER(VMALLOC_START)`，crash 工具需要使用该信息；如果 `virsh dump` 产物丢失 VMCOREINFO，则需要另行分析 QEMU/virsh dump 链路。
