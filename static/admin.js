/* ============================================================
   VoQuiz 소개 사이트 — 관리자 편집 모드
   ------------------------------------------------------------
   · 하단 "관리자" 링크 → 비밀번호 로그인 → 편집 툴바
   · 소식(뉴스) 추가 / 편집 / 삭제 / 순서 변경
   · 주요 문구 인라인 편집 (제목·소개글)
   · 변경사항은 이 브라우저(localStorage)에 저장되고,
     "내보내기"로 모든 방문자에게 반영할 index.html 파일을 받습니다.
   ------------------------------------------------------------
   ⚠️ 정적 사이트라 완벽한 보안은 아닙니다(편집 UI를 가리는 용도).
   ============================================================ */

// ▼▼▼ 관리자 비밀번호 — 원하는 값으로 바꾸세요 ▼▼▼
const ADMIN_PW = "voquiz2026";
// ▲▲▲                                       ▲▲▲

const LS_NEWS = "vs_news";      // 소식 배열(override)
const LS_TEXT = "vs_text";      // 문구 override {key: html}
const SS_AUTH = "vs_admin";     // 로그인 세션 플래그

/* ---------- 기본 소식(현재 사이트에 실린 카드들) ---------- */
const DEFAULT_NEWS = [
    { emoji: "🧭", label: "플래너", sublabel: "망각곡선 계획", visual: "v6", tag: "신규", hot: true,
      title: "AI 학습 플래너가 열렸습니다",
      body: "목표와 날짜만 정하면 AI가 매일 외울 단어와 복습 시점을 캘린더로 짜 줍니다. 망각곡선에 맞춘 분산 학습이니까요.",
      date: "2026.07.28" },
    { emoji: "🎮", label: "학습", sublabel: "8가지 모드", visual: "v7", tag: "신규", hot: true,
      title: "학습 모드가 8가지로",
      body: "가리고 외우기·받아쓰기·스피드 퀴즈·스펠링·예문 채우기까지. 단어를 여러 각도로 손에 익히세요.",
      date: "2026.07.22" },
    { emoji: "✍️", label: "예문", sublabel: "AI 첨삭", visual: "v1", tag: "업데이트", hot: false,
      title: "AI 예문 첨삭이 도착했습니다",
      body: "플래시카드를 뒤집고 예문을 쓰면, AI가 용법이 맞는지 짚어주고 자연스러운 문장으로 고쳐줍니다.",
      date: "2026.07.15" },
    { emoji: "🏫", label: "학원", sublabel: "반 개설", visual: "v2", tag: "업데이트", hot: false,
      title: "학원·교사 모드 오픈",
      body: "반을 만들고 참여 코드를 공유하세요. 시험지를 배정하면 학생별 성적이 대시보드에 자동으로 쌓입니다.",
      date: "2026.07.12" },
    { emoji: "🇨🇳", label: "中文", sublabel: "병음 지원", visual: "v3", tag: "언어", hot: false,
      title: "중국어 단어장을 지원합니다",
      body: "한자와 병음(pinyin)까지 추출해 단어 목록과 플래시카드에 함께 보여줍니다. 문제도 언어에 맞춰 출제됩니다.",
      date: "2026.07.08" },
    { emoji: "👪", label: "리포트", sublabel: "링크 공유", visual: "v4", tag: "업데이트", hot: false,
      title: "학부모 리포트 공유 링크",
      body: "읽기전용 링크 하나로 진도·점수 추이·취약 단어를 공유하세요. 로그인 없이 열립니다.",
      date: "2026.07.02" },
    { emoji: "🎴", label: "학습", sublabel: "카드 · 게임", visual: "v5", tag: "신규", hot: true,
      title: "플래시카드와 단어 맞추기 게임",
      body: "시험 말고도 외울 방법이 필요하니까요. 뒤집고, 짝 맞추고, 잊을 때쯤 다시 만납니다.",
      date: "2026.06.24" },
];

const VISUALS = ["v1", "v2", "v3", "v4", "v5", "v6", "v7"];
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------- 간단한 마크다운 → HTML ----------
   지원: 제목(#~######), 굵게, 기울임, 인라인 코드, 링크,
   글머리 목록, 번호 목록, 인용(>), 구분선(---),
   빈 줄 = 문단 구분, 단일 줄바꿈 = 줄바꿈(br). */
function mdSafeUrl(u) {
    return /^(https?:|mailto:|#|\/)/i.test(u.trim()) ? u.trim() : "#";
}
function mdInline(s) {
    s = esc(s);   // 먼저 HTML escape (마크다운 토큰 *, `, [ 는 그대로 남음)
    s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
    // 이미지 ![alt](url) — 링크보다 먼저 처리 (data:image / http / 상대경로 허용)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, u) =>
        /^(https?:\/\/|data:image\/|\/)/i.test(u.trim()) ? `<img src="${u.trim()}" alt="${alt}" loading="lazy">` : m);
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${mdSafeUrl(u)}" target="_blank" rel="noopener">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    return s;
}
const BLOCK_START = /^(#{1,6}\s|\s*>|\s*[-*+]\s|\s*\d+\.\s|\s*(---|\*\*\*|___)\s*$)/;
function mdToHtml(src) {
    // 원본 줄에서 블록을 판별하고(esc 전), 텍스트는 mdInline 에서 escape 한다.
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    const out = []; let i = 0;
    const blank = (l) => !l.trim();
    while (i < lines.length) {
        const l = lines[i];
        if (blank(l)) { i++; continue; }
        let h = l.match(/^(#{1,6})\s+(.*)$/);
        if (h) { const lvl = Math.min(6, h[1].length + 2); out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`); i++; continue; }
        if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
        if (/^\s*>\s?/.test(l)) { const b = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { b.push(mdInline(lines[i].replace(/^\s*>\s?/, ""))); i++; } out.push(`<blockquote>${b.join("<br>")}</blockquote>`); continue; }
        if (/^\s*[-*+]\s+/.test(l)) { const b = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { b.push(`<li>${mdInline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`); i++; } out.push(`<ul>${b.join("")}</ul>`); continue; }
        if (/^\s*\d+\.\s+/.test(l)) { const b = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { b.push(`<li>${mdInline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; } out.push(`<ol>${b.join("")}</ol>`); continue; }
        const b = [];
        while (i < lines.length && !blank(lines[i]) && !BLOCK_START.test(lines[i])) { b.push(mdInline(lines[i])); i++; }
        out.push(`<p>${b.join("<br>")}</p>`);
    }
    return out.join("\n");
}
function mdToPlain(src) {
    return (src || "").replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_#>`]/g, "")
        .replace(/^\s*[-+]\s+/gm, "").replace(/\s+/g, " ").trim();
}
function snippet(src, n = 100) { const p = mdToPlain(src); return p.length > n ? p.slice(0, n).trim() + "…" : p; }

// 업로드 이미지를 리사이즈·압축해 data URL 로 (localStorage/내보내기에 자체 포함되도록)
function fileToImage(file, maxW = 1280, quality = 0.82) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                let w = img.width, h = img.height;
                if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
                const c = document.createElement("canvas");
                c.width = w; c.height = h;
                c.getContext("2d").drawImage(img, 0, 0, w, h);
                resolve(c.toDataURL("image/jpeg", quality));
            };
            img.onerror = reject;
            img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
// data URL 배경에 안전하게 넣기 (작은따옴표만 이스케이프)
function cssUrl(u) { return u ? ` style="background-image:url('${String(u).replace(/'/g, "%27")}')"` : ""; }

/* ---------- 저장소 헬퍼 ---------- */
function embeddedNews() {
    // 내보낸 index.html 에 심어진 소식 데이터(방문자용 상세 팝업 소스)
    const el = document.getElementById("vs-news-data");
    if (el) { try { const v = JSON.parse(el.textContent); if (Array.isArray(v)) return v; } catch (e) {} }
    return null;
}
function getNews() {
    try { const v = JSON.parse(localStorage.getItem(LS_NEWS)); if (Array.isArray(v)) return v; } catch (e) {}
    return embeddedNews() || DEFAULT_NEWS.map(n => ({ ...n }));
}
function saveNews(arr) { localStorage.setItem(LS_NEWS, JSON.stringify(arr)); }
function hasNewsOverride() { return localStorage.getItem(LS_NEWS) != null; }
function getText() { try { return JSON.parse(localStorage.getItem(LS_TEXT)) || {}; } catch (e) { return {}; } }
function saveText(o) { localStorage.setItem(LS_TEXT, JSON.stringify(o)); }

/* ---------- 소식 렌더 ---------- */
function newsCardHTML(n, live) {
    const imgCls = n.image ? " has-img" : "";
    return `<article class="news-card reveal${live ? " in" : ""}">
    <div class="nc-visual ${esc(n.visual || "v1")}${imgCls}"${cssUrl(n.image)}>
        <div class="nc-mini">${esc(n.emoji || "📰")} <b>${esc(n.label)}</b><span>${esc(n.sublabel)}</span></div>
    </div>
    <div class="nc-body">
        <span class="nc-tag${n.hot ? " new" : ""}">${esc(n.tag || "소식")}</span>
        <h3>${esc(n.title)}</h3>
        <p>${esc(snippet(n.body))}</p>
        <time>${esc(n.date)}</time>
    </div>
</article>`;
}
function renderNews(live = true) {
    const rail = document.getElementById("news-rail");
    if (!rail) return;
    rail.innerHTML = getNews().map(n => newsCardHTML(n, live)).join("\n");
}

/* ---------- 문구 override 적용 ---------- */
const EDIT_SELECTOR = [
    ".beta-bar",
    ".eyebrow", ".hero-title", ".hero-sub",
    ".kicker", ".lines i", ".pin-title",
    ".steps h3", ".steps p",
    ".sec-sub", ".caption",
    ".fmt b", ".fmt span",
    ".qcard-q", ".qexp",
    ".lcard h3", ".lcard p", ".modes span",
    ".ai-label", ".ai-side h3", ".ai-side p", ".tag",
    ".pc-t", ".plan-goal b", ".plan-goal span", ".plan-note", ".off-note", ".plan-iv span",
    ".up h3", ".up p", ".cd-meta", ".cd-head b",
    ".rm-head",
    ".p-name", ".p-cost", ".price li",
    ".ad-t", ".ad b", ".ad span", ".ad-note",
    ".foot-inner p", ".foot-inner small span",
    // 버튼 문구
    ".nav-cta", ".nav-links a", ".btn-primary", ".btn-link", ".p-btn",
].join(", ");
// 요소 순서가 아니라 "내용+위치"로 안정적인 키를 만든다.
// (편집 대상 목록이 바뀌어도 저장된 값이 엉뚱한 요소에 붙지 않도록)
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function sectionKey(el) {
    const s = el.closest("section, header, footer, nav");
    return s ? (s.id || (s.className || "").trim().split(/\s+/)[0] || s.tagName.toLowerCase()) : "doc";
}
function editableEls() {
    const els = [...document.querySelectorAll(EDIT_SELECTOR)];
    const seen = {};
    els.forEach(el => {
        if (el.dataset.edit) return;
        const base = sectionKey(el) + "|" + el.tagName + "|" + hashStr((el.textContent || "").replace(/\s+/g, " ").trim());
        const n = (seen[base] = (seen[base] || 0) + 1);
        el.dataset.edit = "e" + hashStr(base) + (n > 1 ? "_" + n : "");
    });
    return els;
}
function applyTextOverrides() {
    const o = getText();
    editableEls().forEach(el => { const k = el.dataset.edit; if (o[k] != null) el.innerHTML = o[k]; });
}

/* ---------- 토스트 ---------- */
function adminToast(msg) {
    let t = document.getElementById("admin-toast");
    if (!t) { t = document.createElement("div"); t.id = "admin-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------- 로그인 ---------- */
function isAuthed() { return sessionStorage.getItem(SS_AUTH) === "1"; }

function openLogin() {
    if (isAuthed()) { enterAdmin(); return; }
    let m = document.getElementById("admin-login");
    if (!m) {
        m = document.createElement("div");
        m.id = "admin-login"; m.className = "admin-overlay";
        m.innerHTML = `<div class="admin-box">
            <h3>관리자 로그인</h3>
            <p class="ab-sub">소식 추가·문구 편집을 하려면 비밀번호를 입력하세요.</p>
            <input type="password" id="admin-pw" placeholder="비밀번호" autocomplete="off">
            <div class="ab-err" id="admin-err"></div>
            <div class="ab-row">
                <button class="ab-btn ghost" data-close>취소</button>
                <button class="ab-btn" id="admin-go">로그인</button>
            </div>
        </div>`;
        document.body.appendChild(m);
        m.addEventListener("click", e => { if (e.target === m || e.target.hasAttribute("data-close")) m.classList.remove("show"); });
        m.querySelector("#admin-go").addEventListener("click", tryLogin);
        m.querySelector("#admin-pw").addEventListener("keydown", e => { if (e.key === "Enter") tryLogin(); });
    }
    m.querySelector("#admin-err").textContent = "";
    m.querySelector("#admin-pw").value = "";
    m.classList.add("show");
    setTimeout(() => m.querySelector("#admin-pw").focus(), 60);
}
function tryLogin() {
    const pw = document.getElementById("admin-pw").value;
    if (pw === ADMIN_PW) {
        sessionStorage.setItem(SS_AUTH, "1");
        document.getElementById("admin-login").classList.remove("show");
        enterAdmin();
    } else {
        document.getElementById("admin-err").textContent = "비밀번호가 올바르지 않습니다.";
    }
}

/* ---------- 편집 툴바 ---------- */
let editMode = false;
function enterAdmin() {
    let bar = document.getElementById("admin-bar");
    if (!bar) {
        bar = document.createElement("div");
        bar.id = "admin-bar";
        bar.innerHTML = `<span class="abar-badge">관리자 모드</span>
            <button class="abar-btn" id="abar-news">📰 소식 관리</button>
            <button class="abar-btn" id="abar-text">✏️ 문구 편집</button>
            <button class="abar-btn export" id="abar-export">⬇ 내보내기</button>
            <button class="abar-btn ghost" id="abar-out">로그아웃</button>`;
        document.body.appendChild(bar);
        bar.querySelector("#abar-news").addEventListener("click", openNewsManager);
        bar.querySelector("#abar-text").addEventListener("click", toggleTextEdit);
        bar.querySelector("#abar-export").addEventListener("click", exportSite);
        bar.querySelector("#abar-out").addEventListener("click", logoutAdmin);
    }
    bar.classList.add("show");
    document.body.classList.add("admin-on");
    adminToast("관리자 모드입니다.");
}
function logoutAdmin() {
    sessionStorage.removeItem(SS_AUTH);
    if (editMode) toggleTextEdit();
    document.getElementById("admin-bar")?.classList.remove("show");
    document.body.classList.remove("admin-on");
    adminToast("로그아웃되었습니다.");
}

/* ---------- 문구 인라인 편집 ---------- */
function toggleTextEdit() {
    editMode = !editMode;
    const btn = document.getElementById("abar-text");
    const els = editableEls();
    els.forEach(el => {
        el.contentEditable = editMode ? "true" : "false";
        el.classList.toggle("editing", editMode);
        if (editMode && !el._bound) {
            el._bound = true;
            el.addEventListener("blur", () => {
                const o = getText(); o[el.dataset.edit] = el.innerHTML.trim(); saveText(o);
            });
        }
    });
    if (btn) { btn.classList.toggle("active", editMode); btn.textContent = editMode ? "✅ 편집 끝내기" : "✏️ 문구 편집"; }
    adminToast(editMode ? "문구를 클릭해 바로 수정하세요. 다 되면 '편집 끝내기'." : "문구 편집을 저장했습니다.");
    if (editMode) els[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------- 소식 관리 모달 ---------- */
function openNewsManager() {
    let m = document.getElementById("news-mgr");
    if (!m) {
        m = document.createElement("div");
        m.id = "news-mgr"; m.className = "admin-overlay";
        m.innerHTML = `<div class="admin-box wide">
            <div class="nm-head"><h3>소식 관리</h3><button class="ab-btn ghost sm" data-close>닫기</button></div>
            <div class="nm-list" id="nm-list"></div>
            <div class="nm-foot">
                <button class="ab-btn" id="nm-add">＋ 새 소식</button>
                <div class="nm-foot-r">
                    <button class="ab-btn ghost sm" id="nm-reset">기본값 복원</button>
                </div>
            </div>
        </div>`;
        document.body.appendChild(m);
        m.addEventListener("click", e => { if (e.target === m || e.target.hasAttribute("data-close")) m.classList.remove("show"); });
        m.querySelector("#nm-add").addEventListener("click", () => openNewsEditor(-1));
        m.querySelector("#nm-reset").addEventListener("click", () => {
            if (confirm("소식을 기본값으로 되돌릴까요? 추가·수정한 내용이 사라집니다.")) {
                localStorage.removeItem(LS_NEWS); renderNews(); renderNmList(); adminToast("기본값으로 복원했습니다.");
            }
        });
    }
    renderNmList();
    m.classList.add("show");
}
function renderNmList() {
    const list = document.getElementById("nm-list");
    const arr = getNews();
    list.innerHTML = arr.map((n, i) => `<div class="nm-item">
        <span class="nm-emoji">${esc(n.emoji || "📰")}</span>
        <div class="nm-info"><b>${esc(n.title)}</b><span>${esc(n.date)} · ${esc(n.tag)}</span></div>
        <div class="nm-acts">
            <button data-up="${i}" title="위로" ${i === 0 ? "disabled" : ""}>↑</button>
            <button data-down="${i}" title="아래로" ${i === arr.length - 1 ? "disabled" : ""}>↓</button>
            <button data-edit="${i}" title="편집">편집</button>
            <button data-del="${i}" title="삭제" class="danger">삭제</button>
        </div>
    </div>`).join("");
    list.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => openNewsEditor(+b.dataset.edit));
    list.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
        const i = +b.dataset.del; const a = getNews();
        if (confirm(`"${a[i].title}" 소식을 삭제할까요?`)) { a.splice(i, 1); saveNews(a); renderNews(); renderNmList(); }
    });
    list.querySelectorAll("[data-up]").forEach(b => b.onclick = () => moveNews(+b.dataset.up, -1));
    list.querySelectorAll("[data-down]").forEach(b => b.onclick = () => moveNews(+b.dataset.down, 1));
}
function moveNews(i, dir) {
    const a = getNews(); const j = i + dir;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]]; saveNews(a); renderNews(); renderNmList();
}

/* ---------- 소식 편집 폼 ---------- */
function openNewsEditor(idx) {
    const editing = idx >= 0;
    const n = editing ? getNews()[idx] : { emoji: "✨", label: "", sublabel: "", visual: "v6", tag: "신규", hot: true, title: "", body: "", date: new Date().toISOString().slice(0, 10).replace(/-/g, ".") };
    let m = document.getElementById("news-editor");
    if (!m) {
        m = document.createElement("div"); m.id = "news-editor"; m.className = "admin-overlay high";
        document.body.appendChild(m);
    }
    m.innerHTML = `<div class="admin-box xl">
        <div class="nm-head"><h3>${editing ? "소식 편집" : "새 소식"}</h3><button class="ab-btn ghost sm" data-close>닫기</button></div>
        <div class="ne-grid">
            <label>제목<input id="ne-title" value="${esc(n.title)}" placeholder="예: 새 기능이 나왔어요"></label>
            <label>내용 <span class="ne-hint">마크다운 지원 &nbsp;·&nbsp; **굵게** &nbsp; *기울임* &nbsp; # 제목 &nbsp; - 목록 &nbsp; &gt; 인용 &nbsp; [링크](url)</span>
                <textarea id="ne-body" rows="9" class="ne-md" placeholder="소식 내용을 적어주세요 (마크다운 사용 가능)">${esc(n.body)}</textarea>
            </label>
            <div class="ne-prev-wrap"><span class="ne-prev-label">미리보기</span><div class="md-body ne-preview" id="ne-preview"></div></div>
            <div class="ne-row3">
                <label>이모지<input id="ne-emoji" value="${esc(n.emoji)}" maxlength="4"></label>
                <label>라벨<input id="ne-label" value="${esc(n.label)}" placeholder="플래너"></label>
                <label>보조 라벨<input id="ne-sub" value="${esc(n.sublabel)}" placeholder="망각곡선 계획"></label>
            </div>
            <div class="ne-row3">
                <label>태그<input id="ne-tag" value="${esc(n.tag)}" placeholder="신규 / 업데이트"></label>
                <label>날짜<input id="ne-date" value="${esc(n.date)}" placeholder="2026.07.28"></label>
                <label class="ne-check"><input type="checkbox" id="ne-hot" ${n.hot ? "checked" : ""}> 파란 '신규' 강조</label>
            </div>
            <label>카드 색상 <span class="ne-hint">이미지가 없을 때 배경으로 사용</span>
                <div class="ne-colors" id="ne-colors">
                    ${VISUALS.map(v => `<button type="button" class="ne-color ${v}${v === n.visual ? " on" : ""}" data-v="${v}"></button>`).join("")}
                </div>
            </label>
            <label>이미지 <span class="ne-hint">카드 썸네일 · 상세 배너에 표시 (선택)</span>
                <div class="ne-img">
                    <div class="ne-img-prev${n.image ? " has" : ""}" id="ne-img-prev"${cssUrl(n.image)}>${n.image ? "" : "이미지 없음"}</div>
                    <div class="ne-img-btns">
                        <button type="button" class="ab-btn ghost sm" id="ne-img-pick">이미지 선택</button>
                        <button type="button" class="ab-btn ghost sm" id="ne-img-clear">제거</button>
                    </div>
                    <input type="file" id="ne-img-file" accept="image/*" hidden>
                </div>
            </label>
        </div>
        <div class="ab-row">
            <button class="ab-btn ghost" data-close>취소</button>
            <button class="ab-btn" id="ne-save">저장</button>
        </div>
    </div>`;
    let visual = n.visual;
    m.querySelectorAll(".ne-color").forEach(b => b.onclick = () => {
        visual = b.dataset.v; m.querySelectorAll(".ne-color").forEach(x => x.classList.toggle("on", x === b));
    });
    // 라이브 마크다운 미리보기
    const bodyEl = m.querySelector("#ne-body"), prevEl = m.querySelector("#ne-preview");
    const updPrev = () => { prevEl.innerHTML = bodyEl.value.trim() ? mdToHtml(bodyEl.value) : '<span class="ne-prev-empty">내용을 입력하면 여기에 미리보기가 나타납니다.</span>'; };
    bodyEl.addEventListener("input", updPrev); updPrev();
    // 이미지 업로드
    let imageData = n.image || "";
    const imgPrev = m.querySelector("#ne-img-prev"), imgFile = m.querySelector("#ne-img-file");
    const setImg = (d) => {
        imageData = d || "";
        imgPrev.setAttribute("style", d ? `background-image:url('${d.replace(/'/g, "%27")}')` : "");
        imgPrev.classList.toggle("has", !!d);
        imgPrev.textContent = d ? "" : "이미지 없음";
    };
    m.querySelector("#ne-img-pick").onclick = () => imgFile.click();
    m.querySelector("#ne-img-clear").onclick = () => setImg("");
    imgFile.onchange = async () => {
        const f = imgFile.files && imgFile.files[0]; if (!f) return;
        try {
            const d = await fileToImage(f);
            setImg(d);
            if (d.length > 1200000) adminToast("이미지가 조금 큽니다. 더 작은 파일을 권장해요.");
        } catch (e) { adminToast("이미지를 불러오지 못했습니다."); }
        imgFile.value = "";
    };
    m.querySelectorAll("[data-close]").forEach(b => b.onclick = () => m.classList.remove("show"));
    m.addEventListener("click", e => { if (e.target === m) m.classList.remove("show"); });
    m.querySelector("#ne-save").onclick = () => {
        const item = {
            emoji: m.querySelector("#ne-emoji").value.trim() || "📰",
            label: m.querySelector("#ne-label").value.trim(),
            sublabel: m.querySelector("#ne-sub").value.trim(),
            visual, tag: m.querySelector("#ne-tag").value.trim() || "소식",
            hot: m.querySelector("#ne-hot").checked,
            title: m.querySelector("#ne-title").value.trim(),
            body: m.querySelector("#ne-body").value.trim(),
            date: m.querySelector("#ne-date").value.trim(),
            image: imageData,
        };
        if (!item.title) { adminToast("제목을 입력하세요."); return; }
        const a = getNews();
        if (editing) a[idx] = item; else a.unshift(item);
        saveNews(a); renderNews(); renderNmList();
        m.classList.remove("show");
        adminToast(editing ? "소식을 수정했습니다." : "새 소식을 추가했습니다.");
    };
    m.classList.add("show");
    setTimeout(() => m.querySelector("#ne-title").focus(), 60);
}

/* ---------- 소식 상세 팝업(방문자용) ---------- */
function openNewsDetail(idx) {
    const n = getNews()[idx];
    if (!n) return;
    let m = document.getElementById("news-detail");
    if (!m) {
        m = document.createElement("div"); m.id = "news-detail"; m.className = "admin-overlay";
        document.body.appendChild(m);
        m.addEventListener("click", e => { if (e.target === m || e.target.closest("[data-close]")) m.classList.remove("show"); });
        document.addEventListener("keydown", e => { if (e.key === "Escape") m.classList.remove("show"); });
    }
    m.innerHTML = `<div class="nd-box">
        <button class="nd-close" data-close aria-label="닫기">×</button>
        <div class="nd-hero ${esc(n.visual || "v1")}${n.image ? " has-img" : ""}"${cssUrl(n.image)}>
            <span class="nd-emoji-bg">${esc(n.emoji || "📰")}</span>
            <div class="nd-hero-txt">
                <b class="nd-hero-label">${esc(n.label)}</b>
                <span class="nd-hero-sub">${esc(n.sublabel)}</span>
            </div>
        </div>
        <div class="nd-content">
            <div class="nd-meta"><span class="nc-tag${n.hot ? " new" : ""}">${esc(n.tag || "소식")}</span><time class="nd-date">${esc(n.date)}</time></div>
            <h2 class="nd-title">${esc(n.title)}</h2>
            <div class="md-body">${mdToHtml(n.body)}</div>
        </div>
    </div>`;
    m.classList.add("show");
    m.scrollTop = 0;
}

/* ---------- 내보내기: 반영된 index.html 파일 다운로드 ---------- */
function exportSite() {
    // 최신 상태를 DOM에 반영
    applyTextOverrides();
    renderNews(true);

    const clone = document.documentElement.cloneNode(true);
    // 관리자 런타임 UI 제거
    clone.querySelectorAll("#admin-bar, #admin-login, #news-mgr, #news-editor, #news-detail, #admin-toast").forEach(n => n.remove());
    // 편집 상태 정리
    clone.querySelectorAll("[contenteditable]").forEach(n => n.removeAttribute("contenteditable"));
    clone.querySelectorAll(".editing").forEach(n => n.classList.remove("editing"));
    // 소식 카드: 강제 표시 클래스 제거(공개 사이트에서 등장 애니메이션 정상 동작)
    clone.querySelectorAll("#news-rail .news-card").forEach(n => n.classList.remove("in"));
    const body = clone.querySelector("body"); if (body) body.classList.remove("admin-on");

    // 소식 데이터를 파일에 심어, 방문자가 카드를 눌렀을 때 상세 팝업이 정확히 열리게 함
    clone.querySelectorAll("#vs-news-data").forEach(n => n.remove());
    const dataEl = document.createElement("script");
    dataEl.id = "vs-news-data"; dataEl.type = "application/json";
    dataEl.textContent = JSON.stringify(getNews()).replace(/</g, "\\u003c");
    const adminScript = clone.querySelector('script[src^="admin.js"]');
    if (adminScript) adminScript.parentNode.insertBefore(dataEl, adminScript);
    else if (body) body.appendChild(dataEl);

    const html = "<!DOCTYPE html>\n" + clone.outerHTML;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "index.html"; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
    adminToast("index.html을 내려받았습니다. 이 파일로 교체하면 모두에게 반영됩니다.");
}

/* ---------- 초기화 ---------- */
(function init() {
    // 구버전(순서 기반 t0,t1…) 문구 키 정리 — 요소가 밀려 엉뚱한 곳에 적용되던 문제 제거
    (function migrateText() {
        const o = getText(); let changed = false;
        for (const k in o) if (/^t\d+$/.test(k)) { delete o[k]; changed = true; }
        if (changed) saveText(o);
    })();

    // 저장된 소식/문구가 있으면 반영(공개 방문자는 override 없으면 기본 그대로)
    if (hasNewsOverride()) renderNews(true);
    applyTextOverrides();

    const trig = document.getElementById("admin-trigger");
    if (trig) trig.addEventListener("click", e => { e.preventDefault(); openLogin(); });

    // 소식 카드 클릭 → 상세 팝업(방문자 모두). 재렌더에도 살아남도록 위임.
    const rail = document.getElementById("news-rail");
    if (rail) rail.addEventListener("click", e => {
        const card = e.target.closest(".news-card");
        if (!card) return;
        const idx = [...rail.querySelectorAll(".news-card")].indexOf(card);
        if (idx >= 0) openNewsDetail(idx);
    });

    // 새로고침해도 세션 유지 시 툴바 복귀
    if (isAuthed()) enterAdmin();
})();
