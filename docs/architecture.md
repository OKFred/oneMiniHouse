# oneMiniHouse 架构与采集时序

根据当前代码整理的逻辑架构，采用白底、深色边框与文字、深蓝服务节点和黄色存储节点。
只使用通用名称；不包含真实设备地址、账号、云项目标识或分享链接。
配置启用状态与线上健康情况需另行核验。

## 架构图

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#FFFFFF","fontFamily":"Arial, Microsoft YaHei, sans-serif","fontSize":"18px","primaryColor":"#DBEAFE","primaryTextColor":"#0F172A","primaryBorderColor":"#1E3A8A","lineColor":"#0F172A","textColor":"#0F172A","secondaryColor":"#FEF3C7","tertiaryColor":"#F1F5F9","clusterBkg":"#F8FAFC","clusterBorder":"#475569","edgeLabelBackground":"#FFFFFF"},"flowchart":{"htmlLabels":true,"curve":"linear","nodeSpacing":28,"rankSpacing":48}}}%%
flowchart TB
  subgraph devices["设备与传感器"]
    BLE["蓝牙插座"]
    RTU["Modbus 电表 / 光照"]
    MI["Zigbee 温湿度<br/>经小米网关"]
    HOST["Linux 主机温度<br/>本机 sysfs · systemd 服务<br/>SQLite 发件箱"]
    ROUTER["OpenWrt / collectd<br/>主动上报温度"]
  end

  G["采集网关 · TypeScript<br/>默认每台 60 秒 · 分组调度<br/>SQLite 发件箱"]
  M["EMQX<br/>MQTT 5 · TLS · QoS 1"]
  BLE -->|"BLE / BlueZ"| G
  RTU -->|"RS485 → TCP 透传"| G
  MI -->|"miIO / UDP 只读查询"| G
  HOST -->|"每 60 秒主动上报 telemetry"| M
  G -->|"telemetry / frames"| M
  ROUTER -->|"collectd 精确主题"| M

  subgraph ingest["Ingestor · 本地持久化与处理"]
    RX["订阅 / 校验 / 路由"]
    RAW[("原始层 · SQLite<br/>原文 + 哈希 + 处理任务<br/>默认保留 180 天")]
    PROCESS["版本化处理<br/>统一指标 / 单位 / 时间语义"]
    JOBS[("SQLite 加工结果<br/>各目标独立投递任务")]
    FRAMES[("协议帧 · SQLite<br/>与业务原文分开<br/>默认保留 30 天")]
    RX -->|"遥测 / collectd"| RAW
    RAW --> PROCESS --> JOBS
    RX -->|"frames"| FRAMES
  end
  M --> RX

  LOCAL[("本地 PostgreSQL<br/>加工层 iot.telemetry<br/>保留长期历史")]
  CLOUD[("Supabase PostgreSQL<br/>同一加工模型<br/>滚动保留 30 天")]
  D1[("Cloudflare Worker → D1<br/>原始数据云端副本<br/>默认保留 180 天")]
  JOBS -->|"独立确认与重试"| LOCAL
  JOBS -->|"独立确认与重试"| CLOUD
  RAW -.->|"配置启用后 · HTTPS 归档"| D1

  VIEWS["派生与展示查询<br/>限定只读视图 + SQL<br/>用电增量 / 每日汇总等"]
  DASH["Grafana<br/>登录总览：用电 / 环境 / 设备<br/>公开看板：仅用电"]
  LOCAL --> VIEWS --> DASH

  HEALTH["健康探针<br/>资源 / 容器 / 应用心跳"]
  SLS["SLS · 服务器健康日志"]
  ALERT["飞书告警"]
  G -.->|"运行状态"| HEALTH
  RX -.->|"运行状态"| HEALTH
  HEALTH -->|"限量上传"| SLS --> ALERT

  classDef source fill:#FFFFFF,stroke:#334155,stroke-width:2px,color:#0F172A;
  classDef service fill:#1E3A8A,stroke:#0F172A,stroke-width:2px,color:#FFFFFF;
  classDef store fill:#FEF3C7,stroke:#92400E,stroke-width:2px,color:#422006;
  classDef query fill:#CCFBF1,stroke:#115E59,stroke-width:2px,color:#134E4A;
  classDef monitor fill:#EDE9FE,stroke:#5B21B6,stroke-width:2px,color:#3B0764;
  class BLE,RTU,MI,HOST,ROUTER source;
  class G,M,RX,PROCESS service;
  class RAW,JOBS,FRAMES,LOCAL,CLOUD,D1 store;
  class VIEWS,DASH query;
  class HEALTH,SLS,ALERT monitor;
  style devices fill:#F8FAFC,stroke:#475569,stroke-width:2px,color:#0F172A
  style ingest fill:#F8FAFC,stroke:#475569,stroke-width:2px,color:#0F172A
  linkStyle default stroke:#334155,stroke-width:2px
```

- 采集服务按通道分组调度；同一串行组内逐台查询。默认间隔为每台 60 秒，慢设备可能使同组后续轮次延后。
- OpenWrt 的 collectd 直接发布到 MQTT，由精确主题映射进入原始层，不经过 Node 网关的发件箱。
- Linux 主机在本机读取内核开放的温度通道，由独立受限 systemd 服务通过 MQTT 主动上报；断网缓存到本机 SQLite，成功 PUBACK 后删除待发项。每台主机使用独立发布账号，入库端只订阅，不通过 SSH 拉取温度。
- 本地 PostgreSQL 和 Supabase 由投递任务独立写入，不是数据库主从复制，也不是跨库原子事务。
- 派生数据目前在视图与 Grafana SQL 查询时计算，没有单独的预计算汇总服务。
- 图中的 SLS 链路用于服务器健康日志。协议帧独立保存在 SQLite；其 SLS 归档属于另行配置的可选能力。
- 原始层 180 天为默认保留策略，未完成的本地任务会暂时阻止对应原文清理；队列另有容量限制。
- 网关发件箱是待发缓存，默认最多 7 天或 10 万条，PUBACK 后删除；EMQX 持久会话也有服务端容量及有效期限制。

## 采集与双写时序图

以采集网关的一条有效 telemetry 消息为例。Linux 主机本地温度服务沿用相同信封与发件箱流程；collectd 的接入从 MQTT 订阅侧开始。
协议帧、retained 最新状态与健康日志走独立路径，此图聚焦业务原文和加工结果。

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#FFFFFF","fontFamily":"Arial, Microsoft YaHei, sans-serif","fontSize":"18px","primaryColor":"#DBEAFE","primaryTextColor":"#0F172A","primaryBorderColor":"#1E3A8A","lineColor":"#0F172A","textColor":"#0F172A","actorBkg":"#1E3A8A","actorBorder":"#0F172A","actorTextColor":"#FFFFFF","actorLineColor":"#475569","signalColor":"#0F172A","signalTextColor":"#0F172A","labelBoxBkgColor":"#DBEAFE","labelBoxBorderColor":"#1E3A8A","labelTextColor":"#0F172A","loopTextColor":"#0F172A","noteBkgColor":"#FEF3C7","noteBorderColor":"#92400E","noteTextColor":"#422006","activationBkgColor":"#DBEAFE","activationBorderColor":"#1E3A8A","sequenceNumberColor":"#FFFFFF"},"sequence":{"mirrorActors":false,"actorFontSize":18,"messageFontSize":17,"noteFontSize":17,"wrap":true}}}%%
sequenceDiagram
  autonumber
  participant D as 设备 / 网关
  participant G as 采集服务<br/>含 SQLite 发件箱
  participant M as EMQX
  participant I as Ingestor<br/>含本地 SQLite
  participant P as 本地 PostgreSQL
  participant S as Supabase
  participant C as Worker / D1

  G->>D: 到期只读查询，默认每台 60 秒
  D-->>G: 返回读数 / 网关缓存状态
  G->>G: 校验报文、单位、时间<br/>生成消息 ID，提交发件箱事务
  Note over D,G: 读取失败仅记录错误状态，不产生零读数<br/>未知测量时间保持 NULL
  G->>M: PUBLISH telemetry，QoS 1，非 retained

  par 发布侧确认
    M-->>G: 成功 PUBACK
    G->>G: 删除对应待发项
  and 订阅侧持久接管
    M->>I: 投递订阅消息，QoS 1
    I->>I: 原文 + 哈希 + 初始任务<br/>提交 SQLite 事务
    I-->>M: 提交成功后 PUBACK
  end
  Note over M,I: 两段 MQTT 确认独立<br/>入库端确认表示本地持久接管

  par 本地处理与 PG 投递
    I->>I: 版本化加工<br/>原子保存结果及两个投递任务
    par 本地目标
      I->>P: INSERT，按消息 ID 去重
      P-->>I: 提交成功 / 重复记录哈希一致
      I->>I: 仅标记本地目标已完成
    and 云端目标
      alt 仍在 Supabase 保留窗口内
        I->>S: INSERT，按消息 ID 去重
        alt 写入确认成功
          S-->>I: 提交成功 / 重复记录哈希一致
          I->>I: 仅标记 Supabase 已完成
        else 连接失败或确认丢失
          I->>I: 保留任务，退避后补报<br/>ID 和哈希不变，其他目标继续
        end
      else 已超过保留窗口
        I->>I: 标记 expired<br/>本地 PG 与原始层任务继续
      end
    end
  and 原始云端副本
    opt 已启用 D1 归档
      I->>C: HTTPS 批量提交原文 / ID / 哈希
      C-->>I: D1 事务提交后返回匹配确认
      I->>I: 仅标记 D1 目标已完成
    end
  end
  Note over I,C: 各目标独立确认与重试，最终一致<br/>消息 ID 与哈希支持幂等校验
```

PUBACK 不表示两个 PostgreSQL 已全部提交。目标连接故障保留任务并重试，
永久数据错误进入失败状态等待处理；同 ID 不同哈希不会覆盖已有记录。
Grafana 使用专用只读角色查询本地限定视图，公开看板只允许用电展示。
