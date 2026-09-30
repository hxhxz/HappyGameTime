# 双入口决策学习平台（decision-platform-v2）

## 入口

- **规则游戏**：1 位人类与 3 位本地规则策略，完全不依赖模型服务。
- **模型实验**：每个 AI 席位可选择规则策略、每步 LLM 重排或 regret 门控重排；批量实验统一通过策略注册表运行。

两种入口共用 `src/engine` 的合法动作与纯状态转移。LLM 只能在服务端已生成的候选中重排，失败时严格执行调用前的基础动作。

环境随机数使用可序列化的 counter-based `counter32-v1` 状态。交互局 ID 使用随机 UUID，批量局 ID 由实验 ID、seed 与座位确定性生成；所有 episode、regret、对手学生和评测产物均携带 `envVersion`、schema、代码版本与配置哈希。

## 服务端模型配置

模型档案通过 `MODEL_PROFILES_JSON` 配置。密钥只通过档案引用的环境变量读取，绝不发送给浏览器或写入实验记录。

```env
MODEL_PROFILES_JSON=[{"id":"primary","label":"主实验模型","baseUrl":"https://api.example.com/v1","model":"model-name","apiKeyEnv":"PRIMARY_MODEL_API_KEY"}]
PRIMARY_MODEL_API_KEY=replace-me
```

接口必须兼容 OpenAI Chat Completions。模型地址继续受现有公网 HTTPS、DNS 固定和响应体大小限制保护。

## Regret gate

未配置门控模型时，`regret_gated` 席位不会调用 LLM，这使规则入口和未校准实验保持保守。线性门控模型通过 `REGRET_GATE_MODEL_JSON` 注入：

```env
REGRET_GATE_MODEL_JSON={"version":"regret-gate-v1","intercept":-4.2,"threshold":0.2,"weights":{"turn":0.01,"legalActionCount":0.03,"leaderGap":0.25,"tokenCount":0.02,"reserveCount":0.1,"affordableCount":0.15}}
```

这些权重必须来自 `server/regret.ts` 生成的 honest 反事实标签，不应按启发式 top-gap 人工拍定。门控只使用廉价玩家视图和启发式摘要，不运行 POMCP。

流水线命令：

```sh
npm run regret:label -- --input data/episodes --output data/regret.jsonl --pairs 16
npm run regret:split -- --input data/regret.jsonl --output data/regret-split.jsonl
npm run regret:train -- --input data/regret-split.jsonl --output data/regret-model.json
npm run regret:calibrate -- --input data/regret-split.jsonl --model data/regret-model.json --output data/regret-calibration.json
npm run regret:evaluate -- --input data/regret-split.jsonl --model data/regret-model.json --output data/regret-test.json
```

标签中的 baseline action 始终由版本化的中性 honest heuristic 重新计算，不使用历史上最终执行的 LLM 动作。

## 数据与边界

- `PublicView`、`PlayerView` 和 `OracleView` 位于 `src/decision/types.ts`。
- 正式策略和证据接口位于 `src/decision/contracts.ts`，只接受 `PlayerView`。
- `oracle_full` 数据默认不能训练 honest 策略、regret gate 或正式对手学生模型。
- `DecisionRecord` 保存实际输入 view、候选证据、门控判断、模型消息、原始响应、用量和 fallback。
- `EpisodeRecord` 保存初始状态与逐步动作，可由 `replayEpisode()` 校验视图哈希、合法动作和观测。

导出的研究记录含隐藏的初始牌序，用于受控重放，应按研究数据保护；不会包含 API Key 或访问口令。

## 搜索与评测

- `server/pomcp.ts` 提供 public-history 树、每次模拟重采样牌堆顺序的 honest POMCP。深度使用 `ownTurns × 玩家数` 换算为 ply。
- POMCP rollout 只接受本地 `OpponentStudent`。远程 LLM 不进入模拟热路径。
- `server/regret.ts` 以公共随机数对所有候选进行配对 rollout，输出期望 regret 和置信区间。
- `server/paired-eval.ts` 对每个 seed 完成四个座位轮换，再以该轮换均值作为一个配对单位；正式锚点固定为 `heuristic-honest`。
- POMCP 注册为 `pomcp-honest-uniform` 候选臂和 best-response 参考，不是正式锚点。
- `npm run eval:paired -- --candidate pomcp-honest-uniform --anchor heuristic-honest --opponent heuristic-honest --pairs 20` 可运行小规模配对评测；正式样本量应先用 pilot 标准差调用 `requiredPairCount()` 估计。

## 对手教师—学生

LLM 只离线标注公开视图与公开行为；POMCP rollout 只调用本地学生。学生以阶段、回合区间和公开领先差分桶，不读取采样世界中的私手。

```sh
npm run opponent:label -- --input data/episodes --output data/opponent-labels.jsonl --profile primary
npm run opponent:train -- --input data/opponent-labels.jsonl --output data/opponent-student.json
npm run opponent:evaluate -- --input data/opponent-labels.jsonl --model data/opponent-student.json --output data/opponent-test.json
```

## 配置驱动实验

`POST /pokemon/api/experiments` 接收版本化实验配置；`GET /pokemon/api/experiments?id=...` 查询后台任务。当前 UI 开放配对实验入口。信息条件 2×2 强制四格完整且 `ungated`，门控效率实验强制基础、全调用、regret gate、同分层随机四臂。后续正式执行这些复合设计时，仍须为各臂注册具有对应信息/输入能力的策略，不得只靠 arm 元数据冒充实验处理。

新对局通过 simulator-only `reservationOrigins` 记录预订来源；regret belief sampler 会在每个牌层内联合重采样未知牌堆与对手盲抽私手。该字段不会投影到客户端或策略视图。旧存档缺少来源时采用保守边缘化，不根据具体牌从牌堆消失这一事实推断对手私手。
