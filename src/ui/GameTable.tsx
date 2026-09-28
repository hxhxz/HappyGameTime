// 共享对局视图(本地与联机复用):回合栏 + 棋盘 + 侧栏 + 全部交互。
// 交互通过 dispatch(action) 上抛(本地=applyAction;联机=发服务器);youIndex=null 表示本地热座(操作当前行动者)。
import { useMemo, useState } from 'react';
import {
  buildBuyAction,
  colorVectorMeets,
  legalEvolutions,
  totalTokens,
  type Action,
  type Card,
  type Color,
  type EvolveAction,
  type GameState,
  type Stage,
} from '../engine';
import { ALL_PILES, COLOR_ORDER, PAYABLE_ORDER, type PayableToken } from '../engine/types';
import { CardView } from './CardView';
import { PlayerPanel } from './PlayerPanel';
import { TokenBank } from './TokenBank';
import { BALL_META, pokeArt, textOn } from './theme';

const TIER_ROWS: Stage[] = [3, 2, 1];
const zeroSel = (): Record<Color, number> => ({ red: 0, blue: 0, black: 0, pink: 0, yellow: 0 });
const zeroPool = (): Record<PayableToken, number> => ({ red: 0, blue: 0, black: 0, pink: 0, yellow: 0, master: 0 });

function findAnywhere(game: GameState, cardId: string): Card | null {
  for (const p of game.players) for (const c of [...p.purchased, ...p.reserved]) if (c.id === cardId) return c;
  for (const pile of ALL_PILES) {
    const c = game.decks[pile].faceUp.find((x) => x?.id === cardId);
    if (c) return c;
  }
  return null;
}

export function GameTable({ game, youIndex, dispatch }: { game: GameState; youIndex: number | null; dispatch: (a: Action) => void }) {
  const [selected, setSelected] = useState<Record<Color, number>>(zeroSel);
  const [discardSel, setDiscardSel] = useState<Record<PayableToken, number>>(zeroPool);
  const [backpackOpen, setBackpackOpen] = useState(false);
  const [openTiers, setOpenTiers] = useState<Set<Stage>>(() => new Set([1]));

  const current = game.players[game.currentPlayerIndex];
  const me = youIndex != null ? game.players[youIndex] : current; // 视角玩家
  const isMyTurn = !game.isGameOver && (youIndex != null ? game.currentPlayerIndex === youIndex : !current.isAI);
  const isHumanTurn = isMyTurn && !game.awaitingDiscard && !game.awaitingEvolve;
  const humanDiscarding = isMyTurn && game.awaitingDiscard;
  const humanEvolving = isMyTurn && game.awaitingEvolve;
  const evolveOptions = useMemo<EvolveAction[]>(() => (humanEvolving ? legalEvolutions(game, me) : []), [game, humanEvolving, me]);

  const act = (a: Action) => { dispatch(a); setSelected(zeroSel()); setDiscardSel(zeroPool()); };

  // 取币
  const selectedCount = COLOR_ORDER.reduce((n, c) => n + (selected[c] > 0 ? 1 : 0), 0);
  const availColors = COLOR_ORDER.filter((c) => game.tokenPool[c] > 0).length;
  const canConfirmTake = isHumanTurn && selectedCount >= 1 && selectedCount === Math.min(3, availColors);
  const toggleSelect = (c: Color) => setSelected((s) => {
    const next = { ...s };
    if (next[c] > 0) next[c] = 0;
    else if (selectedCount < 3 && game.tokenPool[c] > 0) next[c] = 1;
    return next;
  });

  // 弃牌
  const discardNeeded = Math.max(0, totalTokens(me.tokens) - 10);
  const discardChosen = PAYABLE_ORDER.reduce((n, t) => n + discardSel[t], 0);
  const stepDiscard = (t: PayableToken, d: number) => setDiscardSel((s) => {
    const v = s[t] + d;
    if (v < 0 || v > me.tokens[t]) return s;
    if (d > 0 && discardChosen >= discardNeeded) return s;
    return { ...s, [t]: v };
  });

  // 购买/预订(视角=me;仅 isHumanTurn 时可操作)
  const affordBoard = (cardId: string): boolean => {
    if (!isHumanTurn) return false;
    const card = findAnywhere(game, cardId);
    return !!card && buildBuyAction(me, card, { kind: 'board', cardId }) !== null;
  };
  const boardMasterSpend = (cardId: string): number => {
    if (!isHumanTurn) return 0;
    const card = findAnywhere(game, cardId);
    return card ? buildBuyAction(me, card, { kind: 'board', cardId })?.resolution.masterSpent ?? 0 : 0;
  };
  const reservedAfford = (): Set<string> => {
    const s = new Set<string>();
    if (!isHumanTurn) return s;
    for (const c of me.reserved) if (buildBuyAction(me, c, { kind: 'reserved', cardId: c.id })) s.add(c.id);
    return s;
  };
  const buyBoard = (cardId: string) => {
    const card = findAnywhere(game, cardId);
    const built = card && buildBuyAction(me, card, { kind: 'board', cardId });
    if (built) act(built.action);
  };
  const buyReserved = (cardId: string) => {
    const card = me.reserved.find((c) => c.id === cardId);
    const built = card && buildBuyAction(me, card, { kind: 'reserved', cardId });
    if (built) act(built.action);
  };
  const canReserve = isHumanTurn && me.reserved.length < 3;
  const reservedSet = reservedAfford();
  const reservedMasterSpend = (card: Card): number => isHumanTurn
    ? buildBuyAction(me, card, { kind: 'reserved', cardId: card.id })?.resolution.masterSpent ?? 0
    : 0;

  // 进化(视角=me)
  const targetAvailable = (speciesId: string): boolean => {
    for (const pile of ALL_PILES) if (game.decks[pile].faceUp.some((c) => c && c.kind === 'normal' && c.speciesId === speciesId)) return true;
    return me.reserved.some((c) => c.kind === 'normal' && c.speciesId === speciesId);
  };
  const evoStateOfBoard = (card: Card): 'can' | 'target' | null => {
    if (card.kind !== 'normal' || card.stage <= 1) return null;
    const pre = me.purchased.find((x) => x.kind === 'normal' && x.stage === card.stage - 1 && x.evolvesToSpeciesId === card.speciesId && x.evolveCost);
    if (!pre) return null;
    return colorVectorMeets(me.bonuses, pre.evolveCost!) ? 'can' : 'target';
  };
  const ownedEvo = (card: Card): { cls: string; label: string } | null => {
    if (card.kind !== 'normal' || card.stage >= 3 || !card.evolvesToSpeciesId || !card.evolveCost) return null;
    const meet = colorVectorMeets(me.bonuses, card.evolveCost);
    const avail = targetAvailable(card.evolvesToSpeciesId);
    if (meet && avail) return { cls: 'can', label: '✦可进化' };
    if (meet && !avail) return { cls: 'ready', label: '就绪·待目标' };
    const short = COLOR_ORDER.filter((c) => (card.evolveCost![c] ?? 0) > me.bonuses[c])
      .map((c) => `${BALL_META[c].zh.replace('球', '')}${(card.evolveCost![c] ?? 0) - me.bonuses[c]}`).join(' ');
    return { cls: 'need', label: `还需 ${short}` };
  };

  const renderRow = (pile: Stage, label: string, canDeckReserve: boolean) => (
    <section className={`tier-drawer ${openTiers.has(pile) ? 'is-open' : ''}`} key={String(pile)}>
      <div className="tier-drawer-head">
        <button className="drawer-toggle" aria-expanded={openTiers.has(pile)} onClick={() => setOpenTiers(current => { const next = new Set(current); if (next.has(pile)) next.delete(pile); else next.add(pile); return next; })}>
          <span className="drawer-chevron" aria-hidden="true" />
          <strong>{label}</strong>
          <span className="deck-count">牌库 {game.decks[pile].drawPile.length} 张</span>
        </button>
        {canDeckReserve && (
          <button className="btn tiny drawer-reserve" disabled={!canReserve || game.decks[pile].drawPile.length === 0} onClick={() => act({ type: 'RESERVE', source: { kind: 'deck', pile } })}>盲抽预订</button>
        )}
      </div>
      {openTiers.has(pile) && <div className="cards-row tier-drawer-body">
        {game.decks[pile].faceUp.map((card, i) => card ? (
          <CardView key={card.id} card={card} affordable={affordBoard(card.id)} masterSpend={boardMasterSpend(card.id)} evoState={evoStateOfBoard(card)}
            onBuy={isHumanTurn ? () => buyBoard(card.id) : undefined}
            onReserve={canReserve && card.kind === 'normal' ? () => act({ type: 'RESERVE', source: { kind: 'board', cardId: card.id } }) : undefined} />
        ) : <div key={`e-${String(pile)}-${i}`} className="card empty">空</div>)}
      </div>}
    </section>
  );

  const renderSpecial = (pile: 'rare' | 'legendary', label: string) => {
    const card = game.decks[pile].faceUp[0];
    return (
      <div className={`special-cell ${pile}`} key={pile}>
        <div className="special-head"><span className="special-label">{label}</span><span className="deck-count">{game.decks[pile].drawPile.length}张</span></div>
        {card ? <CardView card={card} affordable={affordBoard(card.id)} masterSpend={boardMasterSpend(card.id)} onBuy={isHumanTurn ? () => buyBoard(card.id) : undefined} /> : <div className="card empty">空</div>}
      </div>
    );
  };

  const winner = game.isGameOver ? game.players.find((p) => p.id === game.winnerId) : undefined;

  return (
    <>
      <div className="turnbar">
        {game.isGameOver ? (
          <span className="winner-banner">🏆 {winner ? `${winner.name} 获胜!` : '对局结束'}（{Math.max(...game.players.map((p) => p.points))} 分,第 {game.turnNumber} 回合）</span>
        ) : (
          <>
            <span className="turn-info">第 {game.turnNumber} 回合 · 轮到 <b>{current.isAI ? '🤖' : '🧑'} {current.name}</b>{youIndex != null && current.id === me.id && '(你)'}</span>
            {game.awaitingDiscard && <span className="discard-note">{isMyTurn ? '手牌超过 10,请在下方弃牌' : `${current.name} 弃牌中…`}</span>}
            {game.awaitingEvolve && <span className="evolve-note">{isMyTurn ? '回合末:可进化或结束回合' : `${current.name} 进化中…`}</span>}
            {game.endTriggeredByPlayerIndex !== null && <span className="final-note">⚠ 最终回合(有人 ≥18)</span>}
            {!isMyTurn && !game.awaitingDiscard && !game.awaitingEvolve && <span className="thinking">⏳ 等待 {current.name}…</span>}
          </>
        )}
      </div>

      <section className="my-assets-strip" aria-label="我的手牌与颜色资产">
        <span className="asset-strip-title">{me.name}的资产</span>
        {COLOR_ORDER.map((color) => <span className="asset-color" key={color} title={`${BALL_META[color].zh}：手牌 ${me.tokens[color]}，永久资产 ${me.bonuses[color]}`}>
          <i style={{ background: BALL_META[color].hex }} />
          <b>{me.tokens[color]}</b><em>+{me.bonuses[color]}</em>
        </span>)}
        <span className="asset-color master" title={`大师球：${me.tokens.master}`}><i style={{ background: BALL_META.master.hex }} /><b>{me.tokens.master}</b><em>百搭</em></span>
        <span className="asset-strip-legend">手牌 <b>数字</b> · 资产 <em>+折扣</em></span>
        <span className="purchase-power-row">
          <small>购买力</small>
          {COLOR_ORDER.map((color) => <b key={color} title={`${BALL_META[color].zh}购买力：${me.tokens[color]} 手牌 + ${me.bonuses[color]} 资产`}><i style={{ background: BALL_META[color].hex }} />{me.tokens[color] + me.bonuses[color]}</b>)}
          <b className="master" title={`大师球百搭：${me.tokens.master}`}><i style={{ background: BALL_META.master.hex }} />{me.tokens.master}</b>
        </span>
      </section>

      <div className="layout">
        <main className="board">
          {TIER_ROWS.map((t) => renderRow(t, `T${t}`, true))}
          <div className="bottom-row">
          <section className="special-section">
            {renderSpecial('legendary', '传说')}
            {renderSpecial('rare', '稀有')}
          </section>
          <section className="bank-section">
            {humanEvolving ? (
              <div className="evolve-panel">
                <span className="section-label">⤴ 回合末进化(免费,凭永久加成)</span>
                <div className="evolve-row">
                  {evolveOptions.length === 0 && <span className="muted">无可进化</span>}
                  {evolveOptions.map((ev, i) => {
                    const from = findAnywhere(game, ev.fromCardId);
                    const to = findAnywhere(game, ev.toCardId);
                    return <button key={i} className="btn evolve-btn" onClick={() => act(ev)}>⤴ {from?.nameZh} → {to?.nameZh}</button>;
                  })}
                  <button className="btn" onClick={() => act({ type: 'END_TURN' })}>结束回合(不进化)</button>
                </div>
              </div>
            ) : humanDiscarding ? (
              <div className="discard-panel">
                <span className="section-label">⚠ 需弃掉 {discardNeeded} 个(已选 {discardChosen})</span>
                <div className="discard-row">
                  {PAYABLE_ORDER.filter((t) => me.tokens[t] > 0).map((t) => (
                    <div key={t} className="discard-col">
                      <span className="mini-token" style={{ background: BALL_META[t].hex, color: textOn(t) }}>{BALL_META[t].zh.replace('球', '')} {me.tokens[t] - discardSel[t]}</span>
                      <div className="stepper">
                        <button className="btn tiny" disabled={discardSel[t] === 0} onClick={() => stepDiscard(t, -1)}>−</button>
                        <span className="step-val">{discardSel[t]}</span>
                        <button className="btn tiny" disabled={me.tokens[t] === discardSel[t] || discardChosen >= discardNeeded} onClick={() => stepDiscard(t, 1)}>＋</button>
                      </div>
                    </div>
                  ))}
                </div>
                <button className="btn primary" disabled={discardChosen !== discardNeeded} onClick={() => act({ type: 'DISCARD', tokens: { ...discardSel } })}>确认弃牌</button>
              </div>
            ) : (
              <>
                <span className="section-label">宝可梦球供给区</span>
                <TokenBank pool={game.tokenPool} active={isHumanTurn} selected={selected} selectedCount={selectedCount} canConfirm={canConfirmTake}
                  onToggle={toggleSelect} onTakeTwo={(c) => act({ type: 'TAKE_TWO', color: c })}
                  onConfirmTake={() => act({ type: 'TAKE_THREE', colors: COLOR_ORDER.filter((c) => selected[c] > 0) })}
                  onClear={() => setSelected(zeroSel())} />
              </>
            )}
          </section>
          </div>
        </main>

        <aside className="sidebar">
          <div className="players">
            {game.players.map((p, i) => (
              <PlayerPanel key={p.id} player={p} isCurrent={i === game.currentPlayerIndex && !game.isGameOver} />
            ))}
          </div>
          <div className="reserve-area">
            <span className="section-label">我的预订（{me.reserved.length}/3）{youIndex != null ? '' : `· ${me.name}`}</span>
            <div className="reserved-row">
              {me.reserved.length === 0 && <span className="muted">无预订(预订上限 3,可锁定心仪卡并得 1 大师球)</span>}
              {me.reserved.map((c) => (
                <CardView key={c.id} card={c} reservedTag affordable={reservedSet.has(c.id)} masterSpend={reservedMasterSpend(c)} onBuy={isHumanTurn ? () => buyReserved(c.id) : undefined} />
              ))}
            </div>
          </div>
          <div className="owned-team">
            <span className="section-label">{me.name} 的宝可梦（{me.purchased.length}）{me.evolved.length > 0 && `· 已进化 ${me.evolved.length}`}</span>
            <div className="owned-chips">
              {me.purchased.length === 0 && <span className="muted">尚无</span>}
              {[...me.purchased].sort((a, b) => COLOR_ORDER.indexOf(a.bonus) - COLOR_ORDER.indexOf(b.bonus) || a.stage - b.stage).map((c) => {
                const evo = ownedEvo(c);
                return (
                  <span key={c.id} className={`owned-chip ${evo ? `e-${evo.cls}` : ''}`} title={c.name}>
                    <i className="odot" style={{ background: BALL_META[c.bonus].hex }} />{c.nameZh}<sup>{c.stage}</sup>
                    {evo && <em className={`oevo ${evo.cls}`}>{evo.label}</em>}
                  </span>
                );
              })}
            </div>
          </div>
          <div className="log">
            <span className="section-label">对局记录</span>
            <ul>{game.log.slice(-16).reverse().map((l, i) => <li key={game.log.length - i}>{l}</li>)}</ul>
          </div>
        </aside>
      </div>
      <button className="backpack-fab" onClick={() => setBackpackOpen(true)} aria-label="打开宝可梦背包"><span>🎒</span><b>背包</b><em>{me.purchased.length}</em></button>
      {backpackOpen && <div className="backpack-backdrop" onClick={() => setBackpackOpen(false)}>
        <section className="backpack-panel" role="dialog" aria-modal="true" aria-labelledby="backpack-title" onClick={(event) => event.stopPropagation()}>
          <header><div><span className="eyebrow">TRAINER INVENTORY</span><h2 id="backpack-title">{me.name}的宝可梦背包</h2></div><button className="btn" onClick={() => setBackpackOpen(false)}>关闭</button></header>
          <p className="backpack-summary">已有 {me.purchased.length} 只 · 已完成进化 {me.evolved.length} 次 · 当前 {me.points} 分</p>
          <div className="backpack-grid">
            {me.purchased.length === 0 && <p className="muted">还没有宝可梦，先从 T1 开始捕捉吧。</p>}
            {[...me.purchased].sort((a, b) => a.stage - b.stage || b.points - a.points).map((card) => {
              const evo = ownedEvo(card);
              return <article className="backpack-card" key={card.id}>
                <img src={pokeArt(card.dexId)} alt="" />
                <div className="backpack-card-main"><div><strong>{card.nameZh}</strong><span>T{card.stage} · {card.points}分</span></div><span className="backpack-bonus"><i style={{ background: BALL_META[card.bonus].hex }} />资产 +{card.bonusAmount}</span>
                  {card.evolvesToSpeciesId && card.evolveCost ? <div className="upgrade-needs"><small>{evo?.label || '升级需求'}</small>{COLOR_ORDER.filter(color => (card.evolveCost?.[color] ?? 0) > 0).map(color => <span key={color} className={me.bonuses[color] >= (card.evolveCost?.[color] ?? 0) ? 'met' : ''}><i style={{ background: BALL_META[color].hex }} />{me.bonuses[color]}/{card.evolveCost?.[color]}</span>)}</div> : <small className="max-stage">已是最终阶段</small>}
                </div>
              </article>;
            })}
          </div>
        </section>
      </div>}
    </>
  );
}
