---
title: MDIO 和 PHY 调试：网口不通先看链路层
date: 2026-04-30
summary: 以太网不通不一定是网络栈问题。MDIO、PHY 地址、reset、时钟、RGMII delay 和 MAC 配置任何一环错了，链路都可能起不来。
category: Driver Development
tags: [ethernet, mdio, phy]
---

嵌入式板子上“网口不通”是很常见的问题，但它不一定属于 TCP/IP 或 userspace 网络配置。很多时候，问题发生在更底层：MAC、MDIO、PHY、reset、时钟、RGMII/RMII 连接。

如果链路层没起来，后面配置 IP、路由、DNS 都没有意义。

## 先看 link

第一步确认链路状态：

```sh
ip link
ethtool eth0
dmesg | grep -i phy
```

重点看：

- 是否识别到 PHY
- link detected 是否 yes
- speed/duplex 是否正确
- autoneg 是否完成
- 是否反复 link up/down
- MAC 驱动是否报 timeout

如果 `ethtool` 显示 `Link detected: no`，先不要看 IP 层。

## MDIO 扫描是否能读到 PHY

MAC 通过 MDIO 总线访问 PHY 寄存器。如果 MDIO 都读不到 PHY，链路不可能正常。

常见表现：

```text
Unable to connect to phy
MDIO read timeout
no phy found
```

排查点：

- PHY 地址是否正确
- MDIO/MDC 引脚 pinmux 是否正确
- PHY reset 是否释放
- PHY 电源是否正常
- MDC 时钟频率是否符合 PHY 要求
- 设备树 `phy-handle` 是否指向正确节点

PHY 地址常由硬件 strap 决定，不是随便写。要看原理图和 PHY datasheet。

## 设备树里的 PHY 节点

典型结构：

```dts
ethernet@... {
        phy-mode = "rgmii-id";
        phy-handle = <&phy0>;

        mdio {
                #address-cells = <1>;
                #size-cells = <0>;

                phy0: ethernet-phy@1 {
                        reg = <1>;
                };
        };
};
```

这里 `reg = <1>` 是 PHY 地址。写错后，MAC 会去错误地址找 PHY。

如果板子上有多个 PHY 或 switch，MDIO 拓扑会更复杂。要确认 MAC 连接的是哪个 MDIO bus，PHY 是否挂在这个 bus 上。

## reset 时序很关键

PHY reset 不是简单拉一下 GPIO。很多 PHY 对 reset 低电平时间、释放后稳定时间、电源时序有要求。

设备树里可能有：

```dts
reset-gpios = <&gpio1 5 GPIO_ACTIVE_LOW>;
reset-assert-us = <10000>;
reset-deassert-us = <50000>;
```

如果 reset 太短，PHY 可能没有正确 latch strap，地址、接口模式、delay 配置都会错。

冷启动失败、热重启成功，是 reset 或电源时序问题的典型信号。

## phy-mode 不能猜

`phy-mode` 决定 MAC 和 PHY 之间的接口模式：

- `mii`
- `rmii`
- `rgmii`
- `rgmii-id`
- `rgmii-rxid`
- `rgmii-txid`
- `sgmii`

RGMII 的 delay 特别容易出问题。`rgmii-id` 表示 PHY 侧加 TX/RX delay，`rgmii` 表示不加内部 delay。具体该用哪个，要看：

- PCB 走线是否做了 delay
- PHY 是否支持 internal delay
- bootloader 是否已经配置过 delay
- MAC 是否也能配置 delay

delay 配错时，可能表现为：

- link up 但 ping 不通
- 大包丢包
- 高速不稳定
- 100M 正常，1000M 不正常
- 温度变化后不稳定

这类问题不是 IP 配置能解决的。

## MAC 和 PHY 的分工

PHY 负责物理链路协商，MAC 负责帧收发。link up 只说明 PHY 协商成功，不代表 MAC 收发路径一定正确。

如果 link up 但无流量，要看：

- MAC clock 是否正确
- DMA ring 是否工作
- TX descriptor 是否回收
- RX descriptor 是否补充
- 中断是否触发
- NAPI 是否运行
- MAC 地址是否正确
- RGMII delay 是否正确

`ethtool -S eth0` 很有用，可以看驱动统计计数：

```sh
ethtool -S eth0
```

如果 TX count 增长但 RX 不增长，方向和 RX path 或外部链路有关。如果 TX timeout，方向可能是 DMA、clock、descriptor 或 MAC 配置。

## autoneg 问题要看对端

自协商不只看本端。交换机、网线、PHY strap、advertise 能力都会影响结果。

可以临时强制速率验证：

```sh
ethtool -s eth0 speed 100 duplex full autoneg off
```

如果 100M 稳定、1000M 不稳定，重点看 RGMII timing、时钟质量和 PCB 走线。如果所有速率都不稳定，要回到 reset、电源、MDIO、PHY 驱动。

## 一份网口 bring-up 清单

```text
1. dmesg 是否识别 MAC 和 PHY
2. MDIO 是否能读到 PHY ID
3. PHY 地址是否和硬件 strap 一致
4. reset GPIO 和时序是否正确
5. regulator/clock 是否启用
6. phy-mode 是否匹配硬件连接
7. RGMII delay 是否配置在正确一侧
8. ethtool 是否 link up
9. ethtool -S 是否有 TX/RX 计数
10. 对端交换机端口状态是否正常
```

## 结论

以太网问题要从链路层往上排。MDIO 读不到 PHY，就不要看 IP；link 不稳定，就先看 reset、clock、phy-mode 和 RGMII delay；link up 但没流量，再看 MAC DMA、中断和 descriptor。

网络栈很复杂，但板级 bring-up 阶段，大多数问题都在 MAC-PHY 交界处。
