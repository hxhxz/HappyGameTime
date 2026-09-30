import { ALL_PILES, type Card, type GameState } from '../engine/types';
import type { OracleView, PlayerView, PublicView, VisibleCard } from './types';

export function visibleCard(card: Card): VisibleCard {
  return {
    id: card.id, name: card.nameZh, kind: card.kind, stage: card.stage,
    points: card.points, cost: { ...card.cost }, bonus: card.bonus,
    bonusAmount: card.bonusAmount, speciesId: card.speciesId,
    evolvesToSpeciesId: card.evolvesToSpeciesId,
  };
}

export function publicView(state: GameState): PublicView {
  return {
    currentPlayerIndex: state.currentPlayerIndex,
    tokenPool: { ...state.tokenPool },
    decks: ALL_PILES.map(key => ({
      key,
      remaining: state.decks[key].drawPile.length,
      faceUp: state.decks[key].faceUp.map(card => card ? visibleCard(card) : null),
    })),
    players: state.players.map(player => ({
      id: player.id, name: player.name, tokens: { ...player.tokens },
      purchased: player.purchased.map(visibleCard), evolvedCount: player.evolved.length,
      reservedCount: player.reserved.length, bonuses: { ...player.bonuses }, points: player.points,
    })),
    turnNumber: state.turnNumber,
    phase: state.isGameOver ? 'finished' : state.awaitingDiscard ? 'discard' : state.awaitingEvolve ? 'evolve' : 'main',
    isGameOver: state.isGameOver,
    winnerId: state.winnerId,
    recentPublicHistory: state.log.slice(-8),
  };
}

export function playerView(state: GameState, playerIndex = state.currentPlayerIndex): PlayerView {
  const base = publicView(state);
  const player = state.players[playerIndex];
  if (!player) throw new Error(`unknown player index ${playerIndex}`);
  return { ...base, viewerId: player.id, privateReserved: player.reserved.map(visibleCard) };
}

export function oracleView(state: GameState): OracleView {
  return { informationClass: 'oracle_full', state: structuredClone(state) };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

export function viewHash(view: PlayerView | PublicView | OracleView): string {
  const text = JSON.stringify(stable(view));
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 ^ text.charCodeAt(i), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}
