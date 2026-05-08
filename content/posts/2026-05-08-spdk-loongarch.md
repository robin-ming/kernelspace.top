---
source_project: 37233
source_path: /home/robin/Storage/Redmine/37233/presentation.md
synced_at: 2026-05-08T17:32:02+08:00
---

---
marp: true
theme: default
paginate: true
header: '龙芯 LoongArch64 存储技术调研汇报'
footer: '王明团队 | 内核团队 | 2026.03.20'
style: |
  section {
    background-color: #f8f9fa;
    color: #333;
    font-family: 'Helvetica', 'Arial', sans-serif;
  }
  h1 { color: #004085; }
  h2 { color: #0056b3; border-bottom: 2px solid #0056b3; }
  code { background-color: #e9ecef; }
  .tag {
    display: inline-block;
    padding: 0.2em 0.5em;
    border-radius: 4px;
    background: #17a2b8;
    color: white;
    font-size: 0.8em;
  }
---

# 龙芯 LoongArch 架构下 SPDK 高性能存储栈
## 技术调研与实践成果汇报

**汇报人：王明团队 | 内核团队**
**日期：2026年3月20日**

---

## 1. 项目背景与目标
### 环境基础
*   **硬件平台**：龙芯 3C6000 (LoongArch64) | 64 Cores
*   **操作系统**：OpenCloudOS 9.4 (兼容 RHEL 9)

### 核心目标
1.  **架构适配**：跑通 SPDK/DPDK 在龙芯架构下的原生指令集适配。
2.  **功能验证**：实现从“用户态存储”到“内核态挂载”的全链路打通。
3.  **性能预研**：评估龙芯在 NVMe-oF 高性能网络存储下的演进潜力。

---

## 2. 核心架构：SPDK 与 DPDK 的协同
### 地基与建筑的艺术
- **DPDK (地基层)**
  - 管理 **Hugepages** (大页内存)
  - 实现 **PMD** (轮询驱动) 与 PCIe 探测
- **SPDK (存储引擎)**
  - 实现 **Userspace NVMe Driver**
  - **Bdev** 块设备抽象层
  - **NVMe-oF** 存储协议栈

<p style="text-align: center; margin-top: 50px;">
  <span class="tag">Kernel Bypass</span>
  <span class="tag">Zero Copy</span>
  <span class="tag">Lockless</span>
</p>

---

## 3. LoongArch64 关键适配点
### 深入指令集底层的优化
1.  **内存模型适配**
    - 正确嵌入 `dbar` 指令，解决弱内存模型下的指令重排问题。
2.  **原子操作适配**
    - 基于龙芯 LL/SC 与 AM 指令集实现无锁队列（Ring Buffer）。
3.  **计算加速 (预研)**
    - 针对 ISA-L 库，探索 **LASX (256位)** 向量指令对 CRC 校验与纠删码的硬件加速。

---

## 4. 实践之路：从源码到运行
### 攻克的关键技术瓶颈
*   **发行版识别**：动态映射 OpenCloudOS 至 RHEL 兼容模式。
*   **依赖冲突**：清理不兼容的第三方仓库，切换至原生 EPOL 源。
*   **编译优化**：
    - 禁用缺失的 `CUnit` 单元测试模块。
    - 优化并行编译参数，规避文件竞争报错。

---

## 5. 功能验证：Malloc Bdev + NBD
### 闭环验证流程
1.  **用户态创建**：成功分配 4096MB 大页内存，创建 **Malloc Bdev**。
2.  **跨界映射**：利用 **NBD (Network Block Device)** 协议将用户态存储映射至 `/dev/nbd0`。
3.  **内核挂载**：成功通过 `mkfs.ext4` 格式化并挂载至 `/mnt`。
4.  **读写测试**：完成从用户空间到物理内存的端到端读写验证。

---

## 6. NVMe-oF：分布式存储的基石
### 架构分析
- **前端传输层**：支持 TCP 与 RDMA 双后端。
- **中枢逻辑**：用户态解析 NVMe 报文，完全规避内核中断。
- **后端抽象**：灵活对接物理 SSD 或虚拟卷。

### 龙芯适配优势
- **多核释放**：充分利用 3C6000 的 64 核算力，实现单核管理独立队列。
- **高带宽**：配合 XL710 (40GbE) 网卡，挑战硬件吞吐极限。

---

## 7. 下一步演进计划
### 迈向生产级存储
1.  **物理接管**：从 Malloc 虚拟盘转向 **物理 NVMe SSD** 原生驱动测试。
2.  **网络飞跃**：
    - **短期**：实现基于 XL710 的 NVMe-oF over TCP 压测。
    - **长期**：引入 **RDMA/RoCE**，实现全栈硬件卸载。
3.  **算法加速**：全面推进 ISA-L 在龙芯 **LASX** 指令集下的适配。

---

# 谢谢大家！
## 敬请批评指正

**Q & A**
