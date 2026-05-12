---
title: "LoongArch 机器配置 Vim + coc.nvim + clangd 记录"
date: 2026-05-12
summary: "LoongArch 机器配置 Vim + coc.nvim + clangd 记录"
category: Notes
tags: [codex, "redmine"]
source_project: "Redmine"
source_path: "/home/robin/Storage/Redmine/loongarch-vim-coc-clangd.md"
synced_at: "2026-05-12T16:00:15+08:00"
---

# LoongArch 机器配置 Vim + coc.nvim + clangd 记录

## 环境信息

目标机器：

```text
robin@10.180.135.190
```

检查结果：

```text
架构: loongarch64
系统: OpenCloudOS 9.4
内核: 6.6.119-49.18.oc9.loongarch64
Vim: /usr/bin/vim 9.0
Node.js: /usr/bin/node v18.20.8
clangd: /usr/bin/clangd 17.0.6
coc-clangd: 0.33.0
```

`clangd --version` 输出中可以看到：

```text
Platform: loongarch64-unknown-linux-gnu
target=loongarch64-opencloudos-linux-gnu
```

说明当前 `clangd` 是 LoongArch 可用版本。

## 需要安装的软件

`coc.nvim` 依赖 Node.js，`coc-clangd` 依赖系统里的 `clangd` 二进制。

在 OpenCloudOS 9.4 LoongArch 上可使用：

```bash
sudo dnf install nodejs clang-tools-extra
```

包对应关系：

```text
nodejs             -> 提供 /usr/bin/node
clang-tools-extra  -> 提供 /usr/bin/clangd
```

如果需要更新版本的 LLVM/clangd，也可以选择工具链包，例如：

```bash
sudo dnf install llvm-toolset-20-clang-tools-extra
```

这类包的 `clangd` 通常位于：

```text
/opt/OpenCloudOS/llvm-toolset-20/root/usr/bin/clangd
```

如果使用该路径，需要在 coc 配置里显式指定 `clangd.path`。

## 安装 coc-clangd

在 Vim 中执行：

```vim
:CocInstall coc-clangd
```

本次安装结果：

```text
coc-clangd Move extension coc-clangd@0.33.0 to
/home/robin/.config/coc/extensions/node_modules/coc-clangd
```

## 检查命令

在目标机器上执行：

```bash
command -v node
node --version

command -v clangd
clangd --version

test -d ~/.config/coc/extensions/node_modules/coc-clangd && echo coc-clangd-installed
```

本次确认结果：

```text
/usr/bin/clangd
clangd version 17.0.6 (OpenCloudOS 17.0.6-8.oc9.ap.2)
/usr/bin/node
v18.20.8
coc-clangd-installed
```

## 推荐 Coc 配置

编辑 Coc 配置：

```vim
:CocConfig
```

可加入：

```json
{
  "clangd.path": "/usr/bin/clangd",
  "clangd.arguments": [
    "--background-index",
    "--completion-style=detailed",
    "--header-insertion=never"
  ]
}
```

如果使用 `llvm-toolset-20` 的 clangd，则改成类似：

```json
{
  "clangd.path": "/opt/OpenCloudOS/llvm-toolset-20/root/usr/bin/clangd",
  "clangd.arguments": [
    "--background-index",
    "--completion-style=detailed",
    "--header-insertion=never"
  ]
}
```

## 项目侧配置

`coc-clangd` 能否准确补全、跳转、诊断，关键取决于项目根目录是否有正确的编译数据库：

```text
compile_commands.json
```

CMake 项目可使用：

```bash
cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON ...
```

普通 Makefile 项目可尝试：

```bash
bear -- make
```

Linux kernel 项目常见方式是生成 clangd 可读的编译数据库，例如使用内核脚本：

```bash
./scripts/clang-tools/gen_compile_commands.py
```

如果源码目录和构建目录分离，需要在源码目录放置或链接生成的 `compile_commands.json`：

```bash
ln -s /path/to/build/compile_commands.json /path/to/source/compile_commands.json
```

## 验证方式

打开一个 C/C++ 源文件后，在 Vim 中执行：

```vim
:CocInfo
```

需要确认：

```text
clangd language server 已启动
没有提示 clangd executable not found
```

可测试功能：

```vim
gd          " 跳转定义
gr          " 查找引用
:CocList diagnostics
:CocCommand clangd.restart
```

## 常见问题

### 1. coc-clangd 已安装，但没有补全

优先检查：

```bash
command -v clangd
clangd --version
```

如果 `clangd` 不存在，需要安装 `clang-tools-extra`。

### 2. 有补全但跳转不准，或者大量误报

通常是项目缺少正确的 `compile_commands.json`，或者编译参数不完整。需要按项目真实构建方式生成编译数据库。

### 3. 使用交叉编译项目时头文件找不到

需要保证 `compile_commands.json` 中包含真实的交叉编译参数、sysroot、include 路径和宏定义。clangd 只按编译数据库理解项目，不会自动推断复杂构建环境。

### 4. Vim 中 Coc 没启动

检查 Node.js：

```bash
node --version
```

再检查 Vim 中：

```vim
:CocInfo
```

如果 Coc 插件本身没有安装或没有加载，需要先修复 `coc.nvim` 的 Vim 插件安装。

## 当前结论

LoongArch 机器可以使用 `vim + coc.nvim + clangd`。本次检查的 `robin@10.180.135.190` 已具备：

```text
Node.js
clangd 17.0.6
coc-clangd 0.33.0
```

后续只需要针对具体 C/C++ 项目准备正确的 `compile_commands.json`，即可正常使用补全、跳转和诊断功能。
