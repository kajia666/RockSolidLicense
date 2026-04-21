# RockSolidLicense

面向商业软件授权、网络验证与终端分发的服务端 + Web 后台 + Windows C/C++ SDK 项目。

当前仓库已经覆盖一条可运行的主链路：

- 软件作者在后台创建产品、授权策略、卡密和版本规则
- 终端用户可以注册账号后充值卡密，也可以直接使用卡密登录
- 服务端按策略校验机器绑定、会话状态、版本规则、公告维护窗口与网络规则
- 登录成功后签发 RSA `licenseToken`，并通过心跳维持在线状态
- Windows C/C++ SDK 已支持 HTTP/TCP 通信、签名、令牌验签、版本检查、公告拉取、启动决策辅助、结构化错误处理、绑定查询和自助解绑
- SDK 交付物现在同时提供高层 demo、项目级 host skeleton、可直接下发 `rocksolid_host_config.env`、`CMakeLists.txt`、VS2022 `.vcxproj/.vcxproj.filters/.props/.local.props/.sln` 与项目级 quickstart 的宿主工程骨架、hardening guide 和发布/接入包模板，方便软件作者按项目策略接入

这套系统现在更偏向“网络验证 / 软件授权平台”，而不是账单结算系统。代理、库存和结算相关能力保留为辅助运营模块，不是当前仓库的唯一重心。

建模说明：

- 仓库里的 `product` 就是“软件作者的一个软件 / 一个项目”
- `products.id` 是内部主键
- `products.code` 是对外稳定的项目编码，也可以理解成 `projectCode` 或 `softwareCode`
- `products.owner_developer_id` 表示这个项目归属的开发者账号
- `sdkAppId` / `sdkAppSecret` 是 SDK 请求签名凭据，不等同于项目编码

## 核心能力

### 卡密管理

- 批量生成卡密
- 支持时长卡与点数卡
- 卡密导出与状态区分
- 卡密冻结、过期、撤销控制
- 账号充值卡密
- 卡密直接登录

### 用户授权

- 账号注册、登录、退出
- 卡密直登与账号模式双认证
- 机器绑定、换绑检测、手动解绑
- 软件作者自定义硬件/IP 绑定字段
- 是否允许多开由策略控制
- 授权冻结、恢复、续期
- 点数授权登录扣点
- 管理后台授权运营快照导出
- 开发者运营台问题快照导出
- 运营快照概览支持高频原因、重点账号/会话/设备明细、严重级别/处置建议、推荐处置队列、推荐操作预填与一键筛选回填

### 软件管理

- 项目编码 / 名称 / 描述编辑
- 项目启用 / 停用 / 归档
- 项目状态批量切换
- 产品级功能开关
- 项目级授权预设（Hybrid Launch / Account + Recharge / Direct Card / Account Only）
- 项目 SDK 凭据轮换
- 批量 SDK 凭据 / 集成包 / 发版包导出与 zip 下载
- 开发者接入中心单项目集成包直接下载，并支持单独下载项目级 C++ host skeleton、`rocksolid_host_config.env`、`CMakeLists.txt` 与 VS2022 `.sln/.vcxproj/.vcxproj.filters/.props/.local.props/.md`
- 项目中心 / 接入中心 / 发版中心跨页预填联动
- 项目页发版快速信号摘要
- 项目页内联发版 readiness 预览，可按 channel 直接查看候选版本、阻断项、检查清单和下一步动作；项目页也支持同 channel 的 integration snapshot 预览，以及一键 `Preview Launch Workflow` 加载统一的 launch workflow package，在同页查看 workflow blocker / checklist / next steps / recommended workspace，并直接下载 launch `handoff-zip / summary / checklist / checksums / zip`、release `summary / checksums / zip` 以及常用 integration `json / env / host-config / checksums / cpp / cmake / vs2022-guide / vs2022-sln / vs2022 / vs2022-filters / vs2022-props / vs2022-local-props / host-skeleton / zip`
- 项目页现在可直接按授权预设切换首发登录策略，并在 launch workflow 发现“无登录路径 / 禁止注册但无初始账号”这类阻断时回落到 `auth-preset` 焦点，帮助软件作者更快修正首发授权链
- 开发者授权中心现在补了 `Launch Authorization Quickstart`，会按项目当前登录模式、策略数、卡密库存、起步账号状态给出首发建议，并能一键预填 starter duration / points policy、starter card batch 和 starter account；当项目走账号登录但关闭公开注册时，也可以直接在授权中心补首发种子账号；如果登录路径已经合理，还可以直接运行一键 `Launch Bootstrap`，自动补齐缺的 starter policy / fresh card batch / starter account；对于同时启用直登卡和充值卡的 lane，bootstrap 也会把两类推荐 starter batch 一起补齐，不会只补半套；对于账号制但不开直登卡/充值卡的 lane，也会自动用内部 seed card 补出一条 starter entitlement，方便首发前先做 QA / 支持 smoke test
- 这条授权快启链现在还会把执行结果直接接到 `Next Launch Follow-up` 上：跑完 `Launch Bootstrap`、`First Batch Setup`、`Inventory Refill` 之后，开发者授权中心会直接给出下一步该去的工作台和可下载的首轮巡检摘要，减少软件作者再手工判断“接下来先看登录、卡密兑换还是会话状态”
- 开发者授权中心现在还支持一键 `First Batch Setup`：对启用直登卡 / 充值卡的项目，可以直接按推荐方案创建首批 `direct-card` / `recharge` 卡密批次，而不只是把建议预填到表单里；如果推荐前缀下已经有 fresh inventory，也会自动跳过，减少重复发卡
- 这条首批发卡链现在又往前推了一层：如果推荐批次已经建过、但库存掉到首发缓冲线以下，系统会把它识别成 `low inventory`，并在开发者授权中心、上线工作台、项目页里直接给出 `Run Inventory Refill / Refill Direct-Card Batch / Refill Recharge Batch`，把库存补回推荐首发水位，而不是继续误导软件作者重复跑 `First Batch Setup`
- 上线工作台和项目页内联 `Launch Workflow` 现在也能直接运行 `Launch Bootstrap`。如果当前 lane 的首发授权缺项可以自动补齐，摘要、action plan、checklist 和主操作区都会给出一键入口，执行后会自动刷新当前 lane，减少先跳到授权页再返回的往返
- 如果当前 lane 已经有 starter policy、但还没有首批 fresh card inventory，上线工作台和项目页内联 `Launch Workflow` 现在也会直接给出 `Run First Batch Setup`。这会按推荐方案创建首批 `direct-card` / `recharge` 库存；而在还没有 policy 的场景下，工作台会继续优先给 `Launch Bootstrap`，避免把一个暂时不可执行的发卡动作提前亮出来
- 现在 `Launch Authorization Quickstart`、`Launch Workflow` 和项目页内联 launch summary 还会给出结构化的“首批库存建议 / 首批发卡建议 / 首发后第一轮运营动作”，帮助软件作者把首发准备、首批发卡和上线后前几小时的运营检查连成一条更实操的链路
- 这条“首发后第一轮运营动作”现在也已经接到了开发者运营台 `/developer/ops`：launch workflow 和项目页里的 `First Ops Actions` 可以直接把软件作者路由到 snapshot / audit / sessions 焦点，方便首发后立刻盯登录、心跳、审计和设备状态；这些路由也可以继续带上更细的 audit filter，比如 `eventType / actorType / entityType`
- 现在这条首发后的 ops 巡检也不只靠跳页了：`Launch Workflow` 和项目页内联 launch block 里的 `First Ops Actions`、相关 `Action Plan` 现在可以直接下载带过滤条件的 ops snapshot summary，方便把首轮巡检结果直接发给测试、客服或值守同事复核
- 这些首发后的 ops 动作现在也会进入 `Launch Workflow` 的 `Action Plan` 和导出文本里，所以交付给测试、运营或值守同事时，不只是知道“去哪”，还会知道“应该先看哪类信号”
- 开发者运营台现在还会把这类 routed 首发 follow-up 继续收成 `Route Review`：页面会直接总结当前路由命中的账号、授权、会话、设备、审计数量，保留高亮审计事件，并在对应表格里用高亮行标出命中的 scoped 记录，减少首发巡检时的人工筛选
- 这块 `Route Review` 现在还会吃一份服务端生成的 routed review payload，直接把当前 `focus / primaryMatch / nextMatch` 一起下发到 `/developer/ops` 和导出摘要里，减少 Launch Review、Launch Smoke、Developer Ops 三边各自猜“当前最该先看谁”的偏差
- 现在这份服务端 routed review payload 还会继续下发过滤后的 `remainingMatches`、`continuation` 和对象化下载描述，所以“下一个对象 / 剩余队列 / 继续复查”这条链已经更统一地回到后台/API 主线上，而不是再主要靠前端自己重排和拼参数
- 同时这份 payload 现在也会下发过滤后的 `matchedIds`，所以 `Developer Ops` 里的命中高亮、`Show Routed Hits Only` 和后续 routed review 流转也开始优先吃服务端命中集合，进一步减少前端自己重跑匹配逻辑的偏差
- 现在 routed review 里按区块导出的 `Accounts / Entitlements / Sessions / Devices / Audit` 摘要，也开始由服务端直接下发下载描述，`Developer Ops` 只做消费，不再主要靠前端自己拼 section 过滤参数
- 同时 routed review 里按区块“先看哪个对象”这层也开始由服务端下发 `sections.*.primaryMatch`，所以 `Review Accounts / Sessions / Audit` 这类动作不再主要靠前端自己从本地数组里挑第一个对象
- 现在 routed review 还会按“当前正在处理的是哪个对象”直接下发对象化的 `continuations`，所以 `Developer Ops` 里从当前 focus 继续看下一个对象时，也开始优先吃服务端给出的 continuation，而不是再主要靠前端自己从队列里推下一个目标
- 这块 `Route Review` 顶部动作现在也开始由服务端下发 `actions`，所以 `Prepare / Review / Download` 这批按钮不再主要靠前端自己按命中结果临时拼出来，而是更统一地回到后台/API 主线上
- 现在 `/api/developer/ops/export/download` 也能直接下发服务端选中的 `route-review-primary / route-review-next / route-review-remaining` 摘要，所以 Launch Review、Launch Smoke 和后续 handoff 可以更稳定地围绕“当前主复查对象 / 下一个对象 / 剩余复查队列”交接，而不是继续靠前端自己重组过滤条件
- 这块 `Route Review` 现在还能直接切到 `Show Routed Hits Only`，并一键跳去复查 `accounts / entitlements / sessions / devices / audit` 中命中的那一类对象，让首发后的复查链更像一个连续动作，而不是先看摘要再自己手工筛表
- 现在这块 routed review 还会自动抽出一个 `Primary Match`，把首个命中的账号 / 授权 / 会话 / 设备 / 审计衍生对象直接预填进 quick controls，并保留到 `Prepared Control` 回执里；开发者运营台里的表格点击也统一走这条 focus-preparation 逻辑，所以从 `Launch Review` 跳进来后的复查会更像“已经帮你选好当前最该看的对象”
- 这块 `Route Review` 现在还可以直接 `Review Primary Match` 和 `Download Primary Match Summary`，也就是软件作者从 `Launch Review` 跳进 `Developer Ops` 后，不只是知道当前主匹配对象是谁，还能围绕这个对象直接开始复查或导出更聚焦的一份摘要
- 现在这块 `Route Review` 也会直接吃服务端下发的 `primary / next / remaining` 下载描述，所以 `Download Primary Match Summary / Next Match Summary / Remaining Queue Summary` 这三条 handoff 已经开始统一走 API 主线，而不是主要靠前端自己拼参数
- 同一块 `Route Review` 现在也支持按命中的对象类型直接导出 `Accounts / Entitlements / Sessions / Devices / Audit` 摘要，所以首发后的 handoff 和异常回看不需要先手动重组过滤条件
- 现在从 Launch Workflow、项目页内联 launch summary、授权快启跳进开发者运营台时，也会把 `reviewMode=matched` 一起带过去，让首发后的 ops 复查默认就落在更窄的命中视图里
- 授权快启页现在也会保留 `Last Quickstart Action` 回执，直接总结 bootstrap / 首批发卡 / 补库存前后的 `policies / freshCards / accounts / activeEntitlements` 变化，并列出这次新建出来的 starter batch、starter account 或 internal entitlement，方便软件作者确认这一步到底补上了什么
- 这条首发 follow-up 现在也不再是一上来就跳 ops 了：跑完 `Launch Bootstrap`、`First Batch Setup`、`Inventory Refill` 之后，系统会先给出 `Review launch workflow recheck`，并在适用时加上 `Review starter inventory / Review refilled launch inventory`，让软件作者先确认 launch lane 和 starter inventory 已经恢复到预期，再进入首轮 runtime / redemption / session 巡检
- 开发者授权中心里的 `Next Launch Follow-up` 现在也能直接下载 launch workflow summary / checklist，不再只支持 ops 摘要，这样软件作者在授权快启页里做完初始化动作后，可以先拿走 launch 复查材料，再继续点进 launch workflow、license workspace 或 developer ops
- 现在这条 follow-up 还多了一份合并的 `launch review summary`：它会把当前 lane 的 launch workflow 复查结果和带过滤条件的 developer ops snapshot 收进一份文件里，适合在跑完 `Launch Bootstrap`、`First Batch Setup`、`Inventory Refill` 后，直接发给 QA、客服或值守同事做首轮复查
- 现在这条首发初始化链还会产出一份 `launch smoke kit`：它会把当前 lane 的 startup bootstrap 请求、内部账号候选、starter entitlement 候选、fresh 直登卡/充值卡候选，以及首轮 smoke-test 路径收成一份可下载摘要，方便 QA、客服或值守同事在首发前后直接照着跑内部验证
- 现在这条 smoke 验证链还有了独立的 `/developer/launch-smoke` 工作台，不再只是下载一个摘要文件。软件作者可以直接在这个页面里看启动请求、smoke path、内部候选账号/授权/卡密，并顺着打开 `Launch Workflow / Launch Review / Developer Ops`
- `Launch Smoke` 现在也不只是“看烟雾测试材料”了：如果当前 lane 还缺 starter policy、首批卡密或补库存，这个工作台也能直接运行 `Launch Bootstrap / First Batch Setup / Inventory Refill`，并把 `Last Smoke Action` 和下一步 follow-up 留在当前页，减少再切回别的工作台补动作
- 这页现在还会直接给出 `Review Targets`，把首个烟雾验证后最该看的账号、授权、卡密库存、会话或审计目标直接变成可点击入口，进一步缩短 `Launch Smoke -> Launch Review / Developer Ops / License Workspace` 的复查链
- 这些 `Review Targets` 现在在能定位到具体对象时，也会把 direct focus 一起带进下一工作台，所以从 `Launch Smoke` 跳到 `Developer Ops` 或其他复查页时，会更接近“已经替你选好当前最该复查的对象”
- `Launch Smoke` 现在还会把最重要的那个复查对象单独顶成 `Primary Review Target`，让值守或 QA 先开最关键的一步，再决定是否继续看完整的 review target 列表
- 这两个 `Primary Review Target` 现在也都会优先下发更窄的 `Primary match summary`，而不是退回到整块 `accounts / sessions / audit` 摘要，所以首轮 handoff 会更聚焦在当前最该复查的那一个对象
- 这两个 `Primary Review Target` 现在连跳转按钮文案也统一收成了 `Review Primary Match in Ops`，这样软件作者或值守同事看到按钮时，就能更直接判断“点下去会立即围绕主复查对象继续看”，而不是再猜是不是只是打开一个总览页
- 现在这两个 `Primary Review Target` 的窄摘要也正式并进了 `Launch Review / Launch Smoke` 的顶层推荐下载里，所以到页后不必先展开目标区块找按钮，直接就能把当前最关键对象的复查摘要拿走
- 现在这两个工作台的顶层推荐下载里，还会顺手带上 `Remaining matches summary`，所以首轮 handoff 不只是围绕主对象，也能把主对象之后剩下的复查队列一起交给 QA、客服或值守同事
- 这条“剩余复查队列”现在也已经正式并进 `Launch Review / Launch Smoke` 的 action plan，所以主链不只是多一个下载入口，而是会明确告诉软件作者：处理完主对象后，下一步该把剩余队列怎么交接出去
- 现在这两个工作台还会把 routed review 的 `continuation` 也直接并进 action plan 和推荐下载里：如果还有下一个命中对象，就直接给 `Continue Routed Review + Next Match Summary`；如果这一轮已经看完，就会自然切成 `Complete Routed Review + Routed Summary`，这样主链不需要再靠前端自己猜后续该继续还是该收尾
- 同时，这两个 `Primary Review Target` 现在也会提前出现在 `Launch Review / Launch Smoke` 顶层的工作台动作里，所以到页后不需要先往下滚到目标区块，最上面就能直接点进主复查对象
- 它们现在也已经正式并进 `Launch Review / Launch Smoke` 的动作计划里，所以这一步不只是“一个重点目标”，而是更像系统已经帮软件作者把“先看这个对象”排进了当前流程
- 现在这两个 `Primary Review Target` 在落到 `/developer/ops` 时，也会默认走更直接的 `Open Primary Control` 路线；如果当前对象已经有推荐处理动作，就会直接把主控制入口准备好，没有的话也会自然回退到主复查对象本身，继续减少 `Launch Review / Launch Smoke -> Developer Ops` 之间的手工判断
- 因为这条主链现在默认已经是 `control-first`，所以 `Launch Review / Launch Smoke` 顶层的主复查按钮也已经统一改成更直白的 `Open Primary Control in Ops`，不再让软件作者看到 “Review” 文案却实际落到处理入口
- 这条对齐现在也已经扩到导出的复查摘要里：`Primary Review Target` 的 `action=` 会明确写成 `Open Primary Control`，这样页面内按钮、路由动作和 handoff 文本三边口径一致
- 现在这条 `control-first` 也开始扩到普通 `review targets`：只要某个 `Launch Review / Launch Smoke` 目标已经能定位到具体账号、授权或会话对象，底层就会默认走 `control-primary`，所以软件作者点进目标后会更接近直接进入建议处理动作，而不是先落到列表再自己找下一步
- 这批能直达具体对象的 `review targets`，现在连按钮文案也一起切成了 `Open Primary Control in Ops`，不再一边底层走 `control-primary`、一边表面还写着旧的 `Review ...` 语义
- 进一步地，这批 `control-first review targets` 现在会按对象类型直接下发更具体的控制标签，比如 `Open Account / Entitlement / Session Control in Ops`，不只是泛化成一条 `Primary Control`，这样主链 payload、导出摘要和页面动作都更像可执行运营指令
- 这层对象化控制标签现在也已经扩到 `Primary Review Target` 自身，所以 `Launch Review / Launch Smoke` 顶层主复查对象、动作计划、工作台动作和摘要文本，会一起更明确地告诉你当前是在开哪一类对象控制，而不是继续停留在泛化的 `Primary Control`
- 进一步地，这些对象化控制现在连 routeAction 本身也一起具体化了：主链不再只下发泛化的 `control-primary`，而是会明确区分 `control-account / control-entitlement / control-session / control-device`，这样后台/API、导出摘要和 `Developer Ops` 路由语义都会更贴近真实运营动作
- 同时，`Primary Review Target` 关联的首份 ops 摘要现在也会按对象类型分化成更具体的 handoff 文件，比如 `primary-account / entitlement / session / device summary`，不再统一落成一份泛化的 `primary-summary`，这样 QA、客服和值守同事拿到的第一份复查材料会更聚焦
- 这层对象化现在也已经扩到 `Launch Review / Launch Smoke` 的 action plan：主复查步骤不再只是泛化的 “open primary control”，而是会明确写成 `open the primary account / entitlement / session / device control`，让主链从 payload、按钮、下载到步骤本身都更一致
- 上线工作台和项目页现在还会在页面内保留 `Last Launch Action` / follow-up 卡片：跑完 `Launch Bootstrap`、`First Batch Setup`、`Inventory Refill` 之后，不只是状态栏提示一下，还会把下一步推荐工作台和可下载的首轮巡检摘要继续留在当前页面，方便软件作者顺着做完下一步
- 现在还新增了独立的 `/developer/launch-review` 工作台，把当前 lane 的 launch workflow 和带过滤条件的 developer ops snapshot 合并到一个复查页里，适合在跑完 `Launch Bootstrap`、`First Batch Setup`、`Inventory Refill` 后，直接做首轮复查或交给 QA / 客服 / 值守同事
- 这条 `Launch Review` 现在还会直接给出推荐工作台、复查动作计划和推荐下载，不只是把 launch 和 ops 放在同一页里，软件作者也能更快知道下一步该开哪个工作台、拿哪份摘要
- 现在 `Launch Workflow / Launch Review / Launch Smoke` 三条主链 payload 也已经统一带上服务端生成的 `mainline gate`，会直接给出统一的放行状态、阻断/关注计数、推荐工作台、主动作和推荐下载；对应导出摘要里也会打印同一节 `Launch Mainline Gate`，减少页面和 handoff 各自解释主线状态的偏差
- `Launch Review` 现在还可以直接运行 `Launch Bootstrap / First Batch Setup / Inventory Refill`，并在页内保留 `Last Review Action` 回执，所以软件作者在复查页里就能直接修正 starter policy、首批库存或补库存动作，再顺着做下一步 launch recheck
- `Launch Review` 现在还会把复查目标细化成 `accounts / entitlements / sessions / devices / audit` 级别的 routed review targets，软件作者可以直接从复查页跳到最贴合的 `Developer Ops` 区块，而不只是泛化地“去 ops 看看”
- `Launch Review` 现在也会像 `Launch Smoke` 一样，把最重要的那个 routed follow-up 顶成 `Primary Review Target`，让值守或 QA 先开最关键的复查对象，再决定是否继续展开完整的 review target 列表
- 这批 `Launch Review` 复查目标现在还会继续带 `routeAction` 进 `Developer Ops`，比如 `Review Sessions / Review Accounts / Review Audit`，所以从复查页跳到运营台时，不再只是到对的页面，而是更接近直接落到当前该做的那一步
- 现在这两个工作台里的 `Primary Review Target / Review Targets` 还会直接带上服务端生成的 `recommendedControl`，并且主复查对象会优先挑“已经有明确控制建议”的目标；这样主链摘要里已经能直接看到 `control=...`，不再只剩路由动作让前端自己猜下一步
- 这批主复查步骤现在连 `action plan` 标题也会直接落成服务端给出的控制建议，比如 `Prepare account re-enable / session review / point top-up`，而不是继续停在泛化的 `Open the primary ... control`
- 现在这层对象化控制也不只限于 `Primary Review Target` 了，`Launch Review / Launch Smoke` 里那些能直接落到账号、授权、会话、设备的 review target 步骤，也会优先把 `Prepare ...` 控制建议带进 action plan，继续减少值守时的二次判断
- 与此同时，`Developer Ops` 现在也已经真正吃下服务端给的通用 `focus_account / focus_entitlement / focus_session / focus_device` 控制，所以即便某一步只有“聚焦到对象控制”而不是更细的恢复/续期/补点建议，工作台也能直接把对应对象控制准备好
- 现在连 `Developer Ops` 里的 `Review Primary Match / Review Accounts / Review Sessions / ...` 这批 routed review 动作，也会在合适时直接顺手把主控制准备好，并明确回显 `Primary control ready while reviewing`，而不是只停在“Primary match ready”
- 这条 routed 复查链现在还会把 `Next Match` 单独顶出来：值守或 QA 看完当前主对象后，不用回头重新扫整组命中列表，可以直接顺着 `Review Next Match` 进入下一个命中对象，并继续带上推荐控制准备
- 同时，这个 `Next Match` 现在也能直接导出 `Next Match Summary`，所以首轮 handoff 或异常回看不只围绕当前主对象，连下一个命中对象的聚焦摘要也能顺手拿走
- 进一步地，如果这个下一个命中对象本身已经有推荐控制，`Developer Ops` 现在也能直接 `Open Next Control`，这样从主对象切到下一个对象时，不会又退回到“先看对象、再找处理入口”的半手工状态
- 开发者发版中心现在也补上了结构化的 `Release Mainline Follow-up`。生成 release package 后，发版页会直接告诉软件作者下一步更该去 `Release / Launch Workflow / Launch Review / Integration` 哪个工作台，并把 `Release checklist / Launch review summary / Launch smoke kit summary` 这些更贴近主链的下载一起挂出来；release package 也正式支持单独下载 `checklist`
- 这条 `Release Mainline Follow-up` 现在也不只是告诉人“该去哪里”了：当 lane 还缺 starter policy、starter account 或首批库存时，发版页已经可以直接运行 `Launch Bootstrap / First Batch Setup / Inventory Refill`，并把结果保留在 `Last Mainline Action` 回执里，方便发版值守顺着继续做下一步复查
- 上面这些首发建议现在也不只是说明文字了，软件作者可以直接从建议旁边跳到授权预设、授权中心、上线工作台、发版工作台、开发者运营台，或者直接运行 `Launch Bootstrap`；首批直登卡/充值卡建议也会按推荐的批次数量和前缀直接预填到发卡表单里，把“看建议 -> 去处理”压成更短的动作链
- 现在这条“首批发卡建议”还进一步落成了真正可执行动作：既可以继续 `Review Template` 手工确认，也可以直接在授权快启里运行一键首批发卡初始化，把推荐的首批直登卡 / 充值卡库存直接创建出来
- 开发者多项目归属
- 开发者主账号 + 子账号
- 子账号按项目授权与角色控制
- 客户端版本规则
- 强制升级与升级建议
- 客户端公告与维护通知
- 维护期间阻断登录
- SDK 启动期版本检查、公告拉取和本地启动决策

### 验证接口

- HTTP 客户端接口
- TCP 客户端接口
- 登录验证
- 心跳保活
- 卡密充值
- 绑定查询
- 自助解绑

### 安全与控制

- HMAC-SHA256 SDK 请求签名
- RSA 授权令牌签发与公钥验签
- 多公钥 `kid` 发布与轮换
- 设备封禁
- IP / CIDR 网络规则
- 在线会话控制与强制下线
- 审计日志

### 代理与隔离

- 无限级代理基础模型
- 库存下发与层级隔离
- 可选查看下级范围
- 代理价格与结算能力保留，但不是当前主要开发重点

## 项目结构

- `src/`：服务端、HTTP/TCP 网关、后台页面
- `sdk/`：Windows C/C++ SDK、示例和构建说明
- `docs/`：架构、协议、部署和运营文档
- `test/`：Node 端到端回归测试
- `deploy/`：Windows / Linux 部署骨架

常用说明文档：

- [开发者子账号与项目级权限](docs/developer-members.md)
- [开发者接入中心](docs/developer-integration.md)
- [开发者上线工作台](docs/developer-launch-workflow.md)
- [开发者项目工作台](docs/developer-projects.md)
- [开发者授权策略与卡密工作台](docs/developer-license.md)
- [开发者授权运营台](docs/developer-ops.md)
- [开发者发版工作台](docs/developer-release.md)

补一句定位说明：这里的“开发者接入中心 / 发版中心 / 上线工作台”都是给软件作者自己和他的开发、测试、发布同事使用的后台工作台，不是给终端用户下载最终加密后软件的页面。正常流程仍然是软件作者接入 SDK、保护并构建自己的软件，然后再把最终客户端分发给自己的用户。

现在开发者项目中心、上线工作台、接入中心、发版中心之间支持基于 `productId / productCode / channel` 的跨页预填，软件作者可以带着当前项目上下文在几个工作台之间切换，减少重复手填项目编码。上线工作台本身也支持直接下载 linked release summary、integration env、host config、CMake 模板、VS2022 quickstart、C++ quickstart 和 host skeleton，方便把首发 handoff 资料一次拿齐；如果从别的工作台带 `autofocus=handoff` 跳过去，登录或刷新后也会优先自动拉起对应 lane 的 launch workflow，而且这些 linked release / integration 资料现在也可以统一从 `/api/developer/launch-workflow/download` 下发。推荐工作台跳转现在还会继续带上更细的 `autofocus`，把软件作者直接落到项目页的功能配置、接入页的启动/加固区块、发版页的版本/公告区块，或者开发者运营台的 `snapshot / audit / sessions` 巡检焦点，而不只是跳到某个页面。项目页和上线工作台现在还会把前几个 `workspaceActions` 直接渲染成按钮，减少“先看摘要再自己判断该点哪个页面”的来回；同一块摘要里的前几个 `recommendedDownloads` 也会直接渲染成按钮，让软件作者在 summary 里就能把 lane 最推荐的 handoff 文件拿走。现在连 launch workflow checklist 里的重点检查项也会带上“打开对应工作台 / 下载对应文件”的快捷动作，把“发现问题 -> 去处理”这条链再压短一层；而新的 `Action Plan` 会把当前 lane 最值得先做的几步直接排出来，进一步减少软件作者自己翻译摘要的成本。对于能自动补齐的授权缺项，上线工作台和项目页现在还会直接给出 `Run Launch Bootstrap`，并在执行后自动刷新当前 lane，让 starter policy / card batch / starter account 这类首发资产可以从更前面的工作台直接补齐。项目页、接入页、发版页和运营页现在都会把 routed `autofocus` 解释成更具体的 `Route Focus` 卡片，让软件作者点进来后马上知道“为什么落在这里、先点哪几个动作”，而不只是滚到某一段；现在这些跨页跳转还会继续带上 `routeTitle / routeReason`，把“是哪个 launch workflow 步骤或项目 handoff 把你送到这里”的上下文也一起保留下来。新增的 `handoff-zip` 会输出一份更适合发给集成、测试、发布同事的精简材料包，而完整 `zip` 继续保留更全的 workflow / release / integration 归档内容。上线工作台现在还会额外检查“授权就绪度”，也就是登录路径、起步策略、卡密库存、起步账号这些会直接影响首发销售和验证的核心条件；一旦发现这类问题，它不仅可以把软件作者路由到开发者授权中心 `/developer/licenses`，也能在 launch workflow 和项目页里直接执行自动补齐动作。

## 快速导航

- 想先跑起来：直接看 [本地运行](#本地运行)
- 想先分清“软件作者后台工作台”和“终端用户使用流程”：先看上面的工作台定位说明，再看 [终端用户主流程](#终端用户主流程)
- 想理解终端主链路：直接看 [终端用户主流程](#终端用户主流程)
- 想找接口：直接看 [接口摘要](#接口摘要)
- 想看 SDK 能力：直接看 [Windows C/C++ SDK](#windows-cc-sdk)
- 想部署到服务器：直接看 [部署建议](#部署建议) 和 [重点文档](#重点文档)

## 本地运行

### 启动服务端

```bash
node src/server.js
```

默认入口：

- 管理后台：`http://127.0.0.1:3000/admin`
- 产品中心：`http://127.0.0.1:3000/admin/products`
- 开发者中心：`http://127.0.0.1:3000/developer`
- 开发者接入中心：`http://127.0.0.1:3000/developer/integration`
- 开发者上线工作台：`http://127.0.0.1:3000/developer/launch-workflow`
- 开发者项目中心：`http://127.0.0.1:3000/developer/projects`
- 开发者授权中心：`http://127.0.0.1:3000/developer/licenses`
- 开发者运营台：`http://127.0.0.1:3000/developer/ops`
- 开发者发版中心：`http://127.0.0.1:3000/developer/releases`
- 开发者安全中心：`http://127.0.0.1:3000/developer/security`
- 公告中心：`http://127.0.0.1:3000/admin/notices`
- 健康检查：`http://127.0.0.1:3000/api/health`
- TCP Gateway：`tcp://127.0.0.1:4000`

默认管理员账号：

- 用户名：`admin`
- 密码：`ChangeMe!123`

建议通过环境变量覆盖生产配置：

```bash
RSL_HOST=0.0.0.0
RSL_PORT=3000
RSL_TCP_ENABLED=true
RSL_TCP_HOST=0.0.0.0
RSL_TCP_PORT=4000
RSL_DB_PATH=./data/rocksolid.db
RSL_MAIN_STORE_DRIVER=sqlite
RSL_STATE_STORE_DRIVER=sqlite
RSL_POSTGRES_URL=
RSL_POSTGRES_PG_MODULE=pg
RSL_POSTGRES_PG_MODULE_PATH=
RSL_POSTGRES_POOL_MAX=10
RSL_REDIS_URL=
RSL_REDIS_KEY_PREFIX=rsl
RSL_LICENSE_PRIVATE_KEY_PATH=./data/license_private.pem
RSL_LICENSE_PUBLIC_KEY_PATH=./data/license_public.pem
RSL_TOKEN_ISSUER=RockSolidLicense
RSL_ADMIN_USERNAME=admin
RSL_ADMIN_PASSWORD=PleaseChangeThisNow
RSL_DEVELOPER_SESSION_HOURS=24
```

### 运行测试

```bash
npm test
```

### PostgreSQL 引导脚本

仓库已经提供了 PostgreSQL 主库初始化脚本和 main-store 迁移边界，便于把当前单机 SQLite 逐步推进到更适合正式部署的结构：

```bash
npm run db:postgres:init
npm run db:postgres:check
```

对应文件：

- [init.sql](deploy/postgres/init.sql)
- [render-postgres-init.mjs](scripts/render-postgres-init.mjs)
- [storage-platform-guide.md](docs/storage-platform-guide.md)
- [postgres-main-store-preview.md](docs/postgres-main-store-preview.md)

当前主数据访问层已经统一收进 `mainStore`：

- [main-store.js](src/data/main-store.js)
- [sqlite-main-store.js](src/data/sqlite-main-store.js)
- [postgres-main-store.js](src/data/postgres-main-store.js)
- [product-repository.js](src/data/product-repository.js)
- [policy-repository.js](src/data/policy-repository.js)
- [card-repository.js](src/data/card-repository.js)
- [entitlement-repository.js](src/data/entitlement-repository.js)
- [client-version-repository.js](src/data/client-version-repository.js)
- [notice-repository.js](src/data/notice-repository.js)
- [network-rule-repository.js](src/data/network-rule-repository.js)
- [postgres-product-store.js](src/data/postgres-product-store.js)
- [postgres-policy-store.js](src/data/postgres-policy-store.js)
- [postgres-client-version-repository.js](src/data/postgres-client-version-repository.js)
- [postgres-client-version-store.js](src/data/postgres-client-version-store.js)
- [postgres-notice-repository.js](src/data/postgres-notice-repository.js)
- [postgres-notice-store.js](src/data/postgres-notice-store.js)
- [postgres-network-rule-repository.js](src/data/postgres-network-rule-repository.js)
- [postgres-network-rule-store.js](src/data/postgres-network-rule-store.js)

当前 `RSL_MAIN_STORE_DRIVER` 支持：

- `sqlite`：默认主数据访问层，读写都走当前 SQLite 主库
- `postgres`：当前已经进入 PostgreSQL preview，阶段取决于 adapter 能力

当前 PostgreSQL runtime adapter 已经支持直接加载 `pg` 风格连接池模块：

- 默认读取 `RSL_POSTGRES_PG_MODULE=pg`
- 也可以用 `RSL_POSTGRES_PG_MODULE_PATH` 指向自定义模块路径
- `RSL_POSTGRES_POOL_MAX` 控制查询池大小

当前 PostgreSQL preview 分成两层：

- `read_side_preview`：`products / policies / cards / entitlements / accounts / versions / notices / networkRules / devices / sessions` 十组主数据读侧走 PostgreSQL；如果 adapter 还不支持事务接口，写侧仍然继续走 SQLite
- `core_write_preview`：如果 adapter 额外支持事务接口 `withTransaction(...)`，则 `products / policies / cards / entitlements / accounts / versions / notices / networkRules` 八组主数据写侧也会走 PostgreSQL；`devices / sessions` 会进入 `postgres_partial`，其中 `devices` 先覆盖设备指纹落点、绑定身份快照、identity rebound、绑定释放/撤销、设备封禁激活与解封、解绑日志这类运行链路，`sessions` 则先覆盖会话创建、心跳续期、失效回收这类高频路径

当前已经落进 `mainStore` 的十块主数据边界是：

- `products`：项目创建、功能开关更新、SDK 凭据轮换、项目归属切换、签名入口 `sdkAppId` 查找
- `policies`：策略创建、运行时绑定/多开配置、自助解绑配置
- `cards`：批量发卡、卡密冻结/恢复/过期控制，以及 PostgreSQL preview 下给 SQLite 兼容链路补齐卡密与卡密控制信息 shadow
- `entitlements`：卡密充值生成授权、卡密直登激活授权、授权冻结/恢复、续期、点数调账，以及 duration / points 两类 usable entitlement 读取
- `accounts`：终端账号注册、卡密直登账号映射、账号列表、账号禁用/恢复、最近登录时间更新，以及 PostgreSQL preview 下给 SQLite 兼容链路补齐账号与卡密直登映射 shadow
- `versions`：客户端版本创建、状态切换、版本列表、产品级版本规则读取、强更规则聚合统计
- `notices`：公告创建、状态切换、公告/维护通知列表、产品级有效公告读取、阻断公告聚合统计
- `networkRules`：网络规则创建、状态切换、网络规则列表、产品级生效阻断规则读取、项目级活跃网络规则聚合统计
- `devices`：设备指纹记录、绑定身份快照、绑定管理查询、绑定列表/释放、自助解绑计数与日志、设备封禁查找与列表、项目级活跃绑定/封禁聚合统计、登录时设备绑定落点
- `sessions`：登录会话写入、会话列表查询、按 `product + sessionToken` 的会话查找、心跳续期、会话过期扫描、退出登录、会话失效状态更新和项目级在线会话聚合统计

也就是说，现在这套系统已经不是“所有主数据都直接散写 SQLite SQL”了。当前 `卡密充值 -> entitlement 生成 -> 点数计量` 已经收进 `mainStore.entitlements`，而且登录前的 `usable entitlement` 选择和失败时的 `latest entitlement snapshot` 也已经通过这层边界提供；`version rows / notice rows / network rule rows / binding/block list query / session issuance / heartbeat refresh / logout/revoke` 也已经分别收进 `mainStore.versions / notices / networkRules / devices / sessions`。开发者看板里和项目运行状态直接相关的 `activeSessions / activeBindings / blockedDevices / activeClientVersions / forceUpdateVersions / activeNotices / blockingNotices / activeNetworkRules` 统计，也已经通过 `mainStore.sessions / devices / versions / notices / networkRules` 提供项目级聚合入口。在具备事务型 PostgreSQL adapter 时，`products / policies / cards / entitlements / accounts / versions / notices / networkRules` 这八组主数据都已经可以逐步走向 PostgreSQL write preview，其中 `versions / notices / networkRules` 已经覆盖后台创建、状态切换，以及客户端版本检查 / 公告阻断 / 网络规则拦截这类运行读取链路；`cards` 这层现在还会把策略、卡密和卡密控制信息补一份 SQLite shadow，`accounts` 这层会补齐账号与卡密直登映射 shadow，保证 PostgreSQL preview 下原先仍依赖 SQLite 的 `findClientCardByKey`、终端 `register -> recharge -> login`、`card-login` 复用、分销库存、分销价格规则和相关报表链路继续可用；`devices` 目前已经对设备指纹 upsert、绑定身份快照、identity rebound、绑定释放、设备封禁激活/解封、活跃绑定撤销与自助解绑日志提供 `postgres_partial` 写侧预览，`sessions` 则已经对会话创建、会话列表查询、心跳续期、按条件失效回收这条运行主链提供 `postgres_partial` 写侧预览。剩余还没有完全迁走的部分，主要集中在 `devices / sessions` 更深层的 PostgreSQL 写侧收口，以及更多后台运营链路按边界继续迁移，后续会继续按模块推进。

## 终端用户主流程

### 账号模式

1. 客户端启动后调用版本检查和公告接口
2. 用户注册账号
3. 用户使用卡密充值到账号
4. 客户端携带机器指纹登录
5. 服务端校验授权、绑定、版本、公告和网络规则
6. 服务端返回 `sessionToken`、`licenseToken`
7. 客户端按策略发送心跳

### 卡密直登模式

1. 客户端启动后调用版本检查和公告接口
2. 用户直接输入卡密登录
3. 服务端创建卡密直登身份并绑定设备
4. 返回 `sessionToken`、`licenseToken`
5. 客户端持续心跳

## 接口摘要

### HTTP 客户端

- `POST /api/client/register`
- `POST /api/client/recharge`
- `POST /api/client/card-login`
- `POST /api/client/login`
- `POST /api/client/bindings`
- `POST /api/client/unbind`
- `POST /api/client/startup-bootstrap`
- `POST /api/client/version-check`
- `POST /api/client/notices`
- `POST /api/client/heartbeat`
- `POST /api/client/logout`

### 管理后台 API

- `GET /api/admin/products`
- `POST /api/admin/products`
- `POST /api/admin/products/status/batch`
- `POST /api/admin/products/feature-config/batch`
- `POST /api/admin/products/sdk-credentials/rotate/batch`
- `POST /api/admin/products/sdk-credentials/export`
- `POST /api/admin/products/integration-packages/export`
- `POST /api/admin/products/integration-packages/export/download`
- `POST /api/admin/products/:productId/profile`
- `POST /api/admin/products/:productId/status`
- `POST /api/admin/products/:productId/feature-config`
- `POST /api/admin/products/:productId/sdk-credentials/rotate`
- `POST /api/admin/products/:productId/owner`
- `GET /api/admin/developers`
- `POST /api/admin/developers`
- `POST /api/admin/developers/:developerId/status`
- `GET /api/admin/audit-logs`
- `GET /api/admin/ops/export`
- `GET /api/admin/ops/export/download`

管理口径说明：

- 绝大多数写接口仍然兼容 `productCode`
- 现在也接受 `projectCode`、`softwareCode` 作为同义字段
- 管理员现在可以创建开发者账号，并把项目归属到某个开发者名下

### TCP 客户端

- `client.register`
- `client.recharge`
- `client.card-login`
- `client.login`
- `client.bindings`
- `client.unbind`
- `client.heartbeat`
- `client.logout`

### 系统接口

- `GET /api/system/token-key`
- `GET /api/system/token-keys`

### 开发者 API

- `POST /api/developer/login`
- `GET /api/developer/me`
- `GET /api/developer/dashboard`
- `GET /api/developer/integration`
- `GET /api/developer/integration/package`
- `POST /api/developer/logout`
- `POST /api/developer/profile`
- `POST /api/developer/change-password`
- `GET /api/developer/members`
- `POST /api/developer/members`
- `POST /api/developer/members/:memberId`
- `GET /api/developer/products`
- `POST /api/developer/products`
- `POST /api/developer/products/status/batch`
- `POST /api/developer/products/feature-config/batch`
- `POST /api/developer/products/sdk-credentials/rotate/batch`
- `POST /api/developer/products/sdk-credentials/export`
- `POST /api/developer/products/integration-packages/export`
- `POST /api/developer/products/integration-packages/export/download`
- `POST /api/developer/products/:productId/profile`
- `POST /api/developer/products/:productId/status`
- `POST /api/developer/products/:productId/feature-config`
- `POST /api/developer/products/:productId/sdk-credentials/rotate`
- `GET /api/developer/policies`
- `POST /api/developer/policies`
- `POST /api/developer/policies/:policyId/runtime-config`
- `POST /api/developer/policies/:policyId/unbind-config`
- `GET /api/developer/cards`
- `GET /api/developer/cards/export`
- `GET /api/developer/cards/export/download`
- `POST /api/developer/cards/batch`
- `POST /api/developer/cards/:cardId/status`
- `GET /api/developer/accounts`
- `POST /api/developer/accounts`
- `POST /api/developer/accounts/:accountId/status`
- `POST /api/developer/license-quickstart/bootstrap`
- `POST /api/developer/license-quickstart/first-batches`
- `GET /api/developer/entitlements`
- `POST /api/developer/entitlements/:entitlementId/status`
- `POST /api/developer/entitlements/:entitlementId/extend`
- `POST /api/developer/entitlements/:entitlementId/points`
- `GET /api/developer/sessions`
- `POST /api/developer/sessions/:sessionId/revoke`
- `GET /api/developer/device-bindings`
- `POST /api/developer/device-bindings/:bindingId/release`
- `GET /api/developer/device-blocks`
- `POST /api/developer/device-blocks`
- `POST /api/developer/device-blocks/:blockId/unblock`
- `GET /api/developer/network-rules`
- `POST /api/developer/network-rules`
- `POST /api/developer/network-rules/:ruleId/status`
- `GET /api/developer/audit-logs`
- `GET /api/developer/ops/export`
- `GET /api/developer/ops/export/download`
- `GET /api/developer/client-versions`
- `POST /api/developer/client-versions`
- `POST /api/developer/client-versions/:versionId/status`
- `GET /api/developer/notices`
- `POST /api/developer/notices`
- `POST /api/developer/notices/:noticeId/status`
- `GET /api/developer/release-package`
- `GET /api/developer/release-package/download`

## 项目级功能和状态

- `products.code` 是对外稳定的项目编码，接口里也兼容 `projectCode` / `softwareCode`
- 项目维度目前支持 `active / disabled / archived` 三种状态
- 项目停用或归档时，会同步回收该项目下的活跃会话，避免旧授权继续在线
- 管理员和开发者工作台都支持批量状态切换、批量写入项目功能开关、批量轮换 SDK 凭据，以及批量导出当前 SDK 凭据清单，便于一次性停用、归档、恢复、统一项目能力入口，或在泄漏后集中更换密钥
- 软件作者可以按项目控制 `allowRegister / allowAccountLogin / allowCardLogin / allowCardRecharge / allowVersionCheck / allowNotices / allowClientUnbind`
- 软件作者也可以按项目控制一组“客户端加固”开关：`requireStartupBootstrap / requireLocalTokenValidation / requireHeartbeatGate`
- 这组项目级开关影响的是客户端接入建议、启动引导和本地拦截强度；`HMAC` 请求签名、时间戳/nonce 防重放、服务端令牌校验这类核心协议安全仍然保持强制，不提供关闭入口
- 项目级功能开关关闭后，对应客户端接口会返回“disabled by product”，运行链路也不会继续套用该项目的相关规则
- 项目 SDK 凭据支持只轮换 `sdkAppSecret`，也支持连同 `sdkAppId` 一起轮换；旧凭据会立即失效，因此更适合在软件作者完成 SDK 配置更新后统一切换
- 项目中心里的 SDK 凭据批量导出会同时生成 JSON、CSV 和 `.env` 片段，方便软件作者在轮换后把新凭据快速同步给接入工程
- 项目中心现在也支持批量导出集成包，单次导出会包含每个项目的接入清单 JSON、`.env` 模板、C/C++ 快速接入片段、按项目策略生成的 C++ host skeleton、VS2022 `.sln/.vcxproj/.vcxproj.filters/.props/.local.props/.md`，以及自动生成的 client hardening guide，适合给多个软件项目同时下发最新 SDK 配置
- 集成包批量导出现在也支持服务端附件下载，可以直接拿到整包 JSON、manifest 合集、`.env` 合集或 C/C++ 片段合集，而不需要前端自己拼文本
- 发布交付包和批量集成包下载现在都支持 `zip` 归档，便于直接发给软件作者、测试同事或集成同事做离线交接
- SDK 凭据包、集成包和发布交付包现在都会附带 `SHA-256` 校验清单，支持单独下载校验文本，也会自动打进 `zip` 包里
- 管理员产品中心、开发者总览、开发者项目中心和开发者接入中心都会直接汇总 `active / disabled / archived` 项目数量

产品级功能开关当前支持：

- `allowRegister`
- `allowAccountLogin`
- `allowCardLogin`
- `allowCardRecharge`
- `allowVersionCheck`
- `allowNotices`
- `allowClientUnbind`
- `requireStartupBootstrap`
- `requireLocalTokenValidation`
- `requireHeartbeatGate`

### 开发者多项目模型

- 这组接口用于“一个开发者管理多个项目”的场景
- 现在除了开发者主账号，也支持开发者创建子账号，并按项目分配访问范围
- 子账号统一走 `/api/developer/login`，但只能看到被分配到自己名下的项目

当前开发者子账号角色：

- `admin`：可管理已分配项目的功能开关、策略、卡密、版本、公告，以及终端用户授权运营动作
- `operator`：可管理已分配项目的策略、卡密、版本、公告和终端用户授权运营动作，但不能改产品功能开关
- `viewer`：只读查看已分配项目及其策略、卡密、版本、公告，以及授权运营数据

开发者主账号可以自助改密、改资料、创建/禁用子账号、调整项目授权，并轮换自己项目的 `sdkAppSecret` 或整组 SDK 凭据；管理员仍然可以禁用或恢复开发者主账号，也可以在产品中心直接轮换项目凭据。

### 页面入口

- `/admin`：管理员控制台，可处理账号、授权、会话、绑定、设备封禁和审计日志，支持审计快捷筛选、日志行回填、可点击的快照概览卡、直接可点的授权审查列表，以及从快照重点对象自动联动相关列表并高亮匹配记录、自动聚焦对应控制卡片，并在动作成功后围绕同一对象自动刷新上下文，还会在快照区显示最近一次动作是否仍处于重点关注中、风险级别是改善还是升高、是否移出了推荐处置队列、是否已经脱离 `Escalate First` 级别，以及更直接的 `Mitigated / Escalation Lowered / Still Escalate` 这类缓解结论；这些结果还会进一步驱动更贴合语境的 follow-up 按钮文案，帮助管理员更自然地继续 `Close Out / Monitor / Follow Up / Escalate`，同时保留 `issues / sessions / entitlements / points` 这类影响范围提示；快照顶部会额外突出 `Escalate First` 高优先级对象，并把产品、用户、原因、建议动作以及影响范围指标压缩成更短摘要，还支持直接 `Open Control` 或 `Load Full Context`，这些重点摘要也会同步进导出的 `summary` 文本
- `/admin/products`：管理员产品中心，可创建开发者、分配项目归属、编辑项目资料、切换单个或批量项目状态、按关键字和状态筛选项目，并支持单个或批量调整项目级功能开关、批量轮换 SDK 凭据、批量导出凭据清单和批量集成包
- `/developer`：开发者总览中心，展示项目数、在线会话、卡密、强更规则、阻断公告、网络规则和功能开关覆盖情况
- `/developer/integration`：开发者接入中心，查看项目 SDK 凭据、公钥集、HTTP/TCP 接入信息、启动引导 `startup-bootstrap` 预览、示例请求，并导出当前项目的接入包、环境模板、C++ 快速接入片段、项目级 host skeleton，以及 VS2022 `.sln/.vcxproj/.vcxproj.filters/.props/.local.props/.md`
- `/developer/projects`：开发者项目中心，处理项目创建、资料编辑、单个或批量状态切换、关键字与状态筛选、单个或批量功能开关配置，以及单个或批量 SDK 凭据轮换、凭据导出和批量集成包导出
- `/developer/licenses`：开发者授权中心，维护策略、卡密批次、卡密状态和卡密导出
- `/developer/ops`：开发者授权运营台，处理账号冻结、授权续期、点数调账、强制下线、设备解绑、设备封禁，并支持审计快捷筛选、日志行回填、可点击的快照概览卡、重点账号/会话/设备明细、`Escalate First` 高优先级对象摘要、`Prepared Control` 回显卡，以及动作完成后的 `Last Action Result / Mitigation / Follow-up` 回显；这些回显现在不仅能跟随快照焦点，也能尽量跟随表格选中对象或快速控制表单中的当前目标，并会结合结果状态、影响范围、`Escalate First` 变化、当前对象摘要和命中的快照信号给出更贴合的下一步入口，同时保留直接 `Open Control / Load Full Context` 的 scoped 处置入口与 ops 快照包导出
- `/developer/releases`：开发者发版中心，维护客户端版本、强更规则和启动公告，并可导出项目级发布交付包，把当前集成配置、版本规则、启动预览、发版 readiness 结论、交付摘要和交付检查清单一次性打包给软件作者或发布同事
- `/developer/security`：开发者安全中心，维护项目级 IP / CIDR 网络规则

## Windows C/C++ SDK

当前 Windows SDK 已支持：

- 请求签名
- WinHTTP / Winsock 传输
- 账号登录与卡密直登
- 绑定查询与自助解绑
- 版本检查与公告拉取
- 启动聚合助手 `startup_bootstrap_http(...)`
- 本地启动决策 `evaluate_startup_decision(...)`
- 基于已拉取公钥集的本地离线验签
- 启动快照缓存，支持短时离线启动判断
- 结构化 `ApiException`，便于按错误码控制客户端流程
- `licenseToken` 解码与 RSA 公钥验签
- SDK 版本号、版本头文件和发布 changelog

发布建议：

- 对软件作者的主分发，优先提供 `static .lib + 头文件`
- 如果需要二进制替换能力，再额外提供 `DLL + import lib + 头文件`
- 当前仓库里，完整 C++ SDK 更适合发 `rocksolid_sdk_static.lib`
- `DLL` 形态当前更适合作为底层 C API 发布
- 如果发完整 C++ 静态库，接入方工程里记得定义 `RS_SDK_STATIC`

仓库已经内置一键打包脚本：

```bat
call sdk\package_release.bat
```

也可以显式指定输出目录，例如：

```bat
call sdk\package_release.bat build\my-sdk-dist
```

会输出：

- `build/win-sdk-package/rocksolid-sdk-cpp-<version>/`
- `build/win-sdk-package/rocksolid-sdk-cpp-<version>.zip`
- `build/win-sdk-package/rocksolid-sdk-capi-<version>/`
- `build/win-sdk-package/rocksolid-sdk-capi-<version>.zip`

SDK 版本源文件在 `sdk/VERSION`，构建脚本会自动生成 `sdk/include/rocksolid_sdk_version.h`，并把 `VERSION.txt`、`manifest.json`、`docs/CHANGELOG.md` 一起打进发布包。

发布目录还会额外生成：

- `SHA256SUMS.txt`
- `checksums.json`
- `release-manifest.json`

每个 SDK 包目录里还会带一个 `cmake/` 目录，软件作者可以直接用 `find_package(RockSolidSDK CONFIG REQUIRED)` 接入预编译包。

如果你要走完整的“打包 + 校验”流程，可以直接运行：

```bat
call sdk\release_sdk.bat
```

如果你只是想对已经打好的发布包做 smoke test：

```bat
call sdk\verify_release_package.bat build\win-sdk-package
```

当前这轮 SDK 版本是 `0.2.2`。

主要文件：

- `sdk/include/rocksolid_sdk.h`
- `sdk/include/rocksolid_sdk_version.h`
- `sdk/include/rocksolid_client.hpp`
- `sdk/include/rocksolid_transport_win.hpp`
- `sdk/src/rocksolid_crypto_win.cpp`
- `sdk/src/rocksolid_transport_win.cpp`
- `sdk/examples/windows_client_demo.cpp`
- `sdk/WINDOWS_SDK_GUIDE.md`
- `sdk/BUILD_WINDOWS.md`

编译示例：

```bat
cl /EHsc /std:c++17 ^
  /DRS_SDK_STATIC ^
  sdk\src\rocksolid_crypto_win.cpp ^
  sdk\src\rocksolid_transport_win.cpp ^
  sdk\examples\windows_client_demo.cpp ^
  /I sdk\include ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib
```

更完整的 Windows 构建步骤请看 `sdk/BUILD_WINDOWS.md`。

## 数据模型摘要

- `products`：软件产品
- `policies`：授权策略
- `policy_grant_configs`：时长卡 / 点数卡配置
- `license_keys`：卡密库存
- `license_key_controls`：卡密冻结 / 过期控制
- `customer_accounts`：终端用户账号
- `entitlements`：授权主体
- `entitlement_metering`：点数授权计量
- `devices`：设备指纹
- `device_bindings`：授权与设备绑定
- `sessions`：在线会话
- `device_blocks`：设备封禁
- `network_rules`：IP / CIDR 规则
- `client_versions`：版本规则
- `notices`：公告和维护通知
- `request_nonces`：请求防重放
- `audit_logs`：审计日志

## 部署建议

- Windows Server 可直接运行当前 Node.js 服务和 Windows SDK 配套体系
- Linux 更适合作为长期生产主环境，仓库也已提供 Docker / Nginx / systemd 部署骨架
- 当前已经把 nonce 防重放和在线会话抽成 runtime state store，并已支持 `redis` 运行时状态层、在线会话索引、单开 owner 索引和心跳期 runtime invalidation
- 真正上线前建议继续补齐 PostgreSQL、Redis、TLS、RBAC、限流、监控和备份策略
- 仓库现在也提供了更明确的上线检查清单，以及 Linux / Windows 的 TLS 反向代理示例
- 存储层当前更推荐按 `SQLite + Redis -> PostgreSQL Preview + Redis` 的顺序渐进升级
- `PostgreSQL Preview + Redis` 路径现在也补了 Linux / Windows 的主机侧 `pg_dump / restore` 脚本骨架

## 重点文档

- [architecture.md](docs/architecture.md)
- [tcp-protocol.md](docs/tcp-protocol.md)
- [client-auth-modes.md](docs/client-auth-modes.md)
- [client-unbind.md](docs/client-unbind.md)
- [client-versioning.md](docs/client-versioning.md)
- [notice-center.md](docs/notice-center.md)
- [license-ops.md](docs/license-ops.md)
- [admin-operations.md](docs/admin-operations.md)
- [developer-members.md](docs/developer-members.md)
- [developer-projects.md](docs/developer-projects.md)
- [developer-integration.md](docs/developer-integration.md)
- [developer-ops.md](docs/developer-ops.md)
- [developer-release.md](docs/developer-release.md)
- [storage-platform-guide.md](docs/storage-platform-guide.md)
- [storage-deployment-guide.md](docs/storage-deployment-guide.md)
- [postgres-main-store-preview.md](docs/postgres-main-store-preview.md)
- [postgres-backup-restore.md](docs/postgres-backup-restore.md)
- [incident-response-playbook.md](docs/incident-response-playbook.md)
- [daily-operations-checklist.md](docs/daily-operations-checklist.md)
- [observability-guide.md](docs/observability-guide.md)
- [alert-priority-guide.md](docs/alert-priority-guide.md)
- [shift-handover-template.md](docs/shift-handover-template.md)
- [launch-timeline-playbook.md](docs/launch-timeline-playbook.md)
- [server-os-choice.md](docs/server-os-choice.md)
- [production-launch-checklist.md](docs/production-launch-checklist.md)
- [production-operations-runbook.md](docs/production-operations-runbook.md)
- [vs2022-checklist.md](docs/vs2022-checklist.md)
- [linux-deployment.md](docs/linux-deployment.md)
- [windows-deployment-guide.md](docs/windows-deployment-guide.md)
- [rocksolid.redis-runtime.env.example](deploy/rocksolid.redis-runtime.env.example)
- [rocksolid.pg-redis.preview.env.example](deploy/rocksolid.pg-redis.preview.env.example)
- [docker-compose.redis-runtime.yml](deploy/docker-compose.redis-runtime.yml)
- [docker-compose.pg-redis.preview.yml](deploy/docker-compose.pg-redis.preview.yml)
- [backup-postgres.sh](deploy/postgres/backup-postgres.sh)
- [restore-postgres.sh](deploy/postgres/restore-postgres.sh)
- [backup-postgres.ps1](deploy/postgres/backup-postgres.ps1)
- [restore-postgres.ps1](deploy/postgres/restore-postgres.ps1)
- [rocksolid-postgres-backup.service](deploy/systemd/rocksolid-postgres-backup.service)
- [rocksolid-postgres-backup.timer](deploy/systemd/rocksolid-postgres-backup.timer)
- [register-rocksolid-postgres-backup-task.ps1](deploy/windows/register-rocksolid-postgres-backup-task.ps1)
- [unregister-rocksolid-postgres-backup-task.ps1](deploy/windows/unregister-rocksolid-postgres-backup-task.ps1)
- [Caddyfile.example](deploy/linux/Caddyfile.example)
- [rocksolid.tls.conf.example](deploy/nginx/rocksolid.tls.conf.example)
- [run-rocksolid.sh](deploy/linux/run-rocksolid.sh)
- [healthcheck-rocksolid.sh](deploy/linux/healthcheck-rocksolid.sh)
- [backup-rocksolid.sh](deploy/linux/backup-rocksolid.sh)
- [rocksolid.service](deploy/systemd/rocksolid.service)
- [rocksolid-backup.timer](deploy/systemd/rocksolid-backup.timer)
- [run-rocksolid.ps1](deploy/windows/run-rocksolid.ps1)
- [register-rocksolid-task.ps1](deploy/windows/register-rocksolid-task.ps1)
- [backup-rocksolid.ps1](deploy/windows/backup-rocksolid.ps1)
- [register-rocksolid-backup-task.ps1](deploy/windows/register-rocksolid-backup-task.ps1)
- [healthcheck-rocksolid.ps1](deploy/windows/healthcheck-rocksolid.ps1)
- [Caddyfile.example](deploy/windows/Caddyfile.example)

## 当前状态

仓库已经具备“商业级网络验证系统”的第一阶段骨架，适合继续往这些方向推进：

- PostgreSQL + Redis 多实例部署底座
- 更完整的客户端缓存、公钥轮换与离线校验策略
- 更成熟的后台前端
- 更细粒度的 RBAC、限流和告警
