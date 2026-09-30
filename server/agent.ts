import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Card, GameState } from '../src/engine/types';
import type { Action } from '../src/engine/types';
import type { PlayerView } from '../src/decision/types';
import type { RankedCandidate, PersonaMode } from './strategy';

export const PROMPT_CACHE_VERSION = 'pokemon-trainer-cache-v2';
export const STATIC_SYSTEM_PROMPT = `${PROMPT_CACHE_VERSION}
你是《璀璨宝石·宝可梦陪练》的决策 Agent。四人各自争胜，任一玩家达到18分后触发最终轮。永久资产 bonuses 抵扣对应颜色的捕捉成本，tokens.master 是可以补颜色缺口的大师球。主动作后，当已有前置宝可梦、永久资产满足进化需求且下一阶在市场或本人预订区时，可免费进化一次；免费进化通常优于直接结束回合。
身份规则：youAre 是你的唯一身份来源。youAre.seat 是你的座位，youAre.name 是你的名字，youAre.points 是你的当前分数。绝不要把 players[0] 或其他座位当成自己。state.activePlayer 必须等于 youAre.seat。对手预订牌和未公开牌库是隐藏信息，不得猜测。
状态字段：state.phase 是 main/discard/evolve；players[].points 是分数；tokens 是手牌；bonuses 是永久资产；purchased 是已有宝可梦；reserved 是预订区；market 是公开市场。卡牌字段 n=名称、lv=阶段、pt=分数、cost=捕捉成本、bonus=获得的永久资产、to=进化目标、evo=进化所需永久资产。
候选字段：candidateActions 由规则引擎遍历全部合法动作、模拟后继状态并按显式 personaMode 评分后筛选；默认 neutral 不带人格偏置。actionId 是唯一可返回的动作索引；heuristicRank 越小越推荐；outcome.pointsAfter 是执行后分数，pointsGained 是本次得分，tokenCountAfter 是执行后手牌数，bonusGained 是新增永久资产，evolutionGained 是新增进化次数，mustDiscard 表示随后必须弃球。只能选候选中的动作，不得编造。
人格模式：neutral 仅使用中性证据；scoring 偏重即时得分；evolution 偏重资产和进化链；control 偏重公开可见的阻断机会。身份名称本身不决定人格，只有 youAre.personaMode 生效。
通用决策标准：优先真实得分、免费进化和可持续的永久资产；避免无目标囤球、取球后立即大量弃球、长期买不起的预订，以及只为干扰而牺牲获胜的行为。
输出协议：只输出一个 JSON 对象，格式为 {"selfPoints":整数,"actionId":整数,"explanation":"与当前数据一致的中文说明，最多60字"}。selfPoints 必须等于 youAre.points，不得输出额外文本或思考过程。`;
export interface Settings { baseUrl: string; model: string; apiKey: string }
// Application-level ceiling for OpenAI-compatible models. Keep the response and
// a small estimation margin inside the advertised context window.
export const MAX_CONTEXT_TOKENS = 128_000;
// Reasoning-capable providers may spend part of this allowance before emitting
// the short JSON decision. 180 was enough for plain chat models but could end
// with finish_reason=length and an empty message.content.
export const MAX_OUTPUT_TOKENS = 4_096;
export const CONTEXT_SAFETY_TOKENS = 1_024;
export const MAX_RECENT_LOG_ENTRIES = 8;
export function endpoint(base: string): URL {
  let u: URL;
  try { u = new URL(base.trim()); } catch { throw new Error('请输入有效的 HTTPS API 地址'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || isIP(u.hostname) || (u.port && u.port !== '443')) throw new Error('API 地址须为公网 HTTPS 域名，不含账号、参数或非标准端口');
  const path = u.pathname.replace(/\/+$/, '');
  u.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return u;
}
export function publicAddress(address: string): boolean {
  // IPv4 only: reject loopback, private, link-local, CGNAT, reserved and multicast ranges.
  if (isIP(address) !== 4) return false;
  const [a,b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
}
export function estimateContextTokens(messages: { role: string; content: string }[]): number {
  // Conservative for mixed Chinese/JSON: Chinese is often close to one token per
  // character, while ASCII JSON is cheaper. UTF-8 bytes / 3 errs on the safe side.
  return Math.ceil(Buffer.byteLength(messages.map(m => `${m.role}:${m.content}`).join('\n')) / 3);
}
export function requestPayload(settings: Settings, messages: { role: string; content: string }[]) {
  const payload: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream: false,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: 'json_object' },
  };
  if (endpoint(settings.baseUrl).hostname === 'api.deepseek.com') {
    payload.thinking = { type: 'disabled' };
  }
  return payload;
}
function responseText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (!part || typeof part !== 'object') return '';
    const value = part as { text?: unknown; content?: unknown };
    return typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content : '';
  }).join('');
}
export async function completion(settings: Settings, messages: { role: string; content: string }[], signal?: AbortSignal): Promise<{ content: string; tokens: number; promptTokens: number; cacheHitTokens: number; cacheMissTokens: number; rawResponse: unknown }> {
  if (!settings.apiKey || !settings.model) throw new Error('请先配置模型和 API Key');
  const contextTokens = estimateContextTokens(messages);
  if (contextTokens > MAX_CONTEXT_TOKENS) throw new Error(`模型上下文过长（约 ${contextTokens} tokens，上限 ${MAX_CONTEXT_TOKENS}）`);
  const url = endpoint(settings.baseUrl);
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('模型地址必须解析到公网地址');
  // Pin the resolved address for this request: no DNS rebinding and no redirects.
  const pinned = addresses[0].address;
  const body = JSON.stringify(requestPayload(settings, messages));
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', family: 4, signal, lookup: (_hostname, _opts, cb) => cb(null, pinned, 4), headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let content = ''; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(new Error('模型响应过大')); else content += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`模型接口返回 HTTP ${res.statusCode}，请检查地址、模型、额度和 Key`)); return; }
        let json: any;
        try { json = JSON.parse(content); }
        catch { reject(new Error('模型返回的不是有效 JSON 响应')); return; }
        const choice = json.choices?.[0];
        const answer = responseText(choice?.message?.content);
        if (!answer.trim()) {
          const reason = choice?.finish_reason ?? 'unknown';
          const reasoning = Number(json.usage?.completion_tokens_details?.reasoning_tokens) || (choice?.message?.reasoning_content?.length ?? 0);
          const hint = reason === 'length' ? '；输出预算已用尽，请重试或换用非推理模型' : '';
          reject(new Error(`模型没有返回最终文本（finish_reason=${reason}，reasoning=${reasoning}）${hint}`));
          return;
        }
        const promptTokens = Number(json.usage?.prompt_tokens) || 0;
        const cacheHitTokens = Number(json.usage?.prompt_cache_hit_tokens ?? json.usage?.prompt_tokens_details?.cached_tokens) || 0;
        const cacheMissTokens = Number(json.usage?.prompt_cache_miss_tokens) || Math.max(0, promptTokens - cacheHitTokens);
        resolve({ content: answer, tokens: Number(json.usage?.total_tokens) || 0, promptTokens, cacheHitTokens, cacheMissTokens, rawResponse: json });
      });
    });
    const timeout = setTimeout(() => req.destroy(new Error('模型响应超过 60 秒，请重试或更换模型')), 60_000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', e => reject(e.name === 'AbortError' ? e : new Error('模型请求失败，请检查网络和接口配置')));
    req.end(body);
  });
}
const briefCard = (c: Card) => ({ id: c.id, n: c.nameZh, lv: c.kind === 'normal' ? c.stage : c.kind, pt: c.points, cost: c.cost, bonus: `${c.bonus}:${c.bonusAmount}`, to: c.evolvesToSpeciesId, evo: c.evolveCost });
const ownedCard = (c: Card) => ({ id: c.id, n: c.nameZh, pt: c.points, bonus: `${c.bonus}:${c.bonusAmount}`, to: c.evolvesToSpeciesId, evo: c.evolveCost });
export function observation(g: GameState, recentLogLimit = 8) {
  return {
    turn: g.turnNumber, activePlayer: g.currentPlayerIndex,
    phase: g.awaitingDiscard ? 'discard' : g.awaitingEvolve ? 'evolve' : 'main',
    finalRound: g.endTriggeredByPlayerIndex !== null, supply: g.tokenPool,
    players: g.players.map((p, i) => ({ seat: i, name: p.name, points: p.points, tokens: p.tokens, bonuses: p.bonuses, purchased: p.purchased.map(ownedCard), evolvedCount: p.evolved.length, reserved: i === g.currentPlayerIndex ? p.reserved.map(briefCard) : { count: p.reserved.length } })),
    market: Object.values(g.decks).map(d => ({ pile: d.key, remaining: d.drawPile.length, cards: d.faceUp.filter((c): c is Card => !!c).map(briefCard) })),
    recentLog: recentLogLimit > 0 ? g.log.slice(-recentLogLimit) : [],
  };
}
export function explanationContradictions(explanation: string, expectedSelfPoints: number): string[] {
  const issues: string[] = [];
  const patterns = [/我(?:已|有|当前|现在)?\s*(\d+)\s*分/g, /我仅\s*(\d+)\s*分/g];
  for (const pattern of patterns) {
    for (const match of explanation.matchAll(pattern)) {
      if (Number(match[1]) !== expectedSelfPoints) issues.push(`解释声称我方 ${match[1]} 分，实际为 ${expectedSelfPoints} 分`);
    }
  }
  return [...new Set(issues)];
}
export function parseDecision(content: string, count: number, expectedSelfPoints?: number): { actionId: number; explanation: string; selfPoints?: number } {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj;
  try { obj = JSON.parse(stripped); } catch { throw new Error('模型回答不是有效 JSON，请重试'); }
  if (!Number.isInteger(obj.actionId) || obj.actionId < 0 || obj.actionId >= count || typeof obj.explanation !== 'string' || !obj.explanation.trim()) throw new Error('模型选择了无效动作或缺少决策说明，请重试');
  if (expectedSelfPoints !== undefined && obj.selfPoints !== expectedSelfPoints) throw new Error(`模型身份自检失败：应识别自己为 ${expectedSelfPoints} 分`);
  if (expectedSelfPoints !== undefined) {
    const issues = explanationContradictions(obj.explanation, expectedSelfPoints);
    if (issues.length) throw new Error(`模型解释与局面矛盾：${issues.join('；')}`);
  }
  return { actionId: obj.actionId, explanation: obj.explanation.trim().slice(0, 500), selfPoints: obj.selfPoints };
}
export interface PromptSeat {
  seat: number;
  name: string;
  personaMode: PersonaMode;
}

function actionLabelFromView(action: Action, view: PlayerView): string {
  const cardName = (id: string) => {
    for (const deck of view.decks) for (const card of deck.faceUp) if (card?.id === id) return card.name;
    for (const card of view.privateReserved) if (card.id === id) return card.name;
    for (const player of view.players) for (const card of player.purchased) if (card.id === id) return card.name;
    return id;
  };
  switch (action.type) {
    case 'BUY': return `捕捉 ${cardName(action.source.cardId)}`;
    case 'RESERVE': return action.source.kind === 'deck' ? `盲抽预订 T${action.source.pile}` : `预订 ${cardName(action.source.cardId)}`;
    case 'TAKE_THREE': return `拿取 ${action.colors.join('、')}`;
    case 'TAKE_TWO': return `拿取 2 个 ${action.color}`;
    case 'EVOLVE': return `${cardName(action.fromCardId)} → ${cardName(action.toCardId)}`;
    case 'DISCARD': return `归还 ${Object.entries(action.tokens).filter(([, count]) => count).map(([token, count]) => `${token}:${count}`).join('、')}`;
    case 'END_TURN': return '结束回合';
  }
}

/** Pure prompt builder: every identity and persona input is explicit. */
export function messagesFor(view: PlayerView, candidates: RankedCandidate[], seat: PromptSeat) {
  const compactAction = (candidate: RankedCandidate, actionId: number) => {
    const action = candidate.action;
    const base = { actionId, label: actionLabelFromView(action, view), heuristicRank: actionId + 1, heuristicScore: candidate.score, outcome: candidate.outcome };
    switch (action.type) {
      case 'BUY': return { ...base, type: 'buy', from: action.source.kind, cardId: action.source.cardId };
      case 'RESERVE': return action.source.kind === 'board' ? { ...base, type: 'reserve', cardId: action.source.cardId } : { ...base, type: 'reserveDeck', pile: action.source.pile };
      case 'TAKE_THREE': return { ...base, type: 'takeDifferent', colors: action.colors };
      case 'TAKE_TWO': return { ...base, type: 'takeTwo', color: action.color };
      case 'DISCARD': return { ...base, type: 'discard', tokens: action.tokens };
      case 'EVOLVE': return { ...base, type: 'evolve', fromCardId: action.fromCardId, toCardId: action.toCardId };
      case 'END_TURN': return { ...base, type: 'end' };
    }
  };
  const me = view.players.find(player => player.id === view.viewerId);
  if (!me) throw new Error('prompt viewer missing from player view');
  const system = { role: 'system', content: STATIC_SYSTEM_PROMPT };
  const candidateActions = candidates.map(compactAction);
  const build = (logLimit: number) => [
    system,
    { role: 'user', content: JSON.stringify({ youAre: { seat: seat.seat, name: seat.name, personaMode: seat.personaMode, points: me.points }, state: { ...view, recentPublicHistory: view.recentPublicHistory.slice(-logLimit) }, candidateActions }) },
  ];
  const inputBudget = MAX_CONTEXT_TOKENS - MAX_OUTPUT_TOKENS - CONTEXT_SAFETY_TOKENS;
  let low = 0, high = Math.min(view.recentPublicHistory.length, MAX_RECENT_LOG_ENTRIES), best = build(0);
  // Recent actions are useful for immediate tactics; older raw logs add cost and
  // stale-state confusion. Keep a bounded suffix, still respecting token budget.
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(mid);
    if (estimateContextTokens(candidate) <= inputBudget) {
      best = candidate;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}
