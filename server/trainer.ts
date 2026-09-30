import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction, legalMoves, passTurn, type GameState, type Action } from '../src/engine';
import { makeRng } from '../src/engine/rng';
import { PAYABLE_ORDER } from '../src/engine/types';
import { CARDS } from '../src/data/cards';
import { serializeState, deserializeState } from '../src/net/serialize';
import { appendReplayStep, newEpisodeRecord, type EpisodeRecord } from '../src/decision/replay';
import { cheapGateFeatures } from '../src/decision/gate';
import { ENV_VERSION, type DecisionRecord } from '../src/decision/types';
import { publicView, viewHash } from '../src/decision/views';
import { artifactIdentity, interactiveEpisodeId } from '../src/decision/identity';
import { AGENTS } from './agents';
import { actionLabel, candidateDebugLine, candidateExplanation, type CandidateScoreTerms } from './strategy';
import { configuredRegretGate, defaultSessionConfig, llmProvider, publicModelProfiles, validateSessionConfig, type SessionConfig } from './platform';
import { buildCandidatePipeline } from './policy-runtime';
import { CandidateTopPolicy, LlmRerankPolicy, PolicyRegistry, RegretGatedPolicy, type PolicyContext } from './policy-registry';
import { pomcpHonest, uniformOpponentStudent } from './pomcp';
import { PomcpDecisionPolicy } from './pomcp-policy';
import { ExperimentRunner, type ExperimentSpec } from './experiment-runner';

const dataDir = resolve(process.env.DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const password = process.env.ACCESS_PASSWORD || '';
if (password.length < 12) throw new Error('ACCESS_PASSWORD must have at least 12 characters');
const base = '/pokemon';
const staticDir = resolve(process.env.STATIC_DIR || 'dist');
const stateFile = resolve(dataDir, 'game.json');
const cookieName = 'pokemon_session';
const cookieSecure = process.env.COOKIE_SECURE !== 'false';
const sessions = new Map<string, number>();
let loginFailures = 0, loginWindow = Date.now();
interface Decision {
  turn: number; name: string; style: string; action: string; explanation: string; tokens: number;
  promptTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number;
  chosenActionId?: number;
  legalActionLabels?: string[];
  heuristicScore?: number;
  heuristicTerms?: CandidateScoreTerms;
  policyVersion?: string;
  gateTriggered?: boolean;
  modelProfileId?: string;
  modelInput?: { role: string; content: string }[];
  rawCompletion?: string;
  fallbackUsed?: boolean;
}
let game: GameState;
let decisions: Decision[] = [];
let researchRecords: DecisionRecord[] = [];
let sessionConfig: SessionConfig = defaultSessionConfig();
let episode: EpisodeRecord;
let revision = 0;
let paused = true;
let thinking = false;
let agentError = '';
let generation = 0;
let usage = { calls: 0, tokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
const codeRevision = process.env.CODE_REVISION || 'development';
function buildExperimentRegistry(): PolicyRegistry {
  const registry = new PolicyRegistry();
  const baseline = new CandidateTopPolicy();
  registry.register(baseline);
  registry.register(new PomcpDecisionPolicy('pomcp-honest-uniform', 'v1-best-response-reference', 64, 2));
  for (const profile of publicModelProfiles().filter(item => item.configured)) {
    const enhanced = new LlmRerankPolicy(`llm-always:${profile.id}`, llmProvider(profile.id), profile.model);
    registry.register(enhanced);
    registry.register(new RegretGatedPolicy(`llm-regret-gated:${profile.id}`, baseline, enhanced, configuredRegretGate(), .5));
  }
  return registry;
}
const experimentRegistry = buildExperimentRegistry();
const experimentRunner = new ExperimentRunner(experimentRegistry);
function createEpisode(state: GameState, config: SessionConfig): EpisodeRecord {
  return newEpisodeRecord(interactiveEpisodeId(randomUUID()), state, artifactIdentity(config, codeRevision));
}
function fresh(config = sessionConfig) {
  return createGame({ players: config.seats.map((seat, i) => ({ id: `P${i}`, name: seat.name, isAI: seat.kind !== 'human' })), cards: CARDS, seed: randomBytes(4).readUInt32LE() });
}
if (existsSync(stateFile)) {
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  game = deserializeState(JSON.stringify(saved.game)); decisions = saved.decisions || []; revision = saved.revision || 0;
  usage = { ...usage, ...(saved.usage || {}) };
  researchRecords = saved.researchRecords || [];
  sessionConfig = saved.sessionConfig ? validateSessionConfig(saved.sessionConfig) : defaultSessionConfig();
  episode = saved.episode ? { ...saved.episode, initialState: deserializeState(JSON.stringify(saved.episode.initialState)) } : createEpisode(game, sessionConfig);
} else { game = fresh(); episode = createEpisode(game, sessionConfig); }
function atomic(path: string, text: string) { writeFileSync(`${path}.tmp`, text, { mode: 0o600 }); renameSync(`${path}.tmp`, path); }
function serializableEpisode() { return { ...episode, initialState: JSON.parse(serializeState(episode.initialState)) }; }
function persist() { atomic(stateFile, JSON.stringify({ game: JSON.parse(serializeState(game)), decisions, researchRecords, sessionConfig, episode: serializableEpisode(), revision, usage })); }
function configured() { return true; }
function publicSettings() { return { model: sessionConfig.mode === 'play' ? '本地规则引擎' : '实验模式', hasKey: publicModelProfiles().some(profile => profile.configured), profiles: publicModelProfiles() }; }
function decisionSummary(d: Decision) {
  const { turn, name, style, action, explanation, tokens } = d;
  return { turn, name, style, action, explanation, tokens };
}
function view() {
  const visible = JSON.parse(serializeState(game));
  visible.rngSeed = 0;
  delete visible.reservationOrigins;
  for (const d of Object.values(visible.decks) as { drawPile: unknown[] }[]) d.drawPile = Array(d.drawPile.length).fill({ id: 'hidden' });
  visible.players.forEach((p: { reserved: unknown[] }, i: number) => { if (i) p.reserved = p.reserved.map((_, j) => ({ id: `hidden-${i}-${j}` })); });
  return { game: visible, decisions: decisions.map(decisionSummary), revision, paused, thinking, agentError, configured: configured(), settings: publicSettings(), usage, sessionConfig, experimentPolicies: experimentRegistry.list() };
}
function cancel() { generation++; thinking = false; }
async function tick() {
  if (paused || thinking || game.isGameOver || game.currentPlayerIndex === 0) return;
  const ticket = generation;
  thinking = true; agentError = '';
  const snapshot = game, moves = legalMoves(snapshot);
  try {
    if (!moves.length) { game = passTurn(game); revision++; persist(); return; }
    const agent = AGENTS[snapshot.currentPlayerIndex - 1];
    const seat = sessionConfig.seats[snapshot.currentPlayerIndex];
    const style = seat && seat.kind !== 'human' ? seat.style : agent.style;
    const personaMode = seat && seat.kind !== 'human' ? seat.personaMode : 'neutral';
    const pipeline = buildCandidatePipeline(snapshot, moves, personaMode);
    const candidates = pipeline.ranked;
    if (process.env.DEBUG_HEURISTIC === '1') candidates.forEach((candidate, i) => console.debug(candidateDebugLine(candidate, i + 1, snapshot)));
    if (ticket !== generation) return;
    const baseline = candidates[0];
    let choice = baseline;
    let modelInput: { role: string; content: string }[] | undefined;
    let rawCompletion: string | undefined;
    let rawModelResponse: unknown;
    let parsedOutput: unknown;
    let latencyMs = 0;
    let fallbackUsed = false;
    let fallbackReason: string | undefined;
    const pv = pipeline.view;
    const evidence = pipeline.evidence;
    const policyContext: PolicyContext = {
      view: pv, legalActions: moves, candidates: evidence, rankedCandidates: candidates,
      seat: { seat: snapshot.currentPlayerIndex, name: seat?.name ?? agent.name, personaMode },
      rng: makeRng(snapshot.rngSeed, `policy/${episode.episodeId}/${episode.steps.length}`),
      search: request => pomcpHonest(snapshot, { ...request, seed: snapshot.rngSeed ^ episode.steps.length, opponent: uniformOpponentStudent }),
    };
    const baselineDecision = await experimentRegistry.resolve('heuristic-honest').decide(policyContext);
    const gate = configuredRegretGate();
    const prediction = gate.predict(cheapGateFeatures(pv, evidence));
    const gateAvailable = prediction.modelVersion !== 'disabled-v1';
    const gateTriggered = seat?.kind === 'llm' && (seat.invocationMode === 'always' || (gateAvailable && prediction.highRegretProbability >= sessionConfig.gateThreshold));
    let llmUsage = { total: 0, prompt: 0, cacheHit: 0, cacheMiss: 0 };
    if (gateTriggered && seat.kind === 'llm') {
      try {
        const policy = experimentRegistry.resolve(`llm-always:${seat.modelProfileId}`);
        const decision = await policy.decide(policyContext);
        choice = candidates[decision.chosenIndex];
        modelInput = decision.trace.exactMessages;
        rawCompletion = decision.trace.responseText;
        rawModelResponse = decision.trace.rawResponse;
        parsedOutput = decision.trace.parsedOutput;
        latencyMs = decision.cost.latencyMs;
        llmUsage = decision.cost.usage;
        usage.calls++; usage.tokens += llmUsage.total; usage.cacheHitTokens += llmUsage.cacheHit; usage.cacheMissTokens += llmUsage.cacheMiss;
      } catch (error) {
        fallbackUsed = true;
        fallbackReason = error instanceof Error ? error.message : 'LLM failure';
        choice = candidates[baselineDecision.chosenIndex];
      }
    }
    const action = choice.action;
    game = applyAction(snapshot, action);
    appendReplayStep(episode, snapshot, action, game);
    if (!['BUY','EVOLVE'].includes(action.type)) game.log.push(`${seat?.name ?? agent.name} ${actionLabel(action, snapshot)}`);
    decisions.push({
      turn: snapshot.turnNumber, name: seat?.name ?? agent.name, style,
      action: actionLabel(action, snapshot), explanation: (parsedOutput as { explanation?: string } | undefined)?.explanation ?? candidateExplanation(choice), tokens: llmUsage.total,
      promptTokens: llmUsage.prompt, cacheHitTokens: llmUsage.cacheHit, cacheMissTokens: llmUsage.cacheMiss,
      chosenActionId: candidates.indexOf(choice), heuristicScore: choice.score, heuristicTerms: choice.terms,
      legalActionLabels: candidates.map(c => actionLabel(c.action, snapshot)),
      policyVersion: seat?.kind === 'llm' ? `llm-reranker-${seat.invocationMode}-v1` : 'honest-heuristic-v1',
      gateTriggered, modelProfileId: seat?.kind === 'llm' ? seat.modelProfileId : undefined,
      modelInput, rawCompletion, fallbackUsed,
    });
    researchRecords.push({
      artifact: episode.artifact,
      decisionId: `${episode.episodeId}:${episode.steps.length - 1}`,
      episodeId: episode.episodeId, envVersion: ENV_VERSION,
      policyVersion: seat?.kind === 'llm' ? `llm-reranker-${seat.invocationMode}-v1` : 'honest-heuristic-v1',
      playerId: snapshot.players[snapshot.currentPlayerIndex].id,
      informationClass: 'honest_partial', viewCondition: 'partial', inputView: pv, inputViewHash: viewHash(pv),
      legalActions: moves, candidateEvidence: evidence,
      gateDecision: seat?.kind === 'llm' ? { modelVersion: prediction.modelVersion, expectedRegret: prediction.expectedRegret, highRegretProbability: prediction.highRegretProbability, threshold: sessionConfig.gateThreshold, triggered: gateTriggered } : undefined,
      llm: gateTriggered && seat?.kind === 'llm' ? {
        slot: 'reranker', modelProfileId: seat.modelProfileId, promptProfileId: 'pokemon-reranker-v2',
        exactMessages: modelInput ?? [], rawResponse: rawModelResponse ?? null, parsedOutput,
        samplingParams: { mode: seat.invocationMode }, latencyMs, tokenUsage: llmUsage, error: fallbackReason,
      } : undefined,
      baselineAction: baseline.action, chosenAction: action, fallbackUsed, fallbackReason,
      observation: publicView(game), reward: { pointsDelta: game.players[snapshot.currentPlayerIndex].points - snapshot.players[snapshot.currentPlayerIndex].points },
    });
    decisions = decisions.slice(-200);
    researchRecords = researchRecords.slice(-2_000);
    revision++; persist();
  } catch (e) {
    if (ticket === generation) { paused = true; agentError = e instanceof Error ? e.message : '模型请求失败'; persist(); }
  } finally {
    if (ticket === generation) { thinking = false; if (!paused) setTimeout(() => void tick(), 800); }
  }
}
function json(res: ServerResponse, status: number, obj: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function exportRecord(res: ServerResponse) {
  const visible = view().game;
  const record = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    game: { turn: game.turnNumber, isGameOver: game.isGameOver, winnerId: game.winnerId, state: visible },
    model: sessionConfig.mode === 'play' ? 'local-rules-engine' : 'mixed-experiment',
    agents: AGENTS.map(({ name, style, prompt }) => ({ name, style, prompt })),
    usage,
    decisions,
    researchRecords,
    sessionConfig,
    episode: serializableEpisode(),
    notes: 'schema v2: 规则入口零模型依赖；实验入口记录实际玩家视图、候选证据、门控判断、模型输入与原始响应。',
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="pokemon-review-${stamp}.json"`,
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(record, null, 2));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须为 JSON');
  let text = ''; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new Error('请求过大'); text += chunk; }
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效请求');
  return value;
}
function authenticated(req: IncomingMessage) {
  const id = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return !!id && (sessions.get(id) || 0) > Date.now();
}
function samePassword(value: unknown) { return typeof value === 'string' && timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(password).digest()); }
function ensureRevision(value: unknown) { if (value !== revision) throw new Error('棋局已更新，请稍后重试'); }
function normalizeAction(value: unknown): Action {
  const a = value as Action;
  if (!a || typeof a !== 'object') throw new Error('无效动作');
  if (a.type === 'DISCARD' && game.awaitingDiscard) {
    if (!a.tokens || Object.keys(a.tokens).some(k => !PAYABLE_ORDER.includes(k as typeof PAYABLE_ORDER[number]))) throw new Error('无效弃球');
    for (const t of PAYABLE_ORDER) if (!Number.isInteger(a.tokens[t]) || a.tokens[t] < 0) throw new Error('无效弃球数量');
    return a;
  }
  const candidate = legalMoves(game).find(m => {
    if (m.type !== a.type) return false;
    switch (m.type) {
      case 'BUY': case 'RESERVE': return 'source' in a && JSON.stringify(m.source) === JSON.stringify(a.source);
      case 'TAKE_THREE': return a.type === m.type && Array.isArray(a.colors) && [...m.colors].sort().join() === [...a.colors].sort().join();
      case 'TAKE_TWO': return a.type === m.type && a.color === m.color;
      case 'EVOLVE': return a.type === m.type && a.fromCardId === m.fromCardId && a.toCardId === m.toCardId;
      case 'END_TURN': return true;
      default: return false;
    }
  });
  if (!candidate) throw new Error('此动作不符合当前规则');
  return candidate;
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
export const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.jsdelivr.net data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const path = requestUrl.pathname;
    if (path === `${base}/api/health` && req.method === 'GET') return json(res, 200, { status: 'ok', app: 'pokemon-trainer' });
    if (path.startsWith(`${base}/api/`)) {
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: '不接受跨站请求' });
      if (path === `${base}/api/login` && req.method === 'POST') {
        if (Date.now() - loginWindow > 900000) { loginFailures = 0; loginWindow = Date.now(); }
        if (loginFailures >= 20) return json(res, 429, { error: '尝试过多，请 15 分钟后重试' });
        const b = await body(req);
        if (!samePassword(b.password)) { loginFailures++; return json(res, 401, { error: '访问口令不正确' }); }
        for (const [id, expiry] of sessions) if (expiry < Date.now()) sessions.delete(id);
        const token = randomBytes(32).toString('hex'); sessions.set(token, Date.now() + 7 * 86400000); loginFailures = 0;
        res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=${base}/; HttpOnly; SameSite=Strict; Max-Age=604800${cookieSecure ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (!authenticated(req)) return json(res, 401, { error: '请先输入访问口令' });
      if (path === `${base}/api/state` && req.method === 'GET') return json(res, 200, view());
      if (path === `${base}/api/export` && req.method === 'GET') return exportRecord(res);
      if (path === `${base}/api/experiments` && req.method === 'GET') {
        const id = requestUrl.searchParams.get('id');
        return json(res, 200, id ? experimentRunner.get(id) : experimentRunner.list());
      }
      if (req.method !== 'POST') return json(res, 404, { error: '接口不存在' });
      const b = await body(req);
      switch (path) {
        case `${base}/api/experiments`: {
          const job = experimentRunner.create(b.spec as unknown as ExperimentSpec);
          return json(res, 202, job);
        }
        case `${base}/api/new`: {
          ensureRevision(b.revision); cancel();
          sessionConfig = b.sessionConfig ? validateSessionConfig(b.sessionConfig) : defaultSessionConfig();
          game = fresh(sessionConfig); decisions = []; researchRecords = []; episode = createEpisode(game, sessionConfig);
          usage = { calls: 0, tokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }; revision++; paused = false; agentError = ''; persist(); break;
        }
        case `${base}/api/action`: {
          ensureRevision(b.revision);
          if (game.currentPlayerIndex !== 0 || game.isGameOver) throw new Error('现在不是你的回合');
          const action = normalizeAction(b.action); const next = applyAction(game, action);
          if (!['BUY','EVOLVE'].includes(action.type)) next.log.push(`你 ${actionLabel(action, game)}`);
          appendReplayStep(episode, game, action, next); game = next; revision++; persist(); break;
        }
        case `${base}/api/pause`: cancel(); paused = true; break;
        case `${base}/api/resume`: paused = false; agentError = ''; break;
        case `${base}/api/logout`: {
          const id = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
          if (id) sessions.delete(id);
          cancel(); paused = true;
          res.setHeader('Set-Cookie', `${cookieName}=; Path=${base}/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure ? '; Secure' : ''}`);
          return json(res, 200, { ok: true });
        }
        default: return json(res, 404, { error: '接口不存在' });
      }
      json(res, 200, view()); void tick(); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (path === base) { res.writeHead(302, { Location: `${base}/` }); res.end(); return; }
    if (!path.startsWith(`${base}/`)) { res.writeHead(404); res.end(); return; }
    let file = resolve(staticDir, decodeURIComponent(path.slice(base.length + 1)) || 'index.html');
    if (!file.startsWith(`${staticDir}/`)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : '操作失败' }); }
});
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) server.listen(Number(process.env.PORT || 8788), process.env.HOST || '127.0.0.1', () => console.log('Pokemon trainer ready'));
process.on('SIGTERM', () => { cancel(); persist(); server.close(() => process.exit(0)); });
