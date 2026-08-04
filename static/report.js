/* ============================================================
   report.js — 학부모용 읽기전용 리포트 페이지 (로그인 불필요)
   공유 링크: /report.html?t=<token>
   ============================================================ */

// ---- 테마 (앱과 동일한 localStorage 키 공유) ----
function initTheme() {
    const saved = localStorage.getItem("theme");
    const theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    applyTheme(theme);
}
function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelectorAll(".theme-toggle-btn").forEach(b => b.textContent = theme === "dark" ? "☀️" : "🌙");
}
function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    applyTheme(next);
}

// ---- 유틸 ----
function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtDate(iso) {
    try {
        const d = new Date(iso), p = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (e) { return iso; }
}

function renderTrendChart(trend) {
    if (!trend || !trend.length)
        return `<div class="trend-empty">아직 응시 기록이 없어요.</div>`;
    const W = 500, H = 180, padL = 34, padR = 12, padT = 14, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB, n = trend.length;
    const xAt = i => padL + (n === 1 ? iw / 2 : iw * i / (n - 1));
    const yAt = v => padT + ih * (1 - v / 100);
    let grid = "";
    [0, 50, 100].forEach(v => {
        const y = yAt(v);
        grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="tc-grid"/>`;
        grid += `<text x="${padL - 6}" y="${y + 3}" class="tc-axis" text-anchor="end">${v}</text>`;
    });
    const pts = trend.map((t, i) => [xAt(i), yAt(t.score)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const area = `M${pts[0][0].toFixed(1)} ${yAt(0)} ` +
        pts.map(p => "L" + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ") +
        ` L${pts[n - 1][0].toFixed(1)} ${yAt(0)} Z`;
    const dots = pts.map((p, i) =>
        `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" class="tc-dot"/>` +
        `<text x="${p[0].toFixed(1)}" y="${(p[1] - 8).toFixed(1)}" class="tc-val" text-anchor="middle">${trend[i].score}</text>`
    ).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="점수 추이">
        <defs><linearGradient id="tcArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
        </linearGradient></defs>
        ${grid}<path d="${area}" fill="url(#tcArea)"/><path d="${line}" class="tc-line"/>${dots}</svg>`;
}

function renderMastery(dist) {
    const total = dist.mastered + dist.learning + dist.weak;
    if (total === 0) return `<div class="mastery-empty">아직 학습한 단어가 없어요.</div>`;
    const pct = n => (n / total * 100).toFixed(1);
    const seg = (n, cls) => n ? `<div class="mastery-seg ${cls}" style="width:${pct(n)}%">${n}</div>` : "";
    return `<div class="mastery-bar">
        ${seg(dist.mastered, "mseg-mastered")}${seg(dist.learning, "mseg-learning")}${seg(dist.weak, "mseg-weak")}
    </div>
    <div class="mastery-legend">
        <span><i class="dot-m" style="background:var(--green)"></i> 정복 ${dist.mastered}</span>
        <span><i class="dot-m" style="background:var(--primary)"></i> 학습중 ${dist.learning}</span>
        <span><i class="dot-m" style="background:var(--red)"></i> 취약 ${dist.weak}</span>
    </div>`;
}

function render(d) {
    const kpi = (num, label, accent) =>
        `<div class="kpi ${accent ? "accent" : ""}"><div class="kpi-num">${num}</div><div class="kpi-label">${label}</div></div>`;

    const recent = d.recent.length ? d.recent.map(r => {
        const cls = r.score >= 80 ? "hi" : (r.score >= 50 ? "mid" : "lo");
        return `<div class="recent-item">
            <div style="min-width:0"><div class="ri-name">${esc(r.exam_name)}</div>
            <div class="ri-date">${fmtDate(r.created_at)} · ${r.correct}/${r.total}</div></div>
            <span class="ri-score ${cls}">${r.score}%</span></div>`;
    }).join("") : `<div class="recent-empty">최근 응시한 시험이 없어요.</div>`;

    const weak = d.weak_words.length ? d.weak_words.slice(0, 12).map(w => {
        const cls = w.accuracy < 50 ? "lo" : "mid";
        return `<div class="weak-item"><div style="min-width:0">
            <div class="weak-word">${esc(w.word)}</div><div class="weak-mean">${esc(w.meaning || "")}</div></div>
            <span class="weak-acc ${cls}">${w.accuracy}% · ✗${w.wrong}</span></div>`;
    }).join("") : `<div class="mastery-empty">취약 단어가 없어요 👍</div>`;

    document.getElementById("report-body").innerHTML = `
        <div class="report-title-card">
            <h1>📊 ${esc(d.nickname)}님의 학습 리포트</h1>
            <p class="muted">생성일 ${fmtDate(d.generated_at)}</p>
        </div>
        <div class="kpi-row">
            ${kpi(d.totals.wordbooks, "📚 단어장")}
            ${kpi(d.totals.words, "🔤 총 단어")}
            ${kpi(d.totals.exams, "📝 시험지")}
            ${kpi(d.totals.attempts, "✍️ 응시 횟수")}
            ${kpi(d.avg_score + '<span class="unit">%</span>', "평균 점수", true)}
            ${kpi(d.best_score + '<span class="unit">%</span>', "최고 점수", true)}
        </div>
        <div class="stats-lower">
            <div class="chart-card"><h3>📈 점수 추이</h3><div class="trend-chart">${renderTrendChart(d.trend)}</div></div>
            <div class="recent-card"><h3>🕑 최근 응시</h3><div class="recent-list">${recent}</div></div>
        </div>
        <div class="stats-lower" style="margin-top:16px">
            <div class="chart-card"><h3>🧠 단어 숙련도</h3><div class="mastery-box">${renderMastery(d.mastery)}</div></div>
            <div class="recent-card"><h3>⚠️ 취약 단어</h3><div class="weak-list">${weak}</div></div>
        </div>`;
}

async function load() {
    initTheme();
    const token = new URLSearchParams(location.search).get("t");
    if (!token) {
        document.getElementById("report-body").innerHTML =
            `<div class="report-loading">잘못된 링크입니다.</div>`;
        return;
    }
    try {
        const res = await fetch(`/api/public/report/${encodeURIComponent(token)}`);
        if (!res.ok) throw new Error();
        render(await res.json());
    } catch (e) {
        document.getElementById("report-body").innerHTML =
            `<div class="report-loading">리포트를 찾을 수 없습니다.<br>링크가 만료되었거나 취소되었을 수 있어요.</div>`;
    }
}

document.addEventListener("DOMContentLoaded", load);
