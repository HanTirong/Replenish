# Replenish · Round 6 设计规范（V1.2 定稿视觉）

画布 390×844（iPhone 竖屏），导出 2x PNG。日期为示例数据；当前演示商品统一为 8kg、$72.99，默认单笔上限 $50、月预算 $120。变量见 `tokens.css` / `tailwind.config.js`，实际样式在 `packages/web/src/styles/`。审批参考图使用当前录屏中的 $72.99 场景。

## 1. 颜色
| Token | Hex | 用途 |
|---|---|---|
| bg | #F6F3EE | 页面底色（暖米白） |
| surface | #EEE9E1 | 软米色卡片（狗狗卡、额度卡、商品卡、气泡） |
| surface-2 | #E8E2D8 | 日期格默认底 |
| raised | #FFFFFF | 底部层、输入框、PayPal 卡、Today 格 |
| line | #E3DDD3 | 细分隔线、描边 |
| ink / ink-2 / ink-3 | #1C1B19 / #5E5A54 / #938E86 | 标题正文 / 理由与次要 / 说明与禁用 |
| teal | #1F6B63（按下 #18564F） | 仅主按钮、Order 标记、勾选 |
| teal-soft | #DDEAE5 | Active / Connected 胶囊、Order 格、安心提示底 |
| green | #2F8A68 | Active / Connected 圆点 |
| warn / warn-soft / warn-surface | #C4562E / #F7E6DC / #F8EDE5 | Action needed、超额差值、Runs out / 胶囊底、Runs out 格 / 超额块底 |
| blue / blue-soft | #3C6A8F / #E3EAEF | Delivery 点 / 格 |
| paypal-navy / paypal-blue | #003087 / #0070E0 | 纯文字 PayPal 字标（Pay / Pal），不使用官方 logo 文件 |
| sandbox | #C9A227 | Sandbox 徽标圆点 |

## 2. 字体
- 标题衬线：**Newsreader**（Google Fonts，可变字体，opsz 72）；正文无衬线：**Inter**。字体文件随附于 `packages/web/public/fonts/`，本地 @font-face 加载，无回退字体。

| 层级 | 字体 | 字号/行高 | 字重 | 字距 |
|---|---|---|---|---|
| Headline | Newsreader | 31 / 36 | 420 | -0.025em，最多两行，手动断行 |
| Dog name | Newsreader | 26 / 26 | 450 | -0.015em |
| Number（额度值） | Newsreader | 22 / 22 | 500 | 等宽数字 |
| Number（超额差值） | Inter | 24 / 24 | 600 | -0.025em，warn 色 |
| Reason | Inter | 15 / 22 | 400 | ink-2，首页限一行 |
| Body（行标题、按钮） | Inter | 15 / 20（按钮 16） | 500 | |
| Body-sm | Inter | 14 / 20 | 400 | |
| Caption | Inter | 12.5 / 16（结果行 12） | 400 | ink-3 |
| Pill / Badge | Inter | 12 / 11.5 | 500 | |
| Tile 日期 / 星期 / 标记 | Inter | 17 / 10 / 8.5 | 500 | |

## 3. 圆角 · 间距 · 阴影
- 圆角：sm 8（商品占位）、md 12（日期格）、lg 16（结果行容器）、xl 24（所有卡片）、sheet 28（底部层顶角）、pill 999（胶囊、按钮、输入框）。
- 间距（4/8 基准）：4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48。页面左右边距 24；标题距顶栏 32；标题→理由 8；理由→卡片 32；卡片之间 12；卡片内边距 16–20。
- 阴影（只用三处）：输入框 `0 1px 2px rgba(28,27,25,.04), 0 6px 20px rgba(28,27,25,.07)`；底部层 `0 -8px 32px rgba(28,27,25,.10)`；头像 4px 白环 + `0 4px 16px rgba(28,27,25,.10)`。其他卡片无阴影，靠底色区分。

## 4. 组件
- **顶栏**：高 40，logo 34px 宽 + “Replenish”（Newsreader 19/500）；状态胶囊右对齐。
- **状态胶囊**：高 28，左右 12，7px 圆点 + 文字。Active＝teal-soft 底 + green 点；Action needed＝warn-soft 底 + warn 点/字。PayPal 卡内 Not connected＝surface 底 + ink-3 点。
- **Sandbox 徽标**：高 24，1px line 描边，半透明白底，6px 金色点，文字 ink-2。
- **狗狗卡**：surface，圆角 24，高 280；圆形头像 168（白环 4px），下方名字 16px 间距。头像必须圆形，完整露出脸部。审批页用 28px 小头像。
- **日期格**：39×80，间距 5，圆角 12；从左边距 24 起向右出血，第 9 格被屏幕边缘截断以暗示横滑。结构：星期 → 日期 → 5px 圆点 → 标记文字。
  - 默认 surface-2 + 灰点；Today 白底、星期黑字；Order teal-soft + teal 点；Delivery blue-soft + blue 点；Runs out warn-soft + warn 点；Skip（临时跳餐）默认底 + 空心圆点 + “Skip” ink-3。计划节点不显示为已完成。
- **聊天输入**：距左右 16、底 34，高 56 胶囊，白底 + 输入阴影；占位 ink-3 15px；右侧 40px 黑色圆形发送键（白箭头）。底部层内输入框改为 bg 底、无阴影。
- **底部层**：白底，顶角 28，抓手 36×4；背后首页加 18% 暖黑遮罩。左右内边距 16。
- **气泡**：用户气泡右对齐，surface 底，圆角 20/20/6/20，padding 11×16。Agent 无底色：32px 圆形 logo 头像 + 文本，首句 600 ink，其余 ink-2。
- **结果行**：1px line 描边容器，圆角 16；每行高 52，20px 线性图标 + 标题 14/500 + 说明 12 ink-3；行间细线。下方 Okay（主，40 高）+ Undo（次）。
- **超额行（审批页最突出元素）**：warn-surface 块，圆角 24；每行高 72；左：限额名 15/500 + 限额值 caption；右：差值 24/600 warn 色。商品行在其上方的 surface 卡中，商品图用中性袋形线框占位（44×52，bg 底），不放假商品图。
- **按钮**：高 52 胶囊，16/500。Primary＝teal 底白字；Secondary＝白底 + 1px line + ink 字。双按钮等宽并排（间距 8），单按钮全宽；固定在底部（距底 30–42）。文字链接（Pause autopilot）14/500 ink-2 下划线。
- **PayPal 卡**：白底 + 1px line，圆角 24，padding 20；左上文字字标 “PayPal”（Inter 800 斜体 24，Pay 深蓝 / Pal 亮蓝），右上状态胶囊；下方一句状态说明 14/20 ink-2。
- **额度行**：surface 卡，圆角 24；每行高 68：22px 图标 + 标题/说明 + Newsreader 数值 22 + chevron。未连接时整行 40% 透明、无 chevron，卡下一句提示“连接后可修改”。
- **安心提示**：teal-soft 块，圆角 24，22px teal 勾选圆 + 14/20 文本。

## 5. 文案原则
每屏只保留：动态标题（≤2 行）+ 一句理由 + 一个核心模块 + 主操作。首页不出现库存克数与喂食摘要。

## 文案补充：首页理由行（按导师意见）
- 计划已排：`I'll reorder on {orderDate} so it arrives before food runs out.`
- 计划不变：`That's half a day of food, so the reorder date stays {orderDate}.`
- `{orderDate}` 由后端计算（如 Nov 2），计划变了就换成新日期；示意图里的日期为示例数据。
