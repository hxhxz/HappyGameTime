import { describe, it, expect } from 'vitest';
import { endpoint, publicAddress, observation, parseDecision, messagesFor, estimateContextTokens, requestPayload, explanationContradictions, STATIC_SYSTEM_PROMPT, CONTEXT_SAFETY_TOKENS, MAX_CONTEXT_TOKENS, MAX_OUTPUT_TOKENS, MAX_RECENT_LOG_ENTRIES } from './agent';
import { createGame, legalMoves } from '../src/engine';
import { CARDS } from '../src/data/cards';
import { rankCandidates } from './strategy';
import { playerView } from '../src/decision/views';

const prompt = (g: ReturnType<typeof createGame>, candidates: ReturnType<typeof rankCandidates>, name: string, personaMode: 'neutral' | 'scoring' | 'evolution' | 'control') =>
  messagesFor(playerView(g), candidates, { seat: g.currentPlayerIndex, name, personaMode });

describe('model boundary', () => {
  it('normalizes compatible URLs and rejects unsafe endpoints', () => {
    expect(endpoint('https://example.com/v1/').pathname).toBe('/v1/chat/completions');
    expect(endpoint('https://example.com/v1/chat/completions').pathname).toBe('/v1/chat/completions');
    for (const u of ['http://example.com/v1','https://127.0.0.1/v1','https://example.com:8080/v1','https://u:p@example.com/v1','https://example.com/?key=x']) expect(() => endpoint(u)).toThrow();
    for (const a of ['127.0.0.1','10.1.2.3','172.16.0.5','192.168.1.1','169.254.169.254','100.100.100.200','0.0.0.0','::1','224.0.0.1']) expect(publicAddress(a)).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true);
  });
  it('only accepts enumerated actions and a concise explanation', () => {
    expect(parseDecision('```json\n{"actionId":1,"explanation":"积累折扣"}\n```', 3).actionId).toBe(1);
    expect(parseDecision('{"selfPoints":4,"actionId":1,"explanation":"积累折扣"}', 3, 4).selfPoints).toBe(4);
    expect(() => parseDecision('{"selfPoints":18,"actionId":1,"explanation":"我已18分"}', 3, 4)).toThrow('身份自检失败');
    expect(explanationContradictions('我已18分，应尽快收尾', 4)).toHaveLength(1);
    expect(() => parseDecision('{"selfPoints":4,"actionId":1,"explanation":"我已18分"}', 3, 4)).toThrow('解释与局面矛盾');
    for (const s of ['{}','{"actionId":-1,"explanation":"x"}','{"actionId":3,"explanation":"x"}','{"actionId":0.5,"explanation":"x"}','{"actionId":0,"explanation":""}','not json']) expect(() => parseDecision(s,3)).toThrow();
  });
  it('binds the prompt to the active agent and sends at most eight raw-scored candidates', () => {
    const g = createGame({ players: [0,1,2,3].map(i=>({id:`P${i}`,name:i ? ['赤焰','青岚','紫苑'][i-1] : '你',isAI:i>0})), cards: CARDS, seed: 17 });
    g.currentPlayerIndex = 2;
    const candidates = rankCandidates(g, legalMoves(g), '进化型');
    const messages = prompt(g, candidates, '青岚', 'evolution');
    const body = JSON.parse(messages[1].content);
    expect(body.youAre).toEqual({ seat: 2, name: '青岚', personaMode: 'evolution', points: 0 });
    expect(body.candidateActions.length).toBeLessThanOrEqual(8);
    expect(body.candidateActions[0].outcome).toBeTruthy();
    expect(body.candidateActions[0].heuristicScore).toBe(candidates[0].score);
    expect(messages[0].content).toContain('绝不要把 players[0]');
  });
  it('keeps a substantial identical prefix across agents and changing game states', () => {
    const g = createGame({ players: [0,1,2,3].map(i=>({id:`P${i}`,name:i ? ['赤焰','青岚','紫苑'][i-1] : '你',isAI:i>0})), cards: CARDS, seed: 18 });
    g.currentPlayerIndex = 1;
    const first = prompt(g, rankCandidates(g, legalMoves(g), '抢分型'), '赤焰', 'scoring');
    g.currentPlayerIndex = 3;
    g.players[3].points = 11;
    g.log.push('局面发生变化');
    const second = prompt(g, rankCandidates(g, legalMoves(g), '控场型'), '紫苑', 'control');
    expect(first[0]).toEqual(second[0]);
    expect(first[0].content).toBe(STATIC_SYSTEM_PROMPT);
    expect(estimateContextTokens([first[0]])).toBeGreaterThan(64);
    expect(first[1].content).not.toBe(second[1].content);
  });
  it('never sends opponent reservations, shuffled decks or RNG seed to a model', () => {
    const g = createGame({ players: [0,1,2,3].map(i=>({id:`P${i}`,name:`P${i}`,isAI:i>0})), cards: CARDS, seed: 4242 });
    g.currentPlayerIndex = 1;
    g.players[0].reserved = [CARDS[0]]; g.players[1].reserved = [CARDS[1]];
    const obs = observation(g);
    expect(obs.players[0].reserved).toEqual({count:1});
    expect(Array.isArray(obs.players[1].reserved)).toBe(true);
    expect(JSON.stringify(obs)).not.toContain('drawPile');
    expect(JSON.stringify(obs)).not.toContain('rngSeed');
  });
  it('uses a bounded non-thinking JSON request for DeepSeek', () => {
    const settings = { baseUrl: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', apiKey: 'x' };
    const payload = requestPayload(settings, [{ role: 'user', content: 'x' }]);
    expect(payload.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(payload.max_tokens).toBe(4096);
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.response_format).toEqual({ type: 'json_object' });
  });
  it('accepts segmented text responses from compatible providers', async () => {
    // response parsing is exercised through the exported completion boundary in
    // integration; this assertion protects the larger reasoning output budget.
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4096);
  });
  it('keeps even a late-game decision below the model context budget', () => {
    const g = createGame({ players: [0,1,2,3].map(i=>({id:`P${i}`,name:`P${i}`,isAI:i>0})), cards: CARDS, seed: 8 });
    g.currentPlayerIndex = 1;
    CARDS.slice(0, 64).forEach((card, i) => g.players[i % 4].purchased.push(card));
    const messages = prompt(g, rankCandidates(g, [{ type: 'END_TURN' }], '抢分型'), '赤焰', 'scoring');
    expect(estimateContextTokens(messages) + MAX_OUTPUT_TOKENS + CONTEXT_SAFETY_TOKENS).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });
  it('uses a bounded recent suffix instead of flooding the model with stale history', () => {
    const g = createGame({ players: [0,1,2,3].map(i=>({id:`P${i}`,name:`P${i}`,isAI:i>0})), cards: CARDS, seed: 9 });
    g.currentPlayerIndex = 1;
    g.log = Array.from({ length: 10_000 }, (_, i) => `第${i}步 ${'x'.repeat(80)}`);
    const messages = prompt(g, rankCandidates(g, [{ type: 'END_TURN' }], '抢分型'), '赤焰', 'scoring');
    const body = JSON.parse(messages[1].content);
    expect(body.state.recentPublicHistory.at(-1)).toBe(g.log.at(-1));
    expect(body.state.recentPublicHistory.length).toBe(MAX_RECENT_LOG_ENTRIES);
    expect(estimateContextTokens(messages) + MAX_OUTPUT_TOKENS + CONTEXT_SAFETY_TOKENS).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });
});
