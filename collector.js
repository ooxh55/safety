// 메이플키우기 길드 데이터 센터 — mgf.gg 수집기
// mgf.gg 페이지 안에서 실행됩니다 (북마클릿 · 예약 작업 공용).
// 페이지를 6초 간격으로 한 장씩 읽어 Supabase에 저장합니다.
// mgf.gg가 접속 확인 화면을 띄우면 90초 쉬고 한 번만 다시 시도하고, 그래도 막히면 멈춥니다 (우회하지 않음).

const SB_URL = 'https://praykhkkxjmkpcpqaoiy.supabase.co';
const SB_KEY = 'sb_publishable_bcZ4dmnQ7aMubs76eenGFQ_P3jXJ3Nr';
const HOME_GUILD = '안전';
const HOME_SERVER = 4;
const SERVER_TOP = 20;            // 4서버 길드 랭킹 상위 몇 개 길드를 합산할지
const GAP_MS = 6000;
const PER_PAGE = 30;              // mgf.gg 토벌전 랭킹 1페이지 인원
// 토벌전 4서버 등수 구간 경계 (이 등수의 점수를 커트라인으로 저장)
export const TB_BOUNDS = [1, 2, 3, 10, 30, 50, 70, 100, 150, 200, 250, 350, 500, 1000, 2000, 3000, 5000];

const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(/INVALID_CODE/.test(t) ? 'INVALID_CODE' : `${fn} ${r.status} ${t.slice(0, 120)}`);
  return t ? JSON.parse(t) : null;
}
async function rest(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  return r.ok ? r.json() : [];
}

let lastFetch = 0;
/** mgf.gg 페이지 1장 읽기 (간격 유지 · 차단 감지). 반환: {html} | {blocked:true} | {error} */
async function getPage(path, say = () => {}) {
  const wait = lastFetch + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const once = async () => {
    lastFetch = Date.now();
    const res = await fetch(path, { credentials: 'include' });
    const html = await res.text();
    return { res, html, blocked: res.status === 403 || res.status === 429 || /<title>확인 중/.test(html) };
  };
  try {
    let x = await once();
    if (x.blocked) { say('접속 확인 화면 — 90초 쉬고 한 번만 다시 시도'); await sleep(90000); x = await once(); }
    if (x.blocked) return { blocked: true };
    return { html: x.html };
  } catch (e) { return { error: String(e.message || e) }; }
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

/** 토벌전 랭킹 페이지에서 (등수, 점수(억), 닉, 길드) 목록 */
function parseBossRanking(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...d.querySelectorAll('table.rank-table tbody tr')].map((tr) => {
    const tip = (tr.querySelector('.score-tooltip')?.textContent || tr.querySelector('.score-kor')?.textContent || '');
    return { rank: parseInt(tr.querySelector('.rank-total')?.textContent, 10), n: tr.querySelector('.nickname')?.textContent.trim(),
      g: tr.querySelector('.badge-guild')?.textContent.trim() || '', gb: korToEok(tip) };
  }).filter((r) => r.rank && r.gb != null);
  const last = Math.max(0, ...[...d.querySelectorAll('a[href*="page="]')].map((a) => parseInt((a.getAttribute('href').match(/page=(\d+)/) || [])[1], 10) || 0));
  return { rows, lastPage: last };
}
/** "14조 3285억 3700만" → 억 단위 숫자 */
function korToEok(s) {
  if (!s) return null;
  const u = { '경': 1e8, '조': 1e4, '억': 1, '만': 1e-4 };
  let v = 0, hit = false;
  for (const m of s.matchAll(/([\d,]+)\s*(경|조|억|만)/g)) { v += Number(m[1].replace(/,/g, '')) * u[m[2]]; hit = true; }
  return hit ? r2(v) : null;
}

const TMP_KEY = 'gvg-server-tmp';
/**
 * 4서버 토벌전 랭킹 커트라인 + 4서버 상위 길드 목록 수집 (랭킹 13장 + 길드 랭킹 1장).
 * opt.step 1·2·3으로 나눠 부르면 한 번에 5장 이하만 읽음(예약 작업용). step 없으면 한 번에 전부.
 */
export async function collectServer(opt = {}) {
  const say = opt.onProgress || (() => {});
  const server = opt.server || HOME_SERVER;
  const all = [...new Set(TB_BOUNDS.map((b) => Math.ceil(b / PER_PAGE)))];
  const chunks = [all.slice(0, 5), all.slice(5, 10), all.slice(10)];
  const pages = opt.step ? chunks[opt.step - 1] || [] : all;
  let tmp = { byRank: [], lastPage: 0 };
  if (opt.step && opt.step > 1) { try { tmp = JSON.parse(localStorage.getItem(TMP_KEY)) || tmp; } catch (e) {} }
  const byRank = new Map(tmp.byRank);
  let lastPage = tmp.lastPage || 0;
  for (let i = 0; i < pages.length; i++) {
    say(`4서버 토벌 랭킹 ${i + 1}/${pages.length}쪽`);
    const p = await getPage(`/ranking/guild_boss.php?server=${server}&page=${pages[i]}`, say);
    if (p.blocked) return { ok: false, why: 'blocked' };
    if (!p.html) return { ok: false, why: 'network' };
    const parsed = parseBossRanking(p.html);
    lastPage = Math.max(lastPage, parsed.lastPage);
    parsed.rows.forEach((r) => byRank.set(r.rank, r));
    if (!parsed.rows.length) break; // 랭킹이 그보다 짧음
  }
  if (opt.step && opt.step < chunks.length) {
    try { localStorage.setItem(TMP_KEY, JSON.stringify({ byRank: [...byRank], lastPage })); } catch (e) {}
    return { ok: true, step: opt.step, next: opt.step + 1, pages: pages.length };
  }
  try { localStorage.removeItem(TMP_KEY); } catch (e) {}
  const boundaries = TB_BOUNDS.map((rank) => { const r = byRank.get(rank); return r ? { rank, gb: r.gb, n: r.n, g: r.g } : null; }).filter(Boolean);
  const top = [...byRank.values()].filter((r) => r.rank <= 100).sort((a, b) => a.rank - b.rank).map((r) => [r.rank, r.n, r.g, r.gb]);
  say('4서버 길드 랭킹');
  const gp = await getPage(`/ranking/guild_ranking.php?server=${server}`, say);
  let guilds = [];
  if (gp.html) {
    const d = new DOMParser().parseFromString(gp.html, 'text/html');
    guilds = [...new Set([...d.querySelectorAll('a[href*="guild_info.php?g_name="]')].map((a) => decodeURIComponent(a.getAttribute('href').split('g_name=')[1] || '')))].filter(Boolean).slice(0, opt.top || SERVER_TOP);
  }
  const data = { server, boundaries, guilds, top, total_players: lastPage ? lastPage * PER_PAGE : null };
  if (!opt.dry) await rpc('gvg_ingest_server', { p_code: opt.code, p_data: data });
  return { ok: boundaries.length > 0, boundaries: boundaries.length, guilds: guilds.length, total_players: data.total_players, data: opt.dry ? data : undefined };
}

/** 길드 페이지들 수집 */
export async function collectGuilds(opt = {}) {
  const say = opt.onProgress || (() => {});
  const names = opt.names || [];
  const ok = [], failed = [], data = [];
  for (let i = 0; i < names.length; i++) {
    const g = names[i];
    say(`[${i + 1}/${names.length}] ${g}`);
    const p = await getPage('/contents/guild_info.php?g_name=' + encodeURIComponent(g), say);
    if (p.blocked) { failed.push({ g, why: 'blocked' }); names.slice(i + 1).forEach((x) => failed.push({ g: x, why: 'skipped' })); break; }
    if (!p.html) { failed.push({ g, why: 'network' }); continue; }
    const x = parseGuild(p.html);
    if (!x || x.guild !== g) { failed.push({ g, why: 'not_found' }); continue; }
    x.source = opt.source || 'manual';
    if (opt.dry) { data.push(x); ok.push(g); continue; }
    try { await rpc('gvg_ingest', { p_code: opt.code, p_data: x }); ok.push(g); }
    catch (e) { failed.push({ g, why: String(e.message || e).slice(0, 60) }); }
  }
  return { ok, failed, data: opt.dry ? data : undefined };
}

/** 수집할 길드 이름: 안전 + 대항전 라인업 + 4서버 상위 길드 (중복 제거) */
export async function plan() {
  const [s, sv] = await Promise.all([
    rest('gvg_settings?select=lineup&id=eq.1'),
    rest(`gvg_server?select=guilds&server=eq.${HOME_SERVER}&order=fetched_at.desc&limit=1`).catch(() => []),
  ]);
  const lineup = (s && s[0] && s[0].lineup) || [];
  const server = (sv && sv[0] && sv[0].guilds) || [];
  return [...new Set([HOME_GUILD, ...lineup, ...server].map((x) => String(x).trim()).filter(Boolean))];
}
export const targets = plan;

/** 북마크용: 전체 갱신 (4서버 랭킹 → 길드 전부). 약 3~4분 */
export async function collect(opt = {}) {
  if (!location.hostname.endsWith('mgf.gg')) throw new Error('mgf.gg 페이지에서 실행해야 합니다');
  if (!opt.dry && !(await rpc('gvg_check', { p_code: opt.code }))) throw new Error('INVALID_CODE');
  const failed = [];
  if (opt.server !== false) {
    const s = await collectServer(opt);
    if (!s.ok) failed.push({ g: '4서버 랭킹', why: s.why || 'empty' });
    if (s.why === 'blocked') { if (!opt.dry) await logRun({ ...opt, ok: 0, failed }); return { ok: [], failed }; }
  }
  const names = [...new Set([...(await plan()), ...(opt.extra || [])])];
  const g = await collectGuilds({ ...opt, names });
  failed.push(...g.failed);
  if (!opt.dry) { try { await logRun({ ...opt, ok: g.ok.length, failed }); } catch (e) {} }
  return { ok: g.ok, failed, at: new Date().toISOString() };
}

/** 예약 작업용: 지금 열려 있는 길드 페이지 1장을 그대로 저장 */
export async function ingestCurrentPage(opt = {}) {
  const want = new URLSearchParams(location.search).get('g_name');
  if (document.title.includes('확인 중')) return { guild: want, why: 'blocked' };
  const p = parseGuild(document.documentElement.outerHTML);
  if (!p || p.guild !== want) return { guild: want, why: 'not_found' };
  p.source = opt.source || 'schedule';
  if (opt.dry) return { guild: p.guild, ok: true, members: p.members.length };
  await rpc('gvg_ingest', { p_code: opt.code, p_data: p });
  return { guild: p.guild, ok: true, members: p.members.length, total_gb: p.total_gb };
}

/** 실행 기록 남기기 (대기 중인 갱신 요청도 완료 처리) */
export async function logRun(opt) {
  return rpc('gvg_log_run', { p_code: opt.code, p_source: opt.source || 'schedule', p_ok: opt.ok || 0, p_failed: opt.failed || [] });
}

/** 예약 작업용: 지금 수집할지 판단 (갱신 요청이 있거나, 마지막 수집이 20시간 넘게 지났을 때) */
export async function shouldRun() {
  const [req, runs] = await Promise.all([
    rest('gvg_requests?select=requested_at&status=eq.pending&order=requested_at.asc&limit=1').catch(() => []),
    rest('gvg_runs?select=finished_at,ok&ok=gt.0&order=finished_at.desc&limit=1').catch(() => []),
  ]);
  const pending = Array.isArray(req) && req[0] ? req[0].requested_at : null;
  const last = Array.isArray(runs) && runs[0] ? runs[0].finished_at : null;
  const hoursSince = last ? (Date.now() - new Date(last)) / 3600000 : Infinity;
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  if (pending) return { run: true, reason: 'request', pending, last };
  if (hoursSince >= 20 && kstHour >= 7) return { run: true, reason: 'daily', last };
  return { run: false, reason: 'up_to_date', last };
}
