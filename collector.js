// 안전 길드 상황판 v2 — mgf.gg 수집기
// mgf.gg 페이지 안에서 실행됩니다 (북마클릿 · 매일 예약 작업 공용).
// 대항전 라인업 + 안전 길드를 6초 간격으로 한 장씩 읽어 Supabase에 저장합니다.
// mgf.gg가 접속 확인 화면을 띄우면 즉시 멈춥니다 (우회하지 않음).

const SB_URL = 'https://praykhkkxjmkpcpqaoiy.supabase.co';
const SB_KEY = 'sb_publishable_bcZ4dmnQ7aMubs76eenGFQ_P3jXJ3Nr';
const HOME_GUILD = '안전';
const GAP_MS = 6000;

const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(/INVALID_CODE/.test(t) ? 'INVALID_CODE' : `${fn} ${r.status} ${t.slice(0, 120)}`);
  return t ? JSON.parse(t) : null;
}

export function parseGuild(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...d.querySelectorAll('.member-row[data-gb]')];
  const name = d.querySelector('.guild-name')?.textContent.trim();
  if (!name || !rows.length) return null;
  const txt = (s) => d.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '';
  const pills = {};
  d.querySelectorAll('.stat-pill').forEach((p) => {
    pills[p.querySelector('.stat-pill-label')?.textContent.trim()] = p.querySelector('.stat-pill-value')?.textContent.trim();
  });
  const ranks = [...d.querySelectorAll('.guild-rank-badge .rank-num')].map((x) => x.textContent.trim());
  const master = txt('.master-nick');
  const members = rows.map((r) => {
    const sub = (r.querySelector('.member-sub')?.textContent || '').replace(/\s+/g, ' ').trim();
    const [job, lvs] = sub.split('|').map((s) => s.trim());
    const lv = parseInt((lvs || '').replace(/\D/g, ''), 10) || null;
    const m = { n: r.querySelector('.nick-link')?.textContent.trim(), j: job || '', lv,
      bp: r2(Number(r.dataset.bp || 0) / 1e12), gb: r2(Number(r.dataset.gb || 0) / 1e8) };
    if (master && m.n === master) m.m = 1;
    return m;
  }).filter((m) => m.n);
  const gbTip = (d.querySelector('.metric-gb .power-tooltip')?.textContent || '').replace(/\D/g, '');
  return {
    guild: name,
    server: txt('.server-chip'),
    lv: pills['레벨'] || '',
    master,
    overall_rank: ranks[0] || '',
    server_rank: ranks[1] || '',
    source_date: txt('.guild-update-row').replace(/[^\d.]/g, '').replace(/\.$/, ''),
    total_bp: r2(members.reduce((s, m) => s + m.bp, 0)),
    total_gb: gbTip ? r2(Number(gbTip) / 1e8) : r2(members.reduce((s, m) => s + m.gb, 0)),
    members,
  };
}

/**
 * @param {{code:string, source?:string, extra?:string[], dry?:boolean, onProgress?:(msg:string)=>void}} opt
 */
export async function collect(opt = {}) {
  if (!location.hostname.endsWith('mgf.gg')) throw new Error('mgf.gg 페이지에서 실행해야 합니다');
  const say = opt.onProgress || (() => {});
  if (!opt.dry && !(await rpc('gvg_check', { p_code: opt.code }))) throw new Error('INVALID_CODE');
  let lineup = [];
  try {
    const s = await (await fetch(`${SB_URL}/rest/v1/gvg_settings?select=lineup&id=eq.1`, { headers: H })).json();
    lineup = (s && s[0] && s[0].lineup) || [];
  } catch (e) { /* 설정을 못 읽어도 안전 길드는 수집 */ }
  const names = [...new Set([HOME_GUILD, ...lineup, ...(opt.extra || [])].map((s) => String(s).trim()).filter(Boolean))];
  const ok = [], failed = [], data = [];
  for (let i = 0; i < names.length; i++) {
    const g = names[i];
    if (i) await sleep(GAP_MS);
    say(`[${i + 1}/${names.length}] ${g}`);
    let res, html;
    const load = async () => {
      res = await fetch('/contents/guild_info.php?g_name=' + encodeURIComponent(g), { credentials: 'include' });
      html = await res.text();
    };
    const isBlocked = () => res.status === 403 || res.status === 429 || /<title>확인 중/.test(html);
    try {
      await load();
      if (isBlocked()) { say(`${g}: 접속 확인 화면 — 90초 쉬고 한 번만 다시 시도`); await sleep(90000); await load(); }
    } catch (e) { failed.push({ g, why: 'network' }); continue; }
    if (isBlocked()) {
      failed.push({ g, why: 'blocked' });
      names.slice(i + 1).forEach((x) => failed.push({ g: x, why: 'skipped' }));
      break;
    }
    const p = parseGuild(html);
    if (!p || p.guild !== g) { failed.push({ g, why: 'not_found' }); continue; }
    p.source = opt.source || 'manual';
    data.push(p);
    if (!opt.dry) {
      try { await rpc('gvg_ingest', { p_code: opt.code, p_data: p }); ok.push(g); }
      catch (e) { failed.push({ g, why: String(e.message || e).slice(0, 60) }); }
    } else ok.push(g);
  }
  if (!opt.dry) {
    try { await rpc('gvg_log_run', { p_code: opt.code, p_source: opt.source || 'manual', p_ok: ok.length, p_failed: failed }); } catch (e) {}
  }
  return { ok, failed, data: opt.dry ? data : undefined, at: new Date().toISOString() };
}

/** 예약 작업용: 지금 열려 있는 길드 페이지 1장을 그대로 저장 (페이지 이동은 브라우저가 직접). */
export async function ingestCurrentPage(opt = {}) {
  const want = new URLSearchParams(location.search).get('g_name');
  if (/<title>확인 중/.test(document.documentElement.outerHTML) || document.title.includes('확인 중')) return { guild: want, why: 'blocked' };
  const p = parseGuild(document.documentElement.outerHTML);
  if (!p || p.guild !== want) return { guild: want, why: 'not_found' };
  p.source = opt.source || 'schedule';
  if (opt.dry) return { guild: p.guild, ok: true, members: p.members.length };
  await rpc('gvg_ingest', { p_code: opt.code, p_data: p });
  return { guild: p.guild, ok: true, members: p.members.length, total_gb: p.total_gb };
}

/** 예약 작업용: 수집할 길드 목록(안전 + 라인업) */
export async function targets() {
  const s = await (await fetch(`${SB_URL}/rest/v1/gvg_settings?select=lineup&id=eq.1`, { headers: H })).json();
  return [...new Set([HOME_GUILD, ...((s && s[0] && s[0].lineup) || [])])];
}

/** 예약 작업용: 실행 기록 남기기 */
export async function logRun(opt) {
  return rpc('gvg_log_run', { p_code: opt.code, p_source: opt.source || 'schedule', p_ok: opt.ok || 0, p_failed: opt.failed || [] });
}
