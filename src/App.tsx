import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Action, GameState } from './engine';
import { reviveState } from './net/serialize';
import { GameTable } from './ui/GameTable';

type Snapshot = {
  game: GameState; revision: number; paused: boolean; thinking: boolean; agentError: string; configured: boolean;
  settings: { baseUrl: string; model: string; hasKey: boolean }; usage: { calls: number; tokens: number; cacheHitTokens?: number; cacheMissTokens?: number };
  decisions: { turn: number; name: string; style: string; action: string; explanation: string; tokens: number }[];
};
async function api(path: string, data?: unknown) {
  const res = await fetch(`/pokemon/api/${path}`, { credentials: 'same-origin', ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  const result = await res.json();
  if (!res.ok) throw Object.assign(new Error(result.error || '请求失败'), { status: res.status });
  return result;
}
export function App() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [login, setLogin] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [connected, setConnected] = useState(true);
  const requestBusy = useRef(false);
  const latestRevision = useRef(-1);
  const accept = (next: Snapshot) => {
    if (next.revision < latestRevision.current) return;
    latestRevision.current = next.revision;
    next.game = reviveState(next.game);
    setState(next); setLogin(false); setConnected(true);
  };
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!requestBusy.current) {
        try { const next = await api('state'); if (!stopped && !requestBusy.current) accept(next); }
        catch (e) { if (!stopped) { if ((e as { status?: number }).status === 401) setLogin(true); else setConnected(false); } }
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  async function command(path: string, data: unknown = {}) {
    if (requestBusy.current) return;
    requestBusy.current = true; setBusy(true); setError('');
    try { const next = await api(path, data); if (next.game) accept(next); return next; }
    catch (e) { setError((e as Error).message); if ((e as { status?: number }).status === 401) setLogin(true); }
    finally { requestBusy.current = false; setBusy(false); }
  }
  async function onLogin(e: FormEvent) { e.preventDefault(); const ok = await command('login', { password }); if (ok) { setPassword(''); accept(await api('state')); } }
  async function exportReview() {
    setBusy(true); setError('');
    try {
      const res = await fetch('/pokemon/api/export', { credentials: 'same-origin' });
      if (!res.ok) { const body = await res.json(); throw Object.assign(new Error(body.error || '导出失败'), { status: res.status }); }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'pokemon-review.json';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); if ((e as { status?: number }).status === 401) setLogin(true); }
    finally { setBusy(false); }
  }
  if (login) return <main className="login-page"><div className="login-card"><div className="brand-mark">◓</div><div className="eyebrow">POKÉMON TRAINING ROOM</div><h1>你的私人训练桌</h1><p>璀璨宝石 · 宝可梦版</p><div className="login-seats"><span>你</span><span>赤焰</span><span>青岚</span><span>紫苑</span></div><form onSubmit={onLogin}><label>访问口令<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><button className="btn primary" disabled={busy}>进入训练桌</button></form>{error && <p role="alert" className="error-box">{error}</p>}<small>1 位真人 · 3 位规则引擎陪练</small></div></main>;
  if (!state) return <main className="login-page"><div className="login-card"><h1>正在连接训练桌…</h1>{!connected && <p role="alert">连接暂时中断，正在重试。</p>}</div></main>;
  const active = state.game.players[state.game.currentPlayerIndex];
  return <div className="app">
    <header className="trainer-header"><div className="brand"><span className="brand-mark">◓</span><div><div className="eyebrow">POKÉMON TRAINING ROOM</div><h1>璀璨宝石 <span>宝可梦陪练</span></h1></div></div><nav><button className="btn" onClick={() => setRulesOpen(!rulesOpen)}>玩法说明</button><button className="btn" disabled={busy} onClick={() => void exportReview()}>导出复盘</button><button className="btn primary" onClick={() => setConfirmNew(true)}>新对局</button></nav></header>
    <div className="training-meta"><span>私人四人桌 <b>01 / 04 HUMAN</b></span><span>本地规则引擎 · 无模型调用</span></div>
    {!connected && <div className="error-box" role="alert">连接中断，正在恢复。对局已保存在服务器。</div>}
    {error && <div className="error-box" role="alert">{error}<button className="btn tiny" onClick={() => setError('')}>关闭</button></div>}
    {rulesOpen && <section className="rules-box"><h2>快速上手</h2><p>每回合做一个主动作：取 3 种不同颜色的球、取同色 2 个（供给至少 4 个）、预订普通卡并获得大师球，或支付球捕捉宝可梦。可用颜色不足 3 种时，取全部可用颜色。</p><p>卡牌提供永久折扣。球最多持有 10 个，预订最多 3 张。主动作之后可以免费进化一次：永久加成满足旧卡进化条件，且下一阶在公共牌面或自己的预订区。被替换的旧卡不再计分或提供折扣。</p><p>达到 18 分后完成当前轮。先比分数，再比进化次数，最后比场上宝可梦数量。稀有与传说卡不能预订，需支付大师球，提供双倍加成。</p><p>三个 agent 由本地规则引擎独立决策，不读取牌库顺序或对手隐藏牌，不调用外部模型；可随时暂停。</p><p className="muted">卡牌数值使用社区转录的 90 张卡表，尚未逐张对照实体卡。非官方、非商业陪练项目。<a href="https://www.rulespal.com/splendor-pokemon/rulebook" target="_blank" rel="noreferrer">规则参考</a> · <a href="https://github.com/LeonJoeeee/splendor-pokemon" target="_blank" rel="noreferrer">开源引擎与 MIT 许可</a></p></section>}
    <section className={`agent-status ${state.thinking ? 'is-thinking' : ''}`} aria-live="polite"><div><b>{state.game.isGameOver ? '本局训练已结束' : state.thinking ? `${active.name} 正在思考…` : state.paused ? 'Agent 已暂停' : active.isAI ? `${active.name} 准备行动` : '轮到你了，选择下一步行动'}</b><span>{state.agentError || (state.paused ? '继续后，陪练将自动完成各自回合。' : '赤焰 · 抢分 / 青岚 · 进化 / 紫苑 · 控场')}</span></div>{!state.game.isGameOver && <button className="btn" disabled={busy || !state.configured} onClick={() => void command(state.paused ? 'resume' : 'pause')}>{state.paused ? state.agentError ? '重试并继续' : '继续陪练' : '暂停陪练'}</button>}</section>
    <div aria-busy={busy} className={busy || !connected ? 'board-locked' : ''}><GameTable game={state.game} youIndex={0} dispatch={(action: Action) => void command('action', { revision: state.revision, action })} /></div>
    <section className="decision-section"><div className="section-heading"><h2>陪练手记</h2><span>每一步的选择与取舍</span></div><div className="decision-grid">{state.decisions.length ? [...state.decisions].reverse().slice(0, 12).map((d, i) => <article className={`decision-card agent-${d.name}`} key={`${state.decisions.length}-${i}`}><header><b>{d.name} <small>{d.style}</small></b><span>回合 {d.turn}</span></header><h3>{d.action}</h3><p>{d.explanation}</p></article>) : ['赤焰|抢分型|抓住每一次得分窗口，尽早触发最终轮。','青岚|进化型|积累永久加成，寻找连续进化的机会。','紫苑|控场型|观察对手需求，争抢关键牌和稀缺资源。'].map(text => { const [name,style,desc] = text.split('|'); return <article className={`decision-card agent-${name}`} key={name}><header><b>{name} <small>{style}</small></b><span>等待开局</span></header><p>{desc}</p></article>; })}</div></section>
    <footer className="page-footer"><span>对局自动保存 · 刷新可继续 · 非官方同人陪练</span><button className="btn tiny" onClick={async () => { if (await command('logout')) { setState(null); setLogin(true); } }}>退出训练桌</button></footer>
    {confirmNew && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-title"><h2 id="new-title">开始新对局？</h2><p>当前对局和陪练手记将被替换，四位玩家重新开始。如需复盘，请先点击「导出复盘」。</p><div className="modal-actions"><button className="btn" onClick={() => setConfirmNew(false)}>保留当前对局</button><button className="btn primary" disabled={busy} onClick={async () => { if (await command('new', { revision: state.revision })) setConfirmNew(false); }}>重新发牌</button></div></section></div>}
  </div>;
}
