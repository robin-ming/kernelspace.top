---
source_project: 37233
source_path: /home/robin/Storage/Redmine/37233/cmd.md
synced_at: 2026-05-08T17:32:02+08:00
---

# SPDK on LoongArch64 (OpenCloudOS 9.4) 构建部署记录

本文档记录了在龙芯 3C6000 (LoongArch64) 服务器上完成 SPDK v26.01 安装、编译、部署及验证的全过程命令。

---

## 1. 源码准备
```bash
# 克隆代码库并切换到指定版本
git clone https://github.com/spdk/spdk.git /root/spdk
cd /root/spdk
git checkout v26.01
git submodule update --init --recursive
```

## 2. 操作系统适配与依赖安装
由于 OpenCloudOS 不在 SPDK 原生支持列表中，需将其映射为 RHEL 兼容模式。

```bash
# 1. 修改发行版识别逻辑 (映射 opencloudos -> rhel)
sed -i 's/ID=${ID,,}/ID=${ID,,}; [[ $ID == opencloudos ]] \&\& ID=rhel/' /root/spdk/scripts/pkgdep.sh

# 2. 清理不可用的第三方仓库 (Ceph/EPEL 缺乏 LoongArch 二进制包)
rm -f /etc/yum.repos.d/ceph* /etc/yum.repos.d/elrepo.repo /etc/yum.repos.d/epel*
dnf clean all

# 3. 安装核心编译依赖 (使用 OpenCloudOS 本地源)
dnf install -y gcc gcc-c++ make libaio-devel openssl-devel libuuid-devel \
    ncurses-devel json-c-devel clang clang-devel python3-pip unzip \
    keyutils-libs-devel fuse3-devel patchelf pkgconfig numactl-devel \
    nasm autoconf automake libtool help2man ninja-build

# 4. 安装 Python 构建工具
pip3 install meson pyelftools
```

## 3. 编译配置
针对 LoongArch 架构，禁用尚未支持的单元测试和加速库模块。

```bash
# 1. 强制跳过 ut 单元测试目录 (绕过 CUnit 缺失问题)
sed -i 's/^DIRS-y += ut/#DIRS-y += ut/' /root/spdk/lib/Makefile

# 2. 配置编译参数 (启用共享库模式，禁用单元测试)
./configure --with-shared --disable-unit-tests

# 3. 开始并行编译 (建议使用较低并发避免竞争报错)
make -j8
```

## 4. 系统环境准备 (Hugepages & Limits)
```bash
# 1. 设置内存锁定限制为无限制
ulimit -l unlimited

# 2. 分配 4096MB 大页内存并配置驱动
HUGEMEM=4096 /root/spdk/scripts/setup.sh
```

## 5. 启动服务与功能验证
```bash
# 1. 导出动态链接库路径
export LD_LIBRARY_PATH=/root/spdk/build/lib

# 2. 后台启动 SPDK Target
nohup ./build/bin/spdk_tgt &

# 3. 验证 RPC 通信是否正常 (获取版本号)
./scripts/rpc.py spdk_get_version
```

## 6. 挂载本地磁盘验证 (NBD 流程)
```bash
# 1. 创建 128MB 的内存虚拟磁盘 (Malloc Bdev)
./scripts/rpc.py bdev_malloc_create 128 512 -b Malloc0

# 2. 加载内核 NBD 模块并映射
modprobe nbd
./scripts/rpc.py nbd_start_disk Malloc0 /dev/nbd0

# 3. 格式化并挂载到系统
mkfs.ext4 /dev/nbd0
mount /dev/nbd0 /mnt

# 4. 读写测试
echo "Hello SPDK on LoongArch!" > /mnt/test_spdk.txt
cat /mnt/test_spdk.txt
```
