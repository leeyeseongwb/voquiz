/* ============================================================
   VocaShot 프론트엔드 로직 (vanilla JS)
   - 같은 서버에서 정적 파일이 서빙되므로 API 는 상대경로 사용.
   - 세션은 httponly 쿠키로 유지 → fetch 에 credentials: 'include'.
   ============================================================ */

// ---------- 전역 상태 ----------
let CURRENT_USER = null;
let uploadState = { filename: "", pages: 0, words: [] };      // 업로드/추출 임시 데이터
let genState = { questions: [], format: "toefl" };            // 시험지 생성 임시 데이터
let currentWordbook = null;                                   // 열려있는 단어장 상세
let takeState = { exam: null, answers: {}, timer: null, elapsed: 0, limit: 0 };
let reportState = { examId: null, attemptId: null };

// ============================================================
// API 헬퍼
// ============================================================
async function api(path, { method = "GET", body = null, isForm = false } = {}) {
    const opts = { method, credentials: "include", headers: {} };
    if (body && isForm) {
        opts.body = body;                          // FormData
    } else if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.detail || "요청 실패");
    return data;
}

// ============================================================
// 뷰 전환
// ============================================================
function showView(id) {
    ["view-dashboard", "view-upload", "view-wordbook", "view-exam-create", "view-planner", "view-take", "view-report",
     "view-review", "view-flashcards", "view-game", "view-cover", "view-dictation", "view-speed",
     "view-class-teacher", "view-class-student"]
        .forEach(v => document.getElementById(v).classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
    // 게임 화면을 벗어나면 타이머 정지
    if (id !== "view-game" && typeof gameState !== "undefined" && gameState.timer) {
        clearInterval(gameState.timer);
    }
    window.scrollTo(0, 0);
}

function goDashboard() {
    navTo("dashboard");
}

// 사이드바 내비게이션: dashboard(개요) | wordbooks | exams | calendar | classes
function navTo(section) {
    stopTimer();
    document.querySelectorAll(".side-link[data-nav]").forEach(l =>
        l.classList.toggle("active", l.dataset.nav === section));
    showView("view-dashboard");
    const isDash = section === "dashboard";
    document.querySelector(".dash-stats").classList.toggle("hidden", !isDash);
    ["wordbooks", "exams", "calendar", "classes"].forEach(t =>
        document.getElementById("tab-" + t).classList.toggle("hidden", isDash || t !== section));
    if (isDash) loadStats();
    else switchTab(section);
    window.scrollTo(0, 0);
}

// 프로필 클릭 → 로그아웃 메뉴 토글
function toggleProfileMenu(e) {
    if (e) e.stopPropagation();
    document.getElementById("profile-menu").classList.toggle("hidden");
}

// ============================================================
// 인증
// ============================================================
function showAuthPane(name) {
    ["login", "signup", "verify", "take"].forEach(p =>
        document.getElementById(`pane-${p}`).classList.toggle("hidden", p !== name));
    hideAuthError();
}

// 공유 링크(?take=코드)로 접속한 학생 응시 게이트 준비
let _takeCode = null;
async function initTakeGate() {
    const code = new URLSearchParams(location.search).get("take");
    if (!code) return false;
    _takeCode = code.toUpperCase();
    try {
        const info = await api(`/api/public/class/${_takeCode}`);
        document.getElementById("take-class-name").textContent = `${info.class_name} 과제`;
    } catch (e) { document.getElementById("take-class-name").textContent = "과제"; }
    document.getElementById("view-auth").classList.remove("hidden");
    showAuthPane("take");
    return true;
}

// 학생: 이름 + 학생 ID로 응시 시작 (로그인 불필요)
async function doTakeEnter() {
    const name = document.getElementById("take-name").value.trim();
    const sid = document.getElementById("take-sid").value.trim();
    if (!name) return showAuthError("이름을 입력하세요.");
    if (!sid) return showAuthError("선생님이 준 학생 ID를 입력하세요.");
    try {
        const r = await api("/api/public/class/enter", { method: "POST", body: { code: _takeCode, sid, name } });
        await enterApp();
        openStudentClass(r.class_id);   // 배정된 과제로 바로 이동
    } catch (e) { showAuthError(e.message); }
}

function onSignupTierChange() {
    const tier = document.querySelector('input[name="signupTier"]:checked')?.value;
    document.getElementById("teacher-note").classList.toggle("hidden", tier !== "teacher");
}

function showAuthError(msg) {
    const el = document.getElementById("auth-error");
    el.textContent = msg; el.classList.remove("hidden");
}
function hideAuthError() { document.getElementById("auth-error").classList.add("hidden"); }

async function doSignup() {
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    if (!email || !password) return showAuthError("이메일과 비밀번호를 입력하세요.");
    if (!checkPwRules()) return showAuthError("비밀번호 요구사항을 모두 충족해야 합니다. (6~15자, 영문+숫자+특수문자)");
    const tier = document.querySelector('input[name="signupTier"]:checked')?.value || "basic";
    try {
        const r = await api("/api/signup", { method: "POST", body: { email, password, tier } });
        document.getElementById("verify-target").textContent = email;
        window._pendingEmail = email;
        showAuthPane("verify");
        showDevCode(r.dev_code);
    } catch (e) { showAuthError(e.message); }
}

async function resendCode() {
    const email = window._pendingEmail;
    const password = document.getElementById("signup-password").value || "x";
    try {
        const r = await api("/api/resend-code", { method: "POST", body: { email, password } });
        showDevCode(r.dev_code);
    } catch (e) { showAuthError(e.message); }
}

function showDevCode(code) {
    const box = document.getElementById("dev-code-box");
    if (code) {
        box.innerHTML = `🧪 개발 모드 인증 코드: <b>${code}</b> (실제 서비스에선 이메일로 발송)`;
        box.classList.remove("hidden");
    } else box.classList.add("hidden");
}

async function doVerify() {
    const email = window._pendingEmail;
    const code = document.getElementById("verify-code").value.trim();
    if (!code) return showAuthError("인증 코드를 입력하세요.");
    try {
        await api("/api/verify", { method: "POST", body: { email, code } });
        await enterApp();
    } catch (e) { showAuthError(e.message); }
}

async function doLogin() {
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    if (!email || !password) return showAuthError("이메일과 비밀번호를 입력하세요.");
    try {
        await api("/api/login", { method: "POST", body: { email, password } });
        await enterApp();
    } catch (e) {
        // 미인증 계정이면 인증 화면으로 유도
        if (e.message.includes("인증")) {
            window._pendingEmail = email;
            document.getElementById("verify-target").textContent = email;
            try {
                const r = await api("/api/resend-code", { method: "POST", body: { email, password } });
                showDevCode(r.dev_code);
            } catch (_) {}
            showAuthPane("verify");
        }
        showAuthError(e.message);
    }
}

async function doLogout() {
    await api("/api/logout", { method: "POST" });
    CURRENT_USER = null;
    if (_notifTimer) { clearInterval(_notifTimer); _notifTimer = null; }
    document.getElementById("view-app").classList.add("hidden");
    document.getElementById("view-auth").classList.remove("hidden");
}

async function enterApp() {
    const me = await api("/api/me");
    CURRENT_USER = me;
    renderUserChip();
    applyRoleNav();
    document.getElementById("view-auth").classList.add("hidden");
    document.getElementById("view-app").classList.remove("hidden");
    goDashboard();
    // 알림 로드 + 주기적 폴링(30초)
    loadNotifications();
    if (_notifTimer) clearInterval(_notifTimer);
    _notifTimer = setInterval(loadNotifications, 30000);
}

// 상단바 프로필 칩 렌더링 (닉네임 / 아바타 / 등급)
function renderUserChip() {
    const u = CURRENT_USER;
    document.getElementById("topbar-nick").textContent = u.nickname || u.email;
    const av = document.getElementById("topbar-avatar");
    av.innerHTML = u.avatar ? `<img src="${u.avatar}" alt="">` : "🙂";
    const badge = document.getElementById("topbar-tier");
    const labels = { basic: "기본", premium: "프리미엄", teacher: "선생님 Basic", teacher_pro: "선생님 Pro" };
    badge.textContent = labels[u.tier] || "기본";
    badge.className = "tier-badge " + (u.tier || "basic");
    renderSideMeta();
}

// 역할별 내비게이션: 선생님은 플래너·반 메뉴를 숨기고 반은 대시보드에 통합
function applyRoleNav() {
    const isTeacher = !!CURRENT_USER?.limits?.can_create_class;
    document.querySelectorAll('.side-link[data-nav="calendar"], .side-link[data-nav="classes"]')
        .forEach(l => l.classList.toggle("hidden", isTeacher));
}

// 페이지 로드 시 세션 확인
async function init() {
    // 공유 링크(?take=코드)로 접속하면 로그인 대신 학생 응시 게이트 표시
    if (await initTakeGate()) return;
    try { await enterApp(); }
    catch (e) {
        document.getElementById("view-auth").classList.remove("hidden");
        showAuthPane("login");
    }
}

// ============================================================
// 대시보드
// 시나리오별 인사말 (시간대 / 오랜만 / 무작위 응원)
function pickGreeting() {
    const name = esc(CURRENT_USER.nickname || CURRENT_USER.email);
    const b = s => `${s.replace("{name}", `<b>${name}</b>`)}`;
    const now = Date.now();
    const last = parseInt(localStorage.getItem("lastVisit") || "0");
    localStorage.setItem("lastVisit", String(now));
    const days = last ? (now - last) / 86400000 : 0;
    const hour = new Date().getHours();

    // 선생님용 인사말 (반·학생 관리 맥락)
    if (CURRENT_USER?.limits?.can_create_class) {
        let tg;
        if (hour < 11) tg = ["좋은 아침이에요, {name} 선생님 ☀️ 오늘도 학생들과 함께!",
            "{name} 선생님, 상쾌한 아침이에요 📚 오늘 수업도 힘내세요!"];
        else if (hour < 18) tg = ["{name} 선생님, 오늘도 수고 많으세요 🍎",
            "우리 반 학생들이 기다려요, {name} 선생님 👩‍🏫"];
        else tg = ["오늘 하루도 고생하셨어요, {name} 선생님 🌆",
            "{name} 선생님, 학생들 성적을 확인해볼까요? 📊"];
        return b(pick(tg));
    }

    if (last && days >= 3) {
        return b(pick(["오랜만이에요, {name}님! 다시 만나 반가워요 🙌",
            "{name}님, 그동안 잘 지냈나요? 다시 시작해봐요 💪",
            "돌아오신 걸 환영해요, {name}님 🎉 오늘부터 다시 차근차근!"]));
    }
    if (last && days >= 1) {
        return b(pick(["다시 오셨네요, {name}님 👋 오늘도 화이팅!",
            "{name}님, 꾸준함이 실력이에요. 오늘도 시작해볼까요? ✨"]));
    }
    let timeGreet;
    if (hour < 6) timeGreet = ["늦은 밤이네요, {name}님 🌙 무리하지 말아요", "밤에도 열공, {name}님 대단해요 🌜"];
    else if (hour < 11) timeGreet = ["좋은 아침이에요, {name}님 ☀️", "상쾌한 아침, {name}님 오늘도 파이팅! 🌤"];
    else if (hour < 14) timeGreet = ["점심 잘 챙기셨나요, {name}님? 🍚", "활기찬 오후예요, {name}님 💫"];
    else if (hour < 18) timeGreet = ["나른한 오후, {name}님 잠깐 단어 어때요? ☕", "오후도 알차게, {name}님 👍"];
    else if (hour < 22) timeGreet = ["좋은 저녁이에요, {name}님 🌆", "하루 마무리 학습, {name}님 멋져요 🌟"];
    else timeGreet = ["편안한 밤이에요, {name}님 🌙", "잠들기 전 복습 한 번, {name}님? 😴"];
    return b(pick(timeGreet));
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ============================================================
async function loadStats() {
    // 인사말 (시간대·방문 간격 등 시나리오별)
    document.getElementById("dash-greeting").innerHTML = pickGreeting();
    const isTeacher = !!CURRENT_USER?.limits?.can_create_class;
    document.getElementById("dash-personal").classList.toggle("hidden", isTeacher);
    document.getElementById("dash-teacher").classList.toggle("hidden", !isTeacher);
    // 선생님은 개인용 위젯(오늘 할 일·공유)을 숨기고 학생 관리 대시보드만 표시
    document.querySelector(".share-card")?.classList.toggle("hidden", isTeacher);
    document.querySelector(".dash-stats .today-card")?.classList.toggle("hidden", isTeacher);

    if (isTeacher) { loadTeacherDash(); return; }

    try {
        const s = await api("/api/stats");
        document.getElementById("kpi-wordbooks").textContent = s.totals.wordbooks;
        document.getElementById("kpi-words").textContent = s.totals.words;
        document.getElementById("kpi-exams").textContent = s.totals.exams;
        document.getElementById("kpi-attempts").textContent = s.totals.attempts;
        document.getElementById("kpi-avg").innerHTML = `${s.avg_score}<span class="unit">%</span>`;
        document.getElementById("kpi-best").innerHTML = `${s.best_score}<span class="unit">%</span>`;
        renderExamScores(s.exam_scores || []);
        renderRecent(s.recent);
        renderMastery(s.mastery);
    } catch (e) {}
    loadToday();       // 통계 위 '오늘 할 일'
    loadAnalysis();    // 학습중/취약 단어 목록
    loadShare();       // 공유 카드 상태
}

// 선생님 대시보드: 최근 학생 활동(위) → 내 반 → 학생 성적표
async function loadTeacherDash() {
    const box = document.getElementById("dash-teacher");
    box.innerHTML = `<div class="muted" style="padding:14px">불러오는 중…</div>`;
    try {
        const t = await api("/api/teacher/overview");
        const scoreCls = s => s >= 80 ? "hi" : (s >= 50 ? "mid" : "lo");
        // 1) 최근 학생 활동 (가로 스크롤 카드)
        const recent = t.recent.length ? t.recent.map(r => `
            <div class="activity-card">
                <div class="ac-top"><span class="ac-name">${esc(r.nickname || r.email)}</span>
                    <span class="ri-score ${scoreCls(r.score)}">${r.score}%</span></div>
                <div class="ac-exam">${esc(r.exam_name)}</div>
                <div class="ac-meta">${esc(r.class_name || "")} · ${fmtDate(r.created_at)}</div>
            </div>`).join("") : `<div class="recent-empty">아직 학생 응시 기록이 없어요.</div>`;
        // 2) 내 반 (가로 카드)
        const classCards = t.classes.length ? t.classes.map(c => `
            <div class="class-tile" onclick="openTeacherClass(${c.id})">
                <div class="ct-title">${esc(c.name)} <span class="stu-arrow">›</span></div>
                <div class="ic-meta">
                    <span class="badge">학생 ${c.student_count}명</span>
                    <span class="badge gray">과제 ${c.assignment_count}개</span>
                    ${c.avg_score != null ? `<span class="badge green">평균 ${c.avg_score}%</span>` : ""}
                </div>
            </div>`).join("") : `<div class="empty-state">아직 만든 반이 없어요.<br>“＋ 반 만들기”로 시작하세요.</div>`;
        // 3) 학생 성적 — 반별 탭
        _teacherData = t;
        _gradeTab = t.classes.length ? (t.classes.some(c => c.id === _gradeTab) ? _gradeTab : t.classes[0].id) : null;
        const gradeTabs = t.classes.map(c =>
            `<button class="grade-tab ${c.id === _gradeTab ? "active" : ""}" data-cid="${c.id}" onclick="selectGradeTab(${c.id})">${esc(c.name)}</button>`).join("");
        const maxClasses = CURRENT_USER?.limits?.max_classes || 5;
        const atCap = t.totals.classes >= maxClasses;
        box.innerHTML = `
            <div class="card">
                <div class="chart-head"><h3>📣 최근 학생 활동</h3></div>
                <div class="activity-row">${recent}</div>
            </div>
            <div class="card" style="margin-top:16px">
                <div class="chart-head"><h3>🏫 내 반 <span class="hint-text">(반 ${t.totals.classes} / ${maxClasses} · 클릭하면 학생·과제 관리)</span></h3>
                    <button class="btn-accent btn-sm" onclick="createClass()" ${atCap ? "disabled title='반 최대 개수에 도달했어요'" : ""}>＋ 반 만들기</button></div>
                <div class="class-row">${classCards}</div>
            </div>
            <div class="card" style="margin-top:16px">
                <div class="chart-head"><h3>📊 학생 성적 <span class="hint-text">(학생을 클릭하면 상세)</span></h3>
                    <button class="btn-mini" onclick="downloadStudentsXlsx()" ${(t.students || []).length ? "" : "disabled"}>⬇ 엑셀(xlsx) 다운로드</button></div>
                <div class="grade-tabs">${gradeTabs}</div>
                <div class="dash-table-wrap" id="grade-table"></div>
            </div>`;
        renderGradeTable();
    } catch (e) { box.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

let _teacherData = null, _gradeTab = null;
function selectGradeTab(cid) {
    _gradeTab = cid;
    document.querySelectorAll(".grade-tabs .grade-tab").forEach(b =>
        b.classList.toggle("active", Number(b.dataset.cid) === cid));
    renderGradeTable();
}
// 선택된 반의 학생 성적 표 (반 컬럼 없음)
function renderGradeTable() {
    const el = document.getElementById("grade-table");
    if (!el || !_teacherData) return;
    const scoreCls = s => s >= 80 ? "hi" : (s >= 50 ? "mid" : "lo");
    const rows = (_teacherData.students || []).filter(s => s.class_id === _gradeTab);
    const body = rows.length ? rows.map(s => `
        <tr onclick="openStudentDetail(${s.class_id}, ${s.student_id})" style="cursor:pointer">
            <td class="stu-name stu-link">${esc(s.name)} <span class="stu-arrow">›</span></td>
            <td><span class="rc-id">${esc(s.sid || "-")}</span></td>
            <td>${s.recent_exam ? esc(s.recent_exam) : `<span class="cell-none">기록 없음</span>`}</td>
            <td>${s.recent_score != null ? `<span class="cell-score ${scoreCls(s.recent_score)}">${s.recent_score}%</span>` : `<span class="cell-none">–</span>`}</td>
            <td>${s.avg != null ? `<span class="cell-score ${scoreCls(s.avg)}">${s.avg}%</span>` : `<span class="cell-none">–</span>`}</td>
        </tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">이 반에는 아직 학생이 없어요.</div></td></tr>`;
    el.innerHTML = `<table class="dash-table stud-table">
        <thead><tr><th>학생</th><th>학생 ID</th><th>최근 시험</th><th>최근 점수</th><th>평균</th></tr></thead>
        <tbody>${body}</tbody></table>`;
}

// 학생 통계 xlsx 다운로드
async function downloadStudentsXlsx() {
    try { await downloadPdf("/api/teacher/students.xlsx", "VocaShot_학생통계.xlsx", null, "GET"); }
    catch (e) { toastErr(e.message); }
}

// 시험지별 성적 (막대) — 점수 추이 대체 위젯
function renderExamScores(list) {
    const box = document.getElementById("exam-scores");
    if (!box) return;
    if (!list.length) {
        box.innerHTML = `<div class="trend-empty">아직 응시한 시험지가 없어요.<br>시험을 풀면 시험지별 성적이 표시됩니다.</div>`;
        return;
    }
    box.innerHTML = list.map(e => {
        const cls = e.best >= 80 ? "hi" : (e.best >= 50 ? "mid" : "lo");
        return `<div class="es-row" onclick="openExam(${e.exam_id})">
            <div class="es-top"><span class="es-name">${esc(e.name)}</span>
                <span class="es-best ${cls}">${e.best}%</span></div>
            <div class="es-track"><div class="es-bar ${cls}" style="width:${e.best}%"></div></div>
            <div class="es-sub">평균 ${e.avg}% · ${e.attempts}회 응시</div>
        </div>`;
    }).join("");
}

function renderMastery(dist) {
    const box = document.getElementById("mastery-box");
    if (!dist) { box.innerHTML = ""; return; }
    const total = dist.mastered + dist.learning + dist.weak;
    if (total === 0) {
        box.innerHTML = `<div class="mastery-empty">아직 학습한 단어가 없어요.<br>시험을 보면 숙련도가 쌓입니다.</div>`;
        return;
    }
    const pct = n => (n / total * 100).toFixed(1);
    const seg = (n, cls) => n ? `<div class="mastery-seg ${cls}" style="width:${pct(n)}%">${n}</div>` : "";
    box.innerHTML = `
        <div class="mastery-bar">
            ${seg(dist.mastered, "mseg-mastered")}
            ${seg(dist.learning, "mseg-learning")}
            ${seg(dist.weak, "mseg-weak")}
        </div>
        <div class="mastery-legend">
            <span><i class="dot-m" style="background:var(--green)"></i> 정복 ${dist.mastered}</span>
            <span><i class="dot-m" style="background:var(--primary)"></i> 학습중 ${dist.learning}</span>
            <span><i class="dot-m" style="background:var(--red)"></i> 취약 ${dist.weak}</span>
        </div>`;
}

let _weakAll = [];
async function loadAnalysis() {
    try {
        const a = await api("/api/analysis");
        _weakAll = a.weak_words || [];
        document.getElementById("weak-more-btn").classList.toggle("hidden", _weakAll.length <= 6);
        // 취약 단어 (카드에는 상위 일부만)
        const box = document.getElementById("weak-list");
        box.innerHTML = a.weak_words.length ? a.weak_words.slice(0, 8).map(w => {
            const cls = w.accuracy < 50 ? "lo" : "mid";
            return `<div class="weak-item">
                <div style="min-width:0">
                    <div class="weak-word">${esc(w.word)}</div>
                    <div class="weak-mean">${esc(w.meaning || "")}</div>
                </div>
                <span class="weak-acc ${cls}">${w.accuracy}% · 오답 ${w.wrong}</span>
            </div>`;
        }).join("") : `<div class="mastery-empty">취약 단어가 없어요 👍</div>`;

        // 학습 중인 단어 (숙련도 카드 하단 미니 리스트)
        const lbox = document.getElementById("learning-list");
        if (lbox) lbox.innerHTML = (a.learning_words && a.learning_words.length)
            ? a.learning_words.map(w => `
                <div class="mini-word-item">
                    <span class="mw-word">${esc(w.word)}</span>
                    <span class="mw-mean">${esc(w.meaning || "")}</span>
                    <span class="mw-streak" title="연속 정답">${"●".repeat(Math.min(w.streak, 2))}${"○".repeat(Math.max(0, 2 - w.streak))}</span>
                </div>`).join("")
            : `<div class="mastery-empty" style="padding:14px 0">학습 중인 단어가 아직 없어요.</div>`;
    } catch (e) {}
}

// 취약 단어 전체 보기 (더보기 → 팝업)
function openWeakModal() {
    const list = document.getElementById("weak-modal-list");
    list.innerHTML = _weakAll.length ? _weakAll.map(w => {
        const cls = w.accuracy < 50 ? "lo" : "mid";
        return `<div class="weak-item">
            <div style="min-width:0"><div class="weak-word">${esc(w.word)}</div>
                <div class="weak-mean">${esc(w.meaning || "")}</div></div>
            <span class="weak-acc ${cls}">${w.accuracy}% · 오답 ${w.wrong}</span>
        </div>`;
    }).join("") : `<div class="mastery-empty">취약 단어가 없어요 👍</div>`;
    document.getElementById("weak-modal").classList.remove("hidden");
}
function closeWeakModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("weak-modal").classList.add("hidden");
}

// ============================================================
// 학습 기능 — 플래시카드 & 단어 맞추기 게임
// ============================================================
function backToWordbook() {
    if (fcState.returnTo === "planner") { fcState.returnTo = null; navTo("calendar"); return; }
    if (currentWordbook) openWordbook(currentWordbook.id);
    else goDashboard();
}

// 학습용 단어 (뜻 있는 것만) — 학습 설정 모달 범위. 커스텀 풀(취약단어 등) 지원.
function learnWords() {
    const custom = studyState.pool && studyState.pool.length;
    const all = (custom ? studyState.pool : (currentWordbook?.words || [])).filter(w => w.word && w.meaning);
    const s = parseInt(document.getElementById("study-start")?.value) || 1;
    const e = parseInt(document.getElementById("study-end")?.value) || all.length;
    return custom ? all.slice(s - 1, e) : all.filter(w => w.seq >= s && w.seq <= e);
}

// ---- 학습 설정 모달 ----
let studyState = { method: "flashcard", game: "match" };

// 크레딧을 소모하는(프리미엄) 모드
const PREMIUM_MODES = new Set(["cover", "dictation", "speed", "spelling", "match_def", "sentence_fill"]);

function openStudySetup(pool) {
    const custom = Array.isArray(pool) && pool.length;
    if (!custom && !currentWordbook) return;
    studyState = { method: "flashcard", game: "match", pool: custom ? pool : null };
    const words = custom ? pool : currentWordbook.words;
    document.getElementById("study-start").value = 1;
    document.getElementById("study-end").value = words.length;
    document.querySelectorAll("#study-modal .method-card[data-method]").forEach((c, i) => c.classList.toggle("selected", i === 0));
    document.querySelectorAll("#study-modal .method-card[data-game]").forEach((c, i) => c.classList.toggle("selected", i === 0));
    document.getElementById("study-game-types").classList.add("hidden");
    // 영영풀이/예문 없으면 해당 게임 유형 숨김
    const hasDef = words.some(w => w.definition && w.definition.trim());
    const hasEx = words.some(w => w.example && w.example.trim());
    document.getElementById("gt-def").classList.toggle("hidden", !hasDef);
    document.getElementById("gt-sentence").classList.toggle("hidden", !hasEx);
    // 프리미엄 모드에 크레딧 배지 표시
    document.querySelectorAll("#study-modal .method-card").forEach(c => {
        const mode = c.dataset.method || c.dataset.game;
        c.querySelector(".pm-badge")?.remove();
        if (PREMIUM_MODES.has(mode)) c.insertAdjacentHTML("beforeend", `<span class="pm-badge">1크레딧</span>`);
    });
    updateStudyCount();
    document.getElementById("study-modal").classList.remove("hidden");
}

// 프리미엄 학습 모드 시작 전 크레딧 차감 (기본 모드는 통과)
async function chargeStudy(mode) {
    try {
        await api("/api/study/charge", { method: "POST", body: { mode } });
        return true;
    } catch (e) {
        toastErr(e.message);
        if (e.message.includes("크레딧")) openProfile();
        return false;
    }
}
function closeStudySetup(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("study-modal").classList.add("hidden");
}
function updateStudyCount() {
    document.getElementById("study-count").textContent = learnWords().length;
}
function studySelectAll() {
    const total = (studyState.pool && studyState.pool.length) ? studyState.pool.length : (currentWordbook?.words.length || 0);
    document.getElementById("study-start").value = 1;
    document.getElementById("study-end").value = total;
    updateStudyCount();
}

// 취약 단어만 학습/복습 (단어 학습과 동일한 기능)
function startWeakStudy() {
    if (!_weakAll || !_weakAll.length) return toastErr("취약 단어가 없어요 👍");
    openStudySetup(_weakAll.map(w => ({ word: w.word, meaning: w.meaning, wordbook_id: w.wordbook_id })));
}
function selectMethod(el) {
    el.parentElement.querySelectorAll(".method-card").forEach(c => c.classList.remove("selected"));
    el.classList.add("selected");
    studyState.method = el.dataset.method;
    document.getElementById("study-game-types").classList.toggle("hidden", studyState.method !== "game");
}
function selectGameType(el) {
    el.parentElement.querySelectorAll(".method-card").forEach(c => c.classList.remove("selected"));
    el.classList.add("selected");
    studyState.game = el.dataset.game;
}
async function startStudy() {
    const words = learnWords();
    if (!words.length) return toastErr("학습할 단어가 없어요.");
    const m = studyState.method;
    const mode = m === "game" ? studyState.game : m;
    // 프리미엄 모드면 크레딧 차감 (실패 시 중단)
    if (PREMIUM_MODES.has(mode) && !(await chargeStudy(mode))) return;
    closeStudySetup();
    if (m === "flashcard") startFlashcardsWith(words);
    else if (m === "cover") startCover(words);
    else if (m === "dictation") startDictation(words);
    else if (m === "game") startGame(studyState.game, words);
}

// ---- 플래시카드 ----
let fcState = { cards: [], idx: 0, flipped: false, returnTo: null };

function startFlashcards() {
    startFlashcardsWith(learnWords());
}

// 임의의 단어 목록으로 플래시카드 시작 (플래너/캘린더에서도 재사용)
function startFlashcardsWith(cards, returnTo) {
    if (!cards || cards.length < 1) return toastErr("학습할 단어가 없어요.");
    fcState = { cards: [...cards], idx: 0, flipped: false, returnTo: returnTo || null };
    renderFlashcard();
    showView("view-flashcards");
}

function renderFlashcard() {
    const c = fcState.cards[fcState.idx];
    document.getElementById("fc-word").textContent = c.word;
    document.getElementById("fc-mean").textContent = c.meaning;
    document.getElementById("fc-ex").textContent = c.reading ? `${c.reading}  ·  ${c.example || ""}` : (c.example || "");
    document.getElementById("fc-progress").textContent = `${fcState.idx + 1} / ${fcState.cards.length}`;
    fcState.flipped = false;
    document.getElementById("fc-inner").classList.remove("flipped");
    // 예문 연습 영역 초기화
    document.getElementById("fc-practice").classList.add("hidden");
    document.getElementById("fc-sentence").value = "";
    const fb = document.getElementById("fc-feedback");
    fb.classList.add("hidden"); fb.innerHTML = "";
}
function flipCard() {
    fcState.flipped = !fcState.flipped;
    document.getElementById("fc-inner").classList.toggle("flipped", fcState.flipped);
    // 카드를 뒤집으면 예문 쓰기 영역 표시
    document.getElementById("fc-practice").classList.toggle("hidden", !fcState.flipped);
    if (fcState.flipped) {
        // AI 첨삭은 크레딧 기반 — 모든 등급에서 사용 가능(크레딧 소진 시 서버가 안내)
        document.getElementById("fc-practice-actions").classList.remove("hidden");
        document.getElementById("fc-locked").classList.add("hidden");
    }
}

async function checkSentence() {
    const sentence = document.getElementById("fc-sentence").value.trim();
    if (!sentence) return toast("예문을 입력해주세요.", "error");
    const c = fcState.cards[fcState.idx];
    const btn = document.querySelector("#fc-practice-actions button");
    const old = btn.textContent; btn.textContent = "🤖 첨삭 중..."; btn.disabled = true;
    try {
        const r = await api("/api/learn/check-sentence", { method: "POST", body: {
            word: c.word, meaning: c.meaning, sentence, language: currentWordbook?.language || "en" } });
        const fb = document.getElementById("fc-feedback");
        fb.className = "fc-feedback " + (r.correct ? "ok" : "no");
        fb.innerHTML = `<div class="fb-verdict">${r.correct ? "✅ 잘 썼어요!" : "✏️ 이렇게 다듬어봐요"}</div>
            <div class="fb-text">${esc(r.feedback)}</div>
            ${r.correction ? `<div class="fb-correction">👉 ${esc(r.correction)}</div>` : ""}`;
        fb.classList.remove("hidden");
    } catch (e) {
        toast(e.message, "error");
        if (e.message.includes("크레딧") || e.message.includes("프리미엄")) openProfile();
    } finally { btn.textContent = old; btn.disabled = false; }
}
function fcMove(dir) {
    const n = fcState.cards.length;
    fcState.idx = (fcState.idx + dir + n) % n;
    renderFlashcard();
}
function fcShuffle() {
    fcState.cards = shuffle([...fcState.cards]);
    fcState.idx = 0;
    renderFlashcard();
}

// ---- 단어 게임 (짝맞추기 / 스피드 / 스펠링) ----
let gameState = { tiles: [], first: null, matched: 0, total: 0, seconds: 0, timer: null, lock: false, pool: [], type: "match" };

// 게임 진입점: type(match/match_def/speed/spelling), words(선택된 단어)
function startGame(type = "match", words = null) {
    const pool = (words || learnWords());
    gameState.type = type;
    gameState.pool = pool;
    if (type === "speed") return startSpeedQuiz(pool);
    if (type === "spelling") return startSpelling(pool);
    if (type === "sentence_fill") return startSentenceFill(pool);
    // 짝 맞추기 (match / match_def)
    const def = type === "match_def";
    let p = def ? pool.filter(w => w.definition && w.definition.trim()) : pool;
    if (p.length < 3) {
        return toastErr(def ? "영영풀이가 있는 단어가 3개 이상 필요해요." : "게임을 하려면 단어가 3개 이상 필요해요.");
    }
    const picked = shuffle([...p]).slice(0, Math.min(8, p.length));
    const tiles = [];
    picked.forEach((w, i) => {
        tiles.push({ pair: i, kind: "word", text: w.word, matched: false });
        tiles.push({ pair: i, kind: "mean", text: def ? w.definition : w.meaning, matched: false });
    });
    gameState = { ...gameState, tiles: shuffle(tiles), first: null, matched: 0, total: picked.length,
                  seconds: 0, timer: null, lock: false };
    document.getElementById("game-title").textContent = "🔗 짝 맞추기";
    document.getElementById("game-sub").textContent = def ? "단어와 영영풀이를 짝지어 보세요" : "단어와 뜻을 짝지어 보세요";
    document.getElementById("game-done").classList.add("hidden");
    renderGame();
    updateGameStats();
    clearInterval(gameState.timer);
    gameState.timer = setInterval(() => { gameState.seconds++; updateGameStats(); }, 1000);
    showView("view-game");
}
// "다시 하기" — 같은 유형으로 재시작
function restartGame() { startGame(gameState.type, gameState.pool); }

function renderGame() {
    const board = document.getElementById("game-board");
    board.classList.remove("hidden");
    board.innerHTML = gameState.tiles.map((t, i) =>
        `<button class="game-tile ${t.kind}" data-i="${i}" onclick="pickTile(${i})">${esc(t.text)}</button>`
    ).join("");
}

function pickTile(i) {
    if (gameState.lock) return;
    const t = gameState.tiles[i];
    if (t.matched) return;
    const el = document.querySelector(`.game-tile[data-i="${i}"]`);
    if (gameState.first === i) { // 같은 타일 재클릭 → 선택 해제
        el.classList.remove("sel"); gameState.first = null; return;
    }
    el.classList.add("sel");
    if (gameState.first === null) { gameState.first = i; return; }

    // 두 번째 선택 → 매칭 판정
    const a = gameState.tiles[gameState.first], b = t;
    const elA = document.querySelector(`.game-tile[data-i="${gameState.first}"]`);
    if (a.pair === b.pair && a.kind !== b.kind) {
        a.matched = b.matched = true;
        gameState.first = null;
        gameState.matched++;
        updateGameStats();
        // 먼저 초록색으로 표시(correct) → 잠깐 뒤 사라짐(matched)
        elA.classList.remove("sel"); el.classList.remove("sel");
        elA.classList.add("correct"); el.classList.add("correct");
        setTimeout(() => {
            elA.classList.add("matched"); el.classList.add("matched");
        }, 450);
        if (gameState.matched === gameState.total) setTimeout(finishGame, 500);
    } else {
        gameState.lock = true;
        elA.classList.add("wrong"); el.classList.add("wrong");
        setTimeout(() => {
            elA.classList.remove("sel", "wrong"); el.classList.remove("sel", "wrong");
            gameState.first = null; gameState.lock = false;
        }, 700);
    }
}

function updateGameStats() {
    document.getElementById("game-time").textContent = `${gameState.seconds}s`;
    document.getElementById("game-pairs").textContent = `${gameState.matched}/${gameState.total}`;
}

function finishGame() {
    clearInterval(gameState.timer);
    // 비어버린 보드를 숨기고 결과만 깔끔하게 표시
    document.getElementById("game-board").classList.add("hidden");
    document.getElementById("game-result").textContent =
        `완료! 🎉 ${gameState.total}쌍을 ${gameState.seconds}초에 맞혔어요`;
    document.getElementById("game-done").classList.remove("hidden");
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ============================================================
// 가리고 외우기 (능동 회상 · Roediger & Karpicke 2006 testing effect)
// ============================================================
let coverState = { words: [], hide: "meaning" };

function startCover(words) {
    coverState = { words, hide: "meaning" };
    renderCover();
    showView("view-cover");
}
function renderCover() {
    const box = document.getElementById("cover-list");
    box.innerHTML = coverState.words.map((w, i) => `
        <div class="cover-row" id="cover-${i}">
            <span class="cover-num">${w.seq}</span>
            <span class="cover-word ${coverState.hide === "word" ? "hidden-cell" : ""}" onclick="coverReveal(${i}, 'word')">${esc(w.word)}</span>
            <span class="cover-mean ${coverState.hide === "meaning" ? "hidden-cell" : ""}" onclick="coverReveal(${i}, 'mean')">${esc(w.meaning || "")}</span>
        </div>`).join("");
    document.getElementById("cover-hide-btn").textContent = coverState.hide === "meaning" ? "단어 가리기" : "뜻 가리기";
}
function coverToggle(what) {
    coverState.hide = what === "word" ? "word" : "meaning";
    renderCover();
}
function coverRevealAll() {
    document.querySelectorAll("#cover-list .hidden-cell").forEach(el => el.classList.remove("hidden-cell"));
}
function coverReveal(i, which) {
    const row = document.getElementById(`cover-${i}`);
    const cell = row.querySelector(which === "word" ? ".cover-word" : ".cover-mean");
    cell.classList.toggle("hidden-cell");
}

// ============================================================
// 받아쓰기 (생성 연습 · production practice) — SRS 반영
// ============================================================
let dictState = { words: [], idx: 0, correct: 0, revealed: false };

function startDictation(words) {
    dictState = { words: shuffle([...words]), idx: 0, correct: 0, revealed: false };
    document.getElementById("dict-done").classList.add("hidden");
    document.querySelector("#view-dictation .fc-controls").classList.remove("hidden");
    document.getElementById("dict-input").parentElement && renderDictation();
    showView("view-dictation");
}
function renderDictation() {
    const w = dictState.words[dictState.idx];
    document.getElementById("dict-progress").textContent = `${dictState.idx + 1} / ${dictState.words.length}`;
    document.getElementById("dict-meaning").textContent = w.meaning || w.definition || "";
    document.getElementById("dict-hint").textContent = w.word ? `힌트: ${w.word.length}글자 · ${w.word[0]}…` : "";
    const inp = document.getElementById("dict-input");
    inp.value = ""; inp.disabled = false; inp.focus();
    const fb = document.getElementById("dict-feedback");
    fb.classList.add("hidden"); fb.innerHTML = "";
    dictState.revealed = false;
    if (dictState.spelling) _renderSpellingHint();
}
function dictSubmit() {
    const w = dictState.words[dictState.idx];
    const ans = document.getElementById("dict-input").value.trim();
    if (!ans) return;
    const ok = ans.toLowerCase() === (w.word || "").toLowerCase();
    if (ok) dictState.correct++;
    const fb = document.getElementById("dict-feedback");
    fb.className = "dict-feedback " + (ok ? "ok" : "no");
    fb.innerHTML = ok ? "✅ 정답!" : `❌ 정답: <b>${esc(w.word)}</b>`;
    fb.classList.remove("hidden");
    // SRS 숙련도 반영
    const wbId = w.wordbook_id || currentWordbook?.id;
    if (wbId) api("/api/review/grade", { method: "POST", body: { items: [
        { wordbook_id: wbId, word: w.word, meaning: w.meaning, correct: ok }] } }).catch(() => {});
    document.getElementById("dict-input").disabled = true;
    setTimeout(dictNext, 900);
}
function dictReveal() {
    const w = dictState.words[dictState.idx];
    const fb = document.getElementById("dict-feedback");
    fb.className = "dict-feedback no";
    fb.innerHTML = `정답: <b>${esc(w.word)}</b>`;
    fb.classList.remove("hidden");
}
function dictNext() {
    if (dictState.idx >= dictState.words.length - 1) {
        document.querySelector("#view-dictation .fc-controls").classList.add("hidden");
        document.getElementById("dict-result").textContent =
            `완료! 🎉 ${dictState.words.length}개 중 ${dictState.correct}개 정답`;
        document.getElementById("dict-done").classList.remove("hidden");
        return;
    }
    dictState.idx++;
    renderDictation();
}

// ============================================================
// 스피드 퀴즈 (4지선다 · 재인 속도)
// ============================================================
let speedState = { qs: [], idx: 0, correct: 0, seconds: 0, timer: null };

function startSpeedQuiz(words) {
    if (words.length < 4) return toastErr("스피드 퀴즈는 단어가 4개 이상 필요해요.");
    const pool = shuffle([...words]);
    const qs = pool.slice(0, Math.min(15, pool.length)).map(w => {
        const distractors = shuffle(words.filter(x => x.word !== w.word)).slice(0, 3).map(x => x.meaning);
        return { word: w.word, answer: w.meaning, meaning: w.meaning, wordbook_id: w.wordbook_id, options: shuffle([w.meaning, ...distractors]) };
    });
    speedState = { qs, idx: 0, correct: 0, seconds: 0, timer: null };
    document.getElementById("speed-done").classList.add("hidden");
    document.getElementById("speed-options").classList.remove("hidden");
    renderSpeed();
    clearInterval(speedState.timer);
    speedState.timer = setInterval(() => { speedState.seconds++; document.getElementById("speed-time").textContent = speedState.seconds; }, 1000);
    showView("view-speed");
}
function renderSpeed() {
    const q = speedState.qs[speedState.idx];
    document.getElementById("speed-progress").textContent = `${speedState.idx + 1} / ${speedState.qs.length}`;
    const qEl = document.getElementById("speed-q");
    qEl.textContent = q.prompt || q.word;
    qEl.classList.toggle("speed-sentence", !!q.prompt);
    document.getElementById("speed-options").innerHTML = q.options.map(o =>
        `<button class="speed-opt" onclick="speedPick(this, ${jsAttr(o)})">${esc(o)}</button>`).join("");
}

// 예문 채우기 게임 — 예문의 빈칸에 알맞은 단어 고르기
function startSentenceFill(words) {
    const withEx = words.filter(w => w.example && w.example.trim() && w.word);
    if (withEx.length < 4) return toastErr("예문이 있는 단어가 4개 이상 필요해요.");
    const pool = shuffle([...withEx]);
    const qs = pool.slice(0, Math.min(15, pool.length)).map(w => {
        // 예문에서 단어를 빈칸으로 (대소문자 무시)
        const re = new RegExp(w.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
        const blanked = w.example.replace(re, "______");
        const distractors = shuffle(words.filter(x => x.word !== w.word)).slice(0, 3).map(x => x.word);
        return { prompt: blanked, word: w.word, answer: w.word, meaning: w.meaning, wordbook_id: w.wordbook_id,
                 options: shuffle([w.word, ...distractors]) };
    });
    speedState = { qs, idx: 0, correct: 0, seconds: 0, timer: null };
    document.getElementById("speed-done").classList.add("hidden");
    document.getElementById("speed-options").classList.remove("hidden");
    renderSpeed();
    clearInterval(speedState.timer);
    speedState.timer = setInterval(() => { speedState.seconds++; document.getElementById("speed-time").textContent = speedState.seconds; }, 1000);
    showView("view-speed");
}
function speedPick(btn, choice) {
    const q = speedState.qs[speedState.idx];
    const ok = choice === q.answer;
    if (ok) speedState.correct++;
    document.querySelectorAll("#speed-options .speed-opt").forEach(b => {
        b.disabled = true;
        if (b.textContent === q.answer) b.classList.add("correct");
        else if (b === btn) b.classList.add("wrong");
    });
    const wbId = q.wordbook_id || currentWordbook?.id;
    if (wbId) api("/api/review/grade", { method: "POST", body: { items: [
        { wordbook_id: wbId, word: q.word, meaning: q.meaning, correct: ok }] } }).catch(() => {});
    setTimeout(() => {
        if (speedState.idx >= speedState.qs.length - 1) {
            clearInterval(speedState.timer);
            document.getElementById("speed-options").classList.add("hidden");
            document.getElementById("speed-result").textContent =
                `완료! 🎉 ${speedState.qs.length}문제 중 ${speedState.correct}개 정답 · ${speedState.seconds}초`;
            document.getElementById("speed-done").classList.remove("hidden");
        } else { speedState.idx++; renderSpeed(); }
    }, 700);
}

// ============================================================
// 스펠링 (빈칸 채우기) — 받아쓰기 뷰 재사용, 힌트로 일부 글자 노출
// ============================================================
function startSpelling(words) {
    // 받아쓰기와 동일 뷰 사용하되, 힌트에 빈칸 스펠링 표시
    dictState = { words: shuffle([...words]), idx: 0, correct: 0, revealed: false, spelling: true };
    document.getElementById("dict-done").classList.add("hidden");
    document.querySelector("#view-dictation .fc-controls").classList.remove("hidden");
    renderDictation();
    // 힌트를 스펠링 빈칸으로 교체
    _renderSpellingHint();
    showView("view-dictation");
}
function _renderSpellingHint() {
    if (!dictState.spelling) return;
    const w = dictState.words[dictState.idx];
    const word = w.word || "";
    // 첫 글자와 마지막 글자만 노출, 나머지는 _
    const masked = word.split("").map((ch, i) => (i === 0 || i === word.length - 1 || ch === " ") ? ch : "_").join(" ");
    document.getElementById("dict-hint").textContent = `빈칸을 채우세요: ${masked}`;
}

// ============================================================
// SRS 복습 세션
// ============================================================
let reviewState = { questions: [], answers: {} };

async function startReview() {
    try {
        const r = await api("/api/review/due?count=15");
        if (!r.questions.length) { toastErr("복습할 단어가 없어요!"); return; }
        reviewState = { questions: r.questions, answers: {} };
        document.getElementById("review-result").classList.add("hidden");
        document.getElementById("review-questions").parentElement.classList.remove("hidden");
        document.getElementById("review-progress").textContent = `0 / ${r.questions.length}`;
        renderReviewQuestions();
        showView("view-review");
    } catch (e) { toastErr(e.message); }
}

function renderReviewQuestions() {
    const box = document.getElementById("review-questions");
    const labels = ["A", "B", "C", "D"];
    box.innerHTML = reviewState.questions.map((q, i) => {
        const opts = q.options.map((o, idx) => `
            <label class="q-opt" onclick="chooseOpt(this)">
                <input type="radio" name="rv${i}" value="${esc(o)}" onchange="setReviewAnswer(${i}, this.value)">
                <span class="opt-label">${labels[idx]}.</span> ${esc(o)}
            </label>`).join("");
        return `<div class="q-item">
            <div class="q-text"><span class="q-num">${i + 1}.</span> ${esc(q.question)}</div>
            <div class="q-options">${opts}</div>
        </div>`;
    }).join("");
}

function setReviewAnswer(idx, val) {
    reviewState.answers[idx] = val;
    const answered = Object.keys(reviewState.answers).length;
    document.getElementById("review-progress").textContent = `${answered} / ${reviewState.questions.length}`;
}

async function submitReview() {
    const items = reviewState.questions.map((q, i) => ({
        wordbook_id: q.wordbook_id,
        word: q.word,
        meaning: q.meaning,
        correct: reviewState.answers[i] === q.answer,
    }));
    try {
        const r = await api("/api/review/grade", { method: "POST", body: { items } });
        document.getElementById("review-questions").parentElement.classList.add("hidden");
        const res = document.getElementById("review-result");
        res.classList.remove("hidden");
        const circle = document.getElementById("review-score");
        circle.style.setProperty("--pct", r.score + "%");
        circle.setAttribute("data-score", r.score + "%");
        circle.textContent = "";
        document.getElementById("review-correct").textContent = r.correct;
        document.getElementById("review-total").textContent = r.total;
        document.getElementById("review-detail").innerHTML = reviewState.questions.map((q, i) => {
            const ok = reviewState.answers[i] === q.answer;
            return `<div class="rep-q ${ok ? "" : "wrong"}">
                <div class="rq-title">${esc(q.word)}</div>
                <div class="rq-you ${ok ? "ok" : "no"}">내 답: ${esc(reviewState.answers[i] || "(미응답)")} ${ok ? "✅" : "❌"}</div>
                ${ok ? "" : `<div class="rq-ans">정답: ${esc(q.answer)}</div>`}
            </div>`;
        }).join("");
        window.scrollTo(0, 0);
    } catch (e) { toastErr(e.message); }
}

// 점수 추이 — 시험지별 탭 (전체 + 각 시험지)
let trendState = { all: [], exams: [], sel: "all" };

function renderTrendTabs(all, examTrends) {
    trendState = { all: all || [], exams: examTrends || [], sel: "all" };
    const tabs = document.getElementById("trend-tabs");
    const chips = [`<button class="trend-tab active" data-ex="all" onclick="selectTrend('all')">전체</button>`]
        .concat(trendState.exams.map(e =>
            `<button class="trend-tab" data-ex="${e.exam_id}" onclick="selectTrend('${e.exam_id}')">${esc(e.name)}</button>`));
    tabs.innerHTML = chips.join("");
    renderTrendChart(trendState.all);
}

function selectTrend(key) {
    trendState.sel = key;
    document.querySelectorAll("#trend-tabs .trend-tab").forEach(t =>
        t.classList.toggle("active", t.dataset.ex === String(key)));
    const data = key === "all" ? trendState.all
        : (trendState.exams.find(e => String(e.exam_id) === String(key))?.trend || []);
    renderTrendChart(data);
}

// 점수 추이 SVG 라인 차트
function renderTrendChart(trend) {
    const box = document.getElementById("trend-chart");
    box.innerHTML = trendChartHTML(trend);
}

// 점수 추이 차트 HTML(문자열) 생성 — 대시보드/학생상세 모달에서 재사용
function trendChartHTML(trend) {
    if (!trend || trend.length === 0) {
        return `<div class="trend-empty">아직 응시 기록이 없어요.<br>시험을 풀면 점수 추이가 표시됩니다.</div>`;
    }
    const W = 500, H = 180, padL = 34, padR = 12, padT = 14, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = trend.length;
    const xAt = i => padL + (n === 1 ? iw / 2 : iw * i / (n - 1));
    const yAt = v => padT + ih * (1 - v / 100);

    // 가로 격자 (0/50/100)
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

    return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="점수 추이">
        <defs>
            <linearGradient id="tcArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.28"/>
                <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
            </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#tcArea)"/>
        <path d="${line}" class="tc-line"/>
        ${dots}
    </svg>`;
}

function renderRecent(recent) {
    const box = document.getElementById("recent-list");
    if (!recent || recent.length === 0) {
        box.innerHTML = `<div class="recent-empty">최근 응시한 시험이 없어요.</div>`;
        return;
    }
    box.innerHTML = recent.map(r => {
        const cls = r.score >= 80 ? "hi" : (r.score >= 50 ? "mid" : "lo");
        return `<div class="recent-item recent-clickable" onclick="viewAttempt(${r.id})" title="리포트 보기">
            <div style="min-width:0">
                <div class="ri-name">${esc(r.exam_name)}</div>
                <div class="ri-date">${fmtDate(r.created_at)} · ${r.correct}/${r.total}</div>
            </div>
            <span class="ri-score ${cls}">${r.score}%</span>
        </div>`;
    }).join("");
}

function switchTab(name) {
    // 사이드바 링크 하이라이트 + 개요 숨김 (탭으로 직접 진입하는 경우 대비)
    document.querySelectorAll(".side-link[data-nav]").forEach(l =>
        l.classList.toggle("active", l.dataset.nav === name));
    document.querySelector(".dash-stats")?.classList.add("hidden");
    ["wordbooks", "exams", "calendar", "classes"].forEach(t =>
        document.getElementById("tab-" + t).classList.toggle("hidden", t !== name));
    if (name === "wordbooks") loadWordbooks();
    if (name === "exams") loadExams();
    if (name === "classes") loadClasses();
    if (name === "calendar") { loadToday(); loadCalendar(); loadPlanner(); }
}

// 학습 리포트 (사이드바 하단 진입)
async function loadReport() {
    const box = document.getElementById("report-body");
    box.innerHTML = `<div class="muted" style="padding:20px">불러오는 중…</div>`;
    try {
        const s = await api("/api/stats");
        const a = await api("/api/analysis");
        const m = s.mastery || { mastered: 0, learning: 0, weak: 0 };
        const kpi = (n, l) => `<div class="kpi"><div class="kpi-num">${n}</div><div class="kpi-label">${l}</div></div>`;
        const scoreBars = (s.exam_scores || []).length ? (s.exam_scores).map(e => {
            const cls = e.best >= 80 ? "hi" : (e.best >= 50 ? "mid" : "lo");
            return `<div class="es-row" onclick="openExam(${e.exam_id})">
                <div class="es-top"><span class="es-name">${esc(e.name)}</span><span class="es-best ${cls}">${e.best}%</span></div>
                <div class="es-track"><div class="es-bar ${cls}" style="width:${e.best}%"></div></div>
                <div class="es-sub">평균 ${e.avg}% · ${e.attempts}회</div></div>`;
        }).join("") : `<div class="trend-empty">아직 응시한 시험지가 없어요.</div>`;
        const wordList = (arr, empty) => arr.length ? arr.map(w => `
            <div class="weak-item"><div style="min-width:0"><div class="weak-word">${esc(w.word)}</div>
            <div class="weak-mean">${esc(w.meaning || "")}</div></div>
            <span class="weak-acc ${w.accuracy < 50 ? "lo" : "mid"}">${w.accuracy}%</span></div>`).join("") :
            `<div class="mastery-empty">${empty}</div>`;
        box.innerHTML = `
            <div class="kpi-row" style="grid-template-columns:repeat(5,1fr)">
                ${kpi(s.totals.attempts, "총 응시")}${kpi(s.avg_score + "%", "평균 점수")}${kpi(s.best_score + "%", "최고 점수")}
                ${kpi(m.mastered, "정복 단어")}${kpi(s.week_attempts || 0, "이번 주 응시")}</div>
            <div class="stats-lower" style="margin-top:16px">
                <div class="chart-card"><h3>시험지별 성적</h3><div class="exam-scores">${scoreBars}</div></div>
                <div class="recent-card"><h3>단어 숙련도</h3>
                    <div class="mastery-legend" style="margin-bottom:12px">
                        <span><i class="dot-m" style="background:var(--green)"></i> 정복 ${m.mastered}</span>
                        <span><i class="dot-m" style="background:var(--primary)"></i> 학습중 ${m.learning}</span>
                        <span><i class="dot-m" style="background:var(--red)"></i> 취약 ${m.weak}</span></div>
                    <h4 class="mini-list-title" style="margin-top:0">취약 단어 (${(a.weak_words || []).length})</h4>
                    <div class="weak-list">${wordList(a.weak_words || [], "취약 단어가 없어요 👍")}</div>
                </div>
            </div>
            <div class="card" style="margin-top:16px"><h3>학습 중인 단어 (${(a.learning_words || []).length})</h3>
                <div class="mini-word-list" style="max-height:300px">${(a.learning_words || []).length ?
                    (a.learning_words).map(w => `<div class="mini-word-item"><span class="mw-word">${esc(w.word)}</span>
                    <span class="mw-mean">${esc(w.meaning || "")}</span>
                    <span class="mw-streak">${"●".repeat(Math.min(w.streak, 2))}${"○".repeat(Math.max(0, 2 - w.streak))}</span></div>`).join("")
                    : `<div class="mastery-empty" style="padding:14px 0">학습 중인 단어가 아직 없어요.</div>`}</div></div>`;
    } catch (e) { box.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

// ============================================================
// 학습 캘린더 (망각곡선 복습 알림 + 학습 기록)
// ============================================================
let calState = { year: 0, month: 0, data: null, plan: {} };

async function loadCalendar() {
    if (!calState.year) {
        const now = new Date();
        calState.year = now.getFullYear();
        calState.month = now.getMonth();  // 0-11
    }
    try {
        calState.data = await api("/api/calendar");
    } catch (e) { calState.data = { study: {}, reviews: {}, today: "" }; }
    // 활성 플랜의 날짜별 신규/복습 개수를 캘린더에 겹쳐 표시
    calState.plan = {};
    calState.planDays = {};
    calState.planId = null;
    calState.planDone = new Set();
    try {
        const { plan } = await api("/api/planner");
        if (plan) {
            calState.planId = plan.id;
            (plan.done || []).forEach(([d, k]) => calState.planDone.add(d + "|" + k));
            plan.schedule.forEach(d => {
                calState.plan[d.date] = { new: d.new.length, review: d.review.length };
                calState.planDays[d.date] = d;   // 실제 단어 목록 (상세용)
            });
        }
    } catch (e) {}
    renderCalendar();
}

function calMove(delta) {
    calState.month += delta;
    if (calState.month < 0) { calState.month = 11; calState.year--; }
    if (calState.month > 11) { calState.month = 0; calState.year++; }
    renderCalendar();
    document.getElementById("cal-day-detail").classList.add("hidden");
}

function renderCalendar() {
    const { year, month, data } = calState;
    document.getElementById("cal-title").textContent = `${year}.${String(month + 1).padStart(2, "0")}`;
    const first = new Date(year, month, 1);
    const startDow = first.getDay();
    const daysIn = new Date(year, month + 1, 0).getDate();
    const todayStr = data?.today || "";
    const pad2 = n => String(n).padStart(2, "0");

    let cells = "";
    for (let i = 0; i < startDow; i++) cells += `<div class="cal-cell empty"></div>`;
    for (let d = 1; d <= daysIn; d++) {
        const dateStr = `${year}-${pad2(month + 1)}-${pad2(d)}`;
        const study = data?.study?.[dateStr];
        const reviewDue = data?.reviews?.[dateStr];
        const note = data?.notes?.[dateStr];
        const plan = calState.plan?.[dateStr];
        const isToday = dateStr === todayStr;
        const hasAny = study || reviewDue || plan || note;
        // 플랜/복습 칩: 미완료는 재생(▶)·드래그, 완료는 체크(✓)·클릭 시 결과 보기
        let chips = "";
        const doneNew = calState.planDone?.has(dateStr + "|new");
        const doneRev = calState.planDone?.has(dateStr + "|review");
        if (plan && plan.new) chips += doneNew
            ? `<span class="cal-plan-chip new done" onclick="event.stopPropagation(); openCalendarDay('${dateStr}')" title="학습 완료 · 결과 보기">📘 새 ${plan.new} <span class="cpc-done">✓</span></span>`
            : `<button class="cal-plan-chip new" draggable="true" ondragstart="dragCalPlan(event,'${dateStr}','new')" onclick="event.stopPropagation(); startPlanDay('${dateStr}','new')" title="새 단어 학습 · 드래그하면 날짜 이동">📘 새 ${plan.new} <span class="cpc-play">▶</span></button>`;
        if (plan && plan.review) chips += doneRev
            ? `<span class="cal-plan-chip review done" onclick="event.stopPropagation(); openCalendarDay('${dateStr}')" title="복습 완료 · 결과 보기">🔂 복습 ${plan.review} <span class="cpc-done">✓</span></span>`
            : `<button class="cal-plan-chip review" draggable="true" ondragstart="dragCalPlan(event,'${dateStr}','review')" onclick="event.stopPropagation(); startPlanDay('${dateStr}','review')" title="복습 · 드래그하면 날짜 이동">🔂 복습 ${plan.review} <span class="cpc-play">▶</span></button>`;
        else if (reviewDue) chips += `<button class="cal-plan-chip srs" draggable="true" ondragstart="dragCalSrs(event,'${dateStr}')" onclick="event.stopPropagation(); startReview()" title="망각곡선 복습 · 드래그하면 날짜 이동">🔁 복습 ${reviewDue} <span class="cpc-play">▶</span></button>`;
        // 커스텀 일정 칩 (드래그해서 다른 날짜로 이동 가능)
        chips += (data?.note_items?.[dateStr] || []).map(n =>
            `<span class="cal-note-chip ${n.done ? "done" : ""}" draggable="true"
                ondragstart="dragCalNote(event, ${n.id})" onclick="event.stopPropagation(); openCalendarDay('${dateStr}')"
                title="${esc(n.text)}">${esc(n.text)}</span>`).join("");
        // 학습 완료한 날은 파란 박스로 강조
        const studied = study ? "studied" : "";
        cells += `<div class="cal-cell ${isToday ? "today" : ""} ${hasAny ? "has" : ""} ${studied}"
            ondragover="event.preventDefault(); this.classList.add('drop-over')" ondragleave="this.classList.remove('drop-over')"
            ondrop="dropCalCell(event, '${dateStr}')" onclick="openCalendarDay('${dateStr}')">
            <span class="cal-num">${d}</span>
            <div class="cal-chips">${chips}</div>
        </div>`;
    }
    document.getElementById("cal-grid").innerHTML = cells;
}

// 드래그로 캘린더 항목(커스텀 일정 / AI 플랜 / 망각곡선 복습) 날짜 이동
let _dragItem = null;
// setData 를 호출해야 일부 브라우저에서 drop 이벤트가 정상 발생
function _dragInit(e) { try { e.dataTransfer.setData("text/plain", "move"); } catch (_) {} e.dataTransfer.effectAllowed = "move"; }
function dragCalNote(e, id) { _dragItem = { type: "note", id }; _dragInit(e); }
function dragCalPlan(e, date, kind) { _dragItem = { type: "plan", from: date, kind }; _dragInit(e); }
function dragCalSrs(e, date) { _dragItem = { type: "srs", from: date }; _dragInit(e); }
async function dropCalCell(e, date) {
    e.preventDefault();
    document.querySelectorAll(".cal-cell.drop-over").forEach(c => c.classList.remove("drop-over"));
    const item = _dragItem; _dragItem = null;
    if (!item) return;
    try {
        if (item.type === "note") {
            await api(`/api/calendar/note/${item.id}/move`, { method: "POST", body: { date } });
        } else if (item.type === "plan") {
            if (item.from === date || !calState.planId) return;
            const r = await api(`/api/planner/${calState.planId}/move`, { method: "POST", body: { from_date: item.from, to_date: date, kind: item.kind } });
            toast(r.recalculated ? "학습일을 옮기고 망각곡선 복습을 다시 계산했어요 📅" : "복습 일정을 옮겼어요 🔁", "success");
            loadNotifications();
        } else if (item.type === "srs") {
            if (item.from === date) return;
            const r = await api("/api/srs/reschedule", { method: "POST", body: { from_date: item.from, to_date: date } });
            toast(`이 날 복습 예정 단어 ${r.moved}개를 옮겼어요 🔁`, "success");
            loadNotifications();
        }
        loadCalendar(); loadToday();
    } catch (err) { toastErr(err.message); }
}

let _calDayDate = null;

async function openCalendarDay(date) {
    _calDayDate = date;
    document.getElementById("calday-title").textContent = date;
    document.getElementById("calday-modal").classList.remove("hidden");
    await renderCalDay();
}
function closeCalDay(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("calday-modal").classList.add("hidden");
}

async function renderCalDay() {
    const date = _calDayDate;
    const box = document.getElementById("calday-body");
    box.innerHTML = `<div class="muted" style="padding:14px 0">불러오는 중…</div>`;
    try {
        const d = await api(`/api/calendar/day/${date}`);
        const attemptsHtml = d.attempts.length ? `
            <h4 class="cal-detail-sub">이 날의 학습 기록</h4>
            ${d.attempts.map(a => {
                const cls = a.score >= 80 ? "hi" : (a.score >= 50 ? "mid" : "lo");
                return `<div class="hist-row" onclick="closeCalDay(); viewAttempt(${a.id})" style="cursor:pointer">
                    <span>${esc(a.exam_name)} <span class="muted">${fmtDate(a.created_at).slice(11)}</span></span>
                    <span><span class="ri-score ${cls}">${a.score}%</span> · ${a.correct}/${a.total}</span>
                </div>`;
            }).join("")}` : "";
        const pd = calState.planDays?.[date];
        let planHtml = "";
        if (pd && (pd.new.length || pd.review.length)) {
            const chips = arr => `<div class="cal-due-list">${arr.map(w =>
                `<span class="cal-due-chip"><b>${esc(w.word)}</b> ${esc(w.meaning || "")}</span>`).join("")}</div>`;
            planHtml = `<h4 class="cal-detail-sub">플랜: 이 날 학습</h4>`;
            if (pd.new.length) planHtml += `<p class="muted" style="margin:2px 0 6px">새 단어 ${pd.new.length}개</p>` +
                chips(pd.new) + `<button class="btn-accent" style="margin:10px 0" onclick='closeCalDay(); startFlashcardsWith(${jsAttr(pd.new)}, "planner")'>새 단어 학습</button>`;
            if (pd.review.length) planHtml += `<p class="muted" style="margin:10px 0 6px">복습 ${pd.review.length}개</p>` +
                chips(pd.review) + `<button class="btn-accent" style="margin:10px 0" onclick='closeCalDay(); startFlashcardsWith(${jsAttr(pd.review)}, "planner")'>복습하기</button>`;
        }
        const dueHtml = d.due.length ? `
            <h4 class="cal-detail-sub">망각곡선 복습 예정 (${d.due.length})</h4>
            <div class="cal-due-list">${d.due.map(w =>
                `<span class="cal-due-chip"><b>${esc(w.word)}</b> ${esc(w.meaning || "")}</span>`).join("")}</div>
            <button class="btn-accent" style="margin-top:12px" onclick="closeCalDay(); startReview()">지금 복습하기</button>` : "";
        // 커스텀 일정
        const notesHtml = `
            <h4 class="cal-detail-sub">내 일정</h4>
            <div class="calnote-list">${d.notes.length ? d.notes.map(n => `
                <div class="calnote-item ${n.done ? "done" : ""}">
                    <button class="calnote-check" onclick="toggleCalNote(${n.id})">${n.done ? "☑" : "☐"}</button>
                    <span class="calnote-text">${esc(n.text)}</span>
                    <button class="calnote-del" onclick="deleteCalNote(${n.id})">×</button>
                </div>`).join("") : `<div class="muted" style="padding:6px 0">추가한 일정이 없어요.</div>`}
            </div>
            <div class="calnote-add">
                <input type="text" id="calnote-input" placeholder="예: 단어 30개 외우기" onkeydown="if(event.key==='Enter')addCalNote()">
                <button class="btn-primary" style="width:auto" onclick="addCalNote()">추가</button>
            </div>`;
        box.innerHTML = planHtml + attemptsHtml + dueHtml + notesHtml;
    } catch (e) { box.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

async function addCalNote() {
    const inp = document.getElementById("calnote-input");
    const text = inp.value.trim();
    if (!text) return;
    try {
        await api("/api/calendar/note", { method: "POST", body: { date: _calDayDate, text } });
        await renderCalDay();
        loadCalendar(); loadToday();
    } catch (e) { toastErr(e.message); }
}
async function toggleCalNote(id) {
    try { await api(`/api/calendar/note/${id}/toggle`, { method: "POST" }); await renderCalDay(); loadToday(); }
    catch (e) { toastErr(e.message); }
}
async function deleteCalNote(id) {
    try { await api(`/api/calendar/note/${id}`, { method: "DELETE" }); await renderCalDay(); loadCalendar(); loadToday(); }
    catch (e) { toastErr(e.message); }
}

// ============================================================
// 오늘 할 일 (망각곡선 복습 + 플랜 + 배정 시험)
// ============================================================
let todayState = {};

async function loadToday() {
    const dateStr = new Date().toLocaleDateString("ko-KR",
        { year: "numeric", month: "long", day: "numeric", weekday: "long" });
    document.querySelectorAll(".today-date").forEach(el => el.textContent = dateStr);
    const setAll = html => document.querySelectorAll(".today-list").forEach(el => el.innerHTML = html);
    try {
        const t = await api("/api/today");
        todayState = t;
        const items = [];
        // 1) 망각곡선 복습
        if (t.reviews_due > 0) items.push(`
            <div class="todo-item" onclick="startReview()">
                <span class="todo-ico" data-icon="repeat"></span>
                <div class="todo-body"><b>망각곡선 복습 ${t.reviews_due}개</b>
                    <span class="muted">잊을 때가 된 단어예요. 지금이 복습 적기!</span></div>
                <span class="todo-go" data-icon="chevron"></span>
            </div>`);
        // 2) 플랜의 오늘 항목
        const p = t.plan_today;
        if (p && p.new.length && !p.new_done) items.push(`
            <div class="todo-item" onclick='startPlanNew(${jsAttr(p.new)})'>
                <span class="todo-ico" data-icon="book"></span>
                <div class="todo-body"><b>오늘의 새 단어 ${p.new.length}개</b>
                    <span class="muted">${esc(p.plan_name)} · 플래시카드로 학습</span></div>
                <span class="todo-go" data-icon="chevron"></span>
            </div>`);
        if (p && p.review.length && !p.review_done) items.push(`
            <div class="todo-item" onclick='startPlanReview(${jsAttr(p.review)})'>
                <span class="todo-ico" data-icon="repeat"></span>
                <div class="todo-body"><b>플랜 복습 ${p.review.length}개</b>
                    <span class="muted">${esc(p.plan_name)} · 오늘 복습 예정 단어</span></div>
                <span class="todo-go" data-icon="chevron"></span>
            </div>`);
        // 3) 배정된 시험 (미응시)
        (t.assignments || []).forEach(a => items.push(`
            <div class="todo-item" onclick="openExam(${a.exam_id})">
                <span class="todo-ico" data-icon="doc"></span>
                <div class="todo-body"><b>${esc(a.exam_name)}</b>
                    <span class="muted">${esc(a.class_name)} · 선생님이 배정한 시험</span></div>
                <span class="todo-go" data-icon="chevron"></span>
            </div>`));
        // 4) 내가 추가한 커스텀 일정
        (t.notes || []).forEach(n => items.push(`
            <div class="todo-item todo-note">
                <button class="todo-ico todo-check" onclick="event.stopPropagation(); completeTodayNote(${n.id})" title="완료">☐</button>
                <div class="todo-body"><b>${esc(n.text)}</b>
                    <span class="muted">내가 추가한 일정</span></div>
            </div>`));

        setAll(items.length ? items.join("")
            : `<div class="today-clear">오늘 할 일을 모두 끝냈어요! 👏<br><span class="muted">플랜을 만들면 매일 할 일이 여기 표시됩니다.</span></div>`);
        document.querySelectorAll(".today-list [data-icon]").forEach(el => { if (ICONS[el.dataset.icon]) el.innerHTML = ICONS[el.dataset.icon]; });
    } catch (e) { setAll(`<div class="today-clear muted">불러오기 실패</div>`); }
}

async function completeTodayNote(id) {
    try { await api(`/api/calendar/note/${id}/toggle`, { method: "POST" }); loadToday(); loadCalendar(); }
    catch (e) { toastErr(e.message); }
}

// 플랜: 오늘의 새 단어를 플래시카드로 학습 → 완료 표시
function startPlanNew(words) {
    startFlashcardsWith(words, "planner");
    if (todayState.plan_today) markPlanDone(todayState.plan_today.plan_id, "new");
}
function startPlanReview(words) {
    startFlashcardsWith(words, "planner");
    if (todayState.plan_today) markPlanDone(todayState.plan_today.plan_id, "review");
}
async function markPlanDone(planId, kind) {
    try {
        const today = new Date().toISOString().slice(0, 10);
        await api(`/api/planner/${planId}/complete`, { method: "POST", body: { date: today, kind } });
    } catch (e) {}
}

// 캘린더 플랜 칩의 ▶ 재생 버튼: 그 날 항목 바로 학습
function startPlanDay(date, kind) {
    const day = calState.planDays?.[date];
    if (!day) return;
    const words = (kind === "new" ? day.new : day.review) || [];
    if (!words.length) return toastErr("학습할 항목이 없어요.");
    startFlashcardsWith(words, "planner");
    // 오늘 날짜면 완료 표시
    if (calState.planId && date === (calState.data?.today || "")) markPlanDone(calState.planId, kind);
}

// ============================================================
// 학습 플랜 (표시 + AI 플래너)
// ============================================================
async function loadPlanner() {
    const box = document.getElementById("plan-box");
    try {
        const { plan } = await api("/api/planner");
        if (!plan) {
            box.innerHTML = `<div class="empty-state">아직 학습 플랜이 없어요.<br>“＋ AI 학습 플래너”로 망각곡선 맞춤 계획을 세워보세요!</div>`;
            return;
        }
        const pct = plan.total_days ? Math.round(plan.done_days / plan.total_days * 100) : 0;
        const WD = ["일", "월", "화", "수", "목", "금", "토"];
        let periodTxt = "";
        if (plan.period_days) {
            periodTxt = plan.period_days % 7 === 0
                ? ` · 기간 ${plan.period_days / 7}주` : ` · 기간 ${plan.period_days}일`;
        }
        const exc = plan.exclude_weekdays || [];
        const excTxt = exc.length ? ` · ${exc.map(d => WD[d]).join("·")} 제외` : "";
        const targetTxt = periodTxt + excTxt;
        box.innerHTML = `
            <div class="plan-summary-card">
                <div class="panel-head" style="margin-bottom:10px">
                    <div><b style="font-size:1.05rem">${esc(plan.name)}</b>
                        <div class="muted">${esc(plan.goal || "매일 조금씩 · 망각곡선 복습")}${targetTxt}</div></div>
                    <div style="display:flex; gap:6px">
                        <button class="btn-secondary" onclick="startPlanner(${jsAttr({ wordbook_ids: plan.wordbook_ids || [], goal: plan.goal, period_days: plan.period_days, exclude_weekdays: plan.exclude_weekdays || [], daily_new: plan.daily_new })})">✏️ 수정</button>
                        <button class="btn-ghost danger" onclick="deletePlan(${plan.id})">삭제</button>
                    </div>
                </div>
                <div class="plan-progress-track"><div class="plan-progress-bar" style="width:${pct}%"></div></div>
                <div class="muted" style="margin-top:6px">진행 ${plan.done_days} / ${plan.total_days}일 (${pct}%) · 하루 새 단어 ${plan.daily_new}개 · 복습 간격 ${plan.intervals.join("·")}일</div>
            </div>`;
    } catch (e) { box.innerHTML = ""; }
}

async function deletePlan(id) {
    if (!await showConfirm("플랜 삭제", "학습 플랜을 삭제할까요?", { okText: "삭제", danger: true })) return;
    try {
        await api(`/api/planner/${id}`, { method: "DELETE" });
        loadPlanner(); loadCalendar(); loadToday();
        toast("플랜을 삭제했어요.", "success");
    } catch (e) { toastErr(e.message); }
}

let plState = { wordbooks: [], selected: new Set(), preview: null };

async function startPlanner(prefill) {
    try {
        const { wordbooks } = await api("/api/wordbooks");
        if (!wordbooks.length) return toastErr("먼저 단어장을 만들어주세요.");
        const preIds = new Set((prefill && prefill.wordbook_ids) || []);
        plState = { wordbooks, selected: preIds, preview: null };
        document.getElementById("pl-wordbooks").innerHTML = wordbooks.map(wb => `
            <label class="ec-wb ${preIds.has(wb.id) ? "sel" : ""}" data-id="${wb.id}">
                <input type="checkbox" ${preIds.has(wb.id) ? "checked" : ""} onchange="togglePlWb(${wb.id}, this.checked)">
                <span class="ec-wb-body"><b>${esc(wb.name)}</b>
                    <span class="ec-wb-meta">${langLabel(wb.language)} · ${wb.word_count}단어</span></span>
            </label>`).join("");
        document.getElementById("pl-goal").value = (prefill && prefill.goal) || "";
        // 기간 프리필: 7의 배수면 '주', 아니면 '일'
        const pd = prefill && prefill.period_days;
        const unitSel = document.getElementById("pl-period-unit");
        const periodInp = document.getElementById("pl-period");
        if (pd && pd % 7 === 0) { unitSel.value = "7"; periodInp.value = pd / 7; }
        else if (pd) { unitSel.value = "1"; periodInp.value = pd; }
        else { unitSel.value = "7"; periodInp.value = ""; }
        // 제외 요일 체크박스 프리필
        const exc = new Set((prefill && prefill.exclude_weekdays) || []);
        document.querySelectorAll("#pl-exclude input[type=checkbox]").forEach(cb => {
            cb.checked = exc.has(parseInt(cb.value));
            cb.closest(".wd-chip").classList.toggle("on", cb.checked);
        });
        document.getElementById("pl-daily").value = (prefill && prefill.daily_new) || "";
        document.getElementById("pl-name").value = "";
        document.getElementById("pl-preview").classList.add("hidden");
        updatePlCount();
        showView("view-planner");
    } catch (e) { toastErr(e.message); }
}

function togglePlWb(id, checked) {
    if (checked) plState.selected.add(id); else plState.selected.delete(id);
    document.querySelector(`#pl-wordbooks .ec-wb[data-id="${id}"]`)?.classList.toggle("sel", checked);
    updatePlCount();
}
function updatePlCount() {
    const total = plState.wordbooks.filter(w => plState.selected.has(w.id))
        .reduce((s, w) => s + (w.word_count || 0), 0);
    document.getElementById("pl-word-count").textContent = total;
}
// 공부 안 하는 요일 칩 토글 (체크 시 붉게 강조)
function toggleWd(cb) { cb.closest(".wd-chip").classList.toggle("on", cb.checked); }

async function planPreview() {
    const ids = [...plState.selected];
    if (!ids.length) return toastErr("공부할 단어장을 선택하세요.");
    const goal = document.getElementById("pl-goal").value.trim();
    const periodNum = parseInt(document.getElementById("pl-period").value) || 0;
    const unit = parseInt(document.getElementById("pl-period-unit").value) || 7;
    const periodDays = periodNum > 0 ? periodNum * unit : null;
    const exclude = [...document.querySelectorAll("#pl-exclude input:checked")].map(cb => parseInt(cb.value));
    const daily = parseInt(document.getElementById("pl-daily").value) || null;
    const btn = document.querySelector('#view-planner .btn-accent');
    const old = btn.textContent; btn.textContent = "🤖 AI가 계획 세우는 중..."; btn.disabled = true;
    try {
        const pv = await api("/api/planner/preview", { method: "POST", body: {
            wordbook_ids: ids, goal, period_days: periodDays, exclude_weekdays: exclude, daily_new: daily } });
        plState.preview = { ids, goal, periodDays, exclude, daily: pv.daily_new, reviews: (pv.intervals || []).length };
        renderPlanPreview(pv);
    } catch (e) { toastErr(e.message); }
    finally { btn.textContent = old; btn.disabled = false; }
}

function renderPlanPreview(pv) {
    const label = pv.ai_used ? "AI 코치 추천" : "학습 과학 기반 추천";
    let lock = "";
    if (pv.ai_locked) {
        lock = `<div class="plan-lock">🔒 무료 등급의 AI 맞춤 추천을 모두 사용했어요 (${pv.ai_used_count}/${pv.ai_limit}·월).
            지금은 학습 과학 기반 자동 플랜으로 만들어 드려요.
            <a onclick="openProfile()">프리미엄으로 업그레이드</a>하면 AI 맞춤 추천을 무제한 이용할 수 있어요.</div>`;
    } else if (!pv.ai_used && pv.ai_limit < 9999) {
        lock = `<div class="plan-lock-note">이번 달 AI 맞춤 추천 ${pv.ai_used_count}/${pv.ai_limit}회 사용</div>`;
    }
    document.getElementById("pl-summary").innerHTML =
        `<b>${label}</b><br><span>${esc(pv.summary)}</span>${lock}`;
    const s = pv.stats;
    document.getElementById("pl-stats").innerHTML = `
        <div class="plan-stat"><div class="ps-num">${pv.word_count}</div><div class="ps-lbl">단어</div></div>
        <div class="plan-stat"><div class="ps-num">${pv.daily_new}</div><div class="ps-lbl">하루 새 단어</div></div>
        <div class="plan-stat"><div class="ps-num">${pv.days.length}</div><div class="ps-lbl">학습일</div></div>
        <div class="plan-stat"><div class="ps-num">${s.total_review}</div><div class="ps-lbl">총 복습</div></div>`;
    // 망각곡선 미니 그래프
    document.getElementById("pl-curve").innerHTML = curveSVG(pv.retention_curve, pv.intervals);
    document.getElementById("pl-intervals").textContent =
        `복습 간격: 첫 학습 후 ${pv.intervals.join(", ")}일째에 복습 (에빙하우스 망각곡선 기반 확장 간격)`;
    // 계획 미리보기 (처음 14일)
    document.getElementById("pl-days").innerHTML = pv.days.slice(0, 14).map(d => `
        <div class="plan-day">
            <span class="pd-date">${d.date.slice(5)}</span>
            <span class="pd-tags">${d.new ? `<span class="pd-new">새 ${d.new}</span>` : ""}${d.review ? `<span class="pd-rev">복습 ${d.review}</span>` : ""}</span>
        </div>`).join("") + (pv.days.length > 14 ? `<div class="muted" style="text-align:center;padding:8px">…외 ${pv.days.length - 14}일</div>` : "");
    document.getElementById("pl-preview").classList.remove("hidden");
    document.getElementById("pl-preview").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// 예상 망각곡선 SVG (복습 시점 표시)
function curveSVG(curve, intervals) {
    const W = 520, H = 150, padL = 30, padR = 12, padT = 12, padB = 24;
    const iw = W - padL - padR, ih = H - padT - padB;
    const maxDay = Math.max(...curve.map(c => c.day), 1);
    const xAt = day => padL + iw * day / maxDay;
    const yAt = r => padT + ih * (1 - r / 100);
    const pts = curve.map(c => [xAt(c.day), yAt(c.retention)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const dots = curve.map((c, i) => `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="3.5" class="tc-dot"/>`).join("");
    const marks = curve.filter(c => c.day > 0).map(c =>
        `<line x1="${xAt(c.day).toFixed(1)}" y1="${padT}" x2="${xAt(c.day).toFixed(1)}" y2="${padT + ih}" class="curve-mark"/>` +
        `<text x="${xAt(c.day).toFixed(1)}" y="${H - 8}" class="tc-axis" text-anchor="middle">${c.day}d</text>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="망각곡선">
        <line x1="${padL}" y1="${yAt(90)}" x2="${W - padR}" y2="${yAt(90)}" class="tc-grid"/>
        <text x="${padL - 4}" y="${yAt(90) + 3}" class="tc-axis" text-anchor="end">90</text>
        ${marks}
        <path d="${line}" class="tc-line"/>${dots}
    </svg>`;
}

async function savePlan() {
    if (!plState.preview) return toastErr("먼저 AI 플랜을 생성하세요.");
    const name = document.getElementById("pl-name").value.trim() || "나의 학습 플랜";
    const pv = plState.preview;
    try {
        await api("/api/planner", { method: "POST", body: {
            name, goal: pv.goal, wordbook_ids: pv.ids,
            period_days: pv.periodDays, exclude_weekdays: pv.exclude,
            daily_new: pv.daily, reviews: pv.reviews } });
        toast("학습 플랜을 시작했어요! 매일 오늘 할 일을 확인하세요.", "success");
        navTo("calendar");
    } catch (e) { toastErr(e.message); }
}

async function loadWordbooks() {
    const el = document.getElementById("wordbook-list");
    try {
        const { wordbooks } = await api("/api/wordbooks");
        if (!wordbooks.length) {
            el.innerHTML = `<div class="empty-state">아직 단어장이 없어요.<br>“＋ 새 단어장 만들기”로 시작해보세요!</div>`;
            return;
        }
        el.innerHTML = wordbooks.map(wb => `
            <div class="item-card" onclick="openWordbook(${wb.id})">
                <button class="card-del" title="삭제" onclick="event.stopPropagation(); deleteWordbookById(${wb.id}, ${esc(jsStr(wb.name))})">🗑</button>
                <div class="ic-title">${esc(wb.name)}</div>
                <div class="ic-desc">${esc(wb.description || "설명 없음")}</div>
                <div class="ic-meta">
                    <span class="lang-badge">${langLabel(wb.language)}</span>
                    <span class="badge">${wb.word_count} 단어</span>
                    <span class="badge gray">시험지 ${wb.exam_count}개</span>
                </div>
            </div>`).join("");
    } catch (e) { el.innerHTML = `<div class="empty-state">불러오기 실패: ${e.message}</div>`; }
}

async function loadExams() {
    const el = document.getElementById("exam-list");
    try {
        const { exams } = await api("/api/exams");
        if (!exams.length) {
            el.innerHTML = `<div class="empty-state">아직 시험지가 없어요.<br>단어장을 열고 시험지를 만들어보세요!</div>`;
            return;
        }
        el.innerHTML = exams.map(ex => `
            <div class="item-card" onclick="openExam(${ex.id})">
                <button class="card-del" title="삭제" onclick="event.stopPropagation(); deleteExamById(${ex.id}, ${esc(jsStr(ex.name))})">🗑</button>
                <div class="ic-title">${esc(ex.name)}</div>
                <div class="ic-desc">${esc(ex.wordbook_name || "단어장 삭제됨")}</div>
                <div class="ic-meta">
                    <span class="badge">${esc(ex.format_label)}</span>
                    <span class="badge gray">${ex.question_count}문항</span>
                    ${ex.attempt_count ? `<span class="badge green">최고 ${ex.best_score}%</span>` : ``}
                </div>
                <div class="ic-actions">
                    <button class="btn-mini" onclick="event.stopPropagation(); quickExamPdf(${ex.id})">📄 PDF</button>
                    ${ex.attempt_count ? `<button class="btn-mini" onclick="event.stopPropagation(); openExamResults(${ex.id})">📊 결과 (${ex.attempt_count})</button>` : ``}
                </div>
            </div>`).join("");
    } catch (e) { el.innerHTML = `<div class="empty-state">불러오기 실패: ${e.message}</div>`; }
}

// 시험지 카드에서 PDF 커스텀 모달 열기 (풀지 않아도)
async function quickExamPdf(id) {
    await openPdfModal(id);
}

// 시험지 카드에서 지난 결과 바로 보기 (가장 최근 응시 리포트)
async function openExamResults(id) {
    try {
        const { exam } = await api(`/api/exams/${id}`);
        takeState = { exam, answers: {}, timer: null, elapsed: 0, limit: 0 };
        const { attempts } = await api(`/api/exams/${id}/attempts`);
        if (!attempts.length) return toastErr("아직 응시 기록이 없어요.");
        await viewAttempt(attempts[0].id);
    } catch (e) { toastErr(e.message); }
}

// ============================================================
// 반 · 교사 모드
// ============================================================
let currentClass = null;

async function loadClasses() {
    // 선생님: "내가 만든 반"만 표시 / 학생·프리미엄: "참여한 반"만 표시
    const isTeacher = !!CURRENT_USER?.limits?.can_create_class;
    document.getElementById("teacher-section").classList.toggle("hidden", !isTeacher);
    document.getElementById("student-section").classList.toggle("hidden", isTeacher);
    if (isTeacher) {
        try {
            const { classes } = await api("/api/classes");
            const el = document.getElementById("teacher-classes");
            el.innerHTML = classes.length ? classes.map(c => `
                <div class="item-card" onclick="openTeacherClass(${c.id})">
                    <div class="ic-title">${esc(c.name)}</div>
                    <div class="ic-desc">참여 코드 <b>${esc(c.join_code)}</b></div>
                    <div class="ic-meta">
                        <span class="badge">학생 ${c.student_count}명</span>
                        <span class="badge gray">시험지 ${c.assignment_count}개</span>
                    </div>
                </div>`).join("") :
                `<div class="empty-state">아직 만든 반이 없어요.<br>"＋ 반 만들기"로 개설하고 학생에게 코드를 알려주세요.</div>`;
        } catch (e) {}
    } else {
        try {
            const { classes } = await api("/api/classes/joined");
            const el = document.getElementById("student-classes");
            el.innerHTML = classes.length ? classes.map(c => `
                <div class="item-card" onclick="openStudentClass(${c.id})">
                    <div class="ic-title">${esc(c.name)}</div>
                    <div class="ic-desc">${esc(c.teacher_name)} 선생님</div>
                    <div class="ic-meta"><span class="badge">과제 ${c.assignment_count}개</span></div>
                </div>`).join("") :
                `<div class="empty-state">참여한 반이 없어요.<br>선생님께 받은 코드를 입력해 참여하세요.</div>`;
        } catch (e) {}
    }
}

function createClass() {
    if (!CURRENT_USER?.limits?.can_create_class) {
        toast("반 개설은 선생님 회원만 가능해요.", "error");
        return openProfile();
    }
    openInputModal("반 만들기", "학생에게 공유할 반 이름을 정해주세요.", "예: 중2 영어 A반", "", async (name) => {
        if (!name) return;
        try {
            await api("/api/classes", { method: "POST", body: { name } });
            toast("반을 만들었어요! 학생을 추가해보세요.", "success");
            if (CURRENT_USER?.limits?.can_create_class) loadTeacherDash(); else loadClasses();
        } catch (e) { toast(e.message, "error"); }
    });
}

async function joinClass() {
    const code = document.getElementById("join-code").value.trim();
    if (!code) return toast("참여 코드를 입력하세요.", "error");
    try {
        const r = await api("/api/classes/join", { method: "POST", body: { code } });
        document.getElementById("join-code").value = "";
        toast(`'${r.name}' 반에 참여했어요!`, "success");
        loadClasses();
    } catch (e) { toast(e.message, "error"); }
}

// ---- 선생님 반 상세 ----
async function openTeacherClass(cid) {
    try {
        const data = await api(`/api/classes/${cid}`);
        currentClass = data.class;
        document.getElementById("ct-name").textContent = data.class.name;
        document.getElementById("ct-take-link").value = `${location.origin}/?take=${data.class.join_code}`;
        const max = CURRENT_USER?.limits?.max_students || 40;
        document.getElementById("ct-student-count").textContent = `학생 ${data.roster.length} / ${max}명`;
        document.getElementById("ct-roster-cap").textContent = `(${data.roster.length} / ${max})`;
        // 시험지 배정 옵션
        const { exams } = await api("/api/exams");
        const assignedIds = new Set(data.assignments.map(a => a.exam_id));
        const opts = exams.filter(e => !assignedIds.has(e.id));
        document.getElementById("assign-exam").innerHTML = opts.length
            ? opts.map(e => `<option value="${e.id}">${esc(e.name)} (${e.question_count}문항)</option>`).join("")
            : `<option value="">배정할 시험지가 없어요</option>`;
        // 단어장 배정 옵션
        const { wordbooks } = await api("/api/wordbooks");
        const wbAssigned = new Set((data.wordbook_assignments || []).map(a => a.wordbook_id));
        const wbOpts = wordbooks.filter(w => !wbAssigned.has(w.id));
        document.getElementById("assign-wordbook").innerHTML = wbOpts.length
            ? wbOpts.map(w => `<option value="${w.id}">${esc(w.name)} (${w.word_count}단어)</option>`).join("")
            : `<option value="">배정할 단어장이 없어요</option>`;
        renderAssignments(data.assignments);
        renderWbAssignments(data.wordbook_assignments || []);
        renderRoster(data.roster);
        renderClassDashboard(data);
        showView("view-class-teacher");
    } catch (e) { toastErr(e.message); }
}

function renderAssignments(assignments) {
    document.getElementById("ct-assignments").innerHTML = assignments.length ? assignments.map(a => `
        <div class="assign-item">
            <span>📝 ${esc(a.exam_name)} <span class="muted">(${a.question_count}문항)</span></span>
            <button class="btn-close" title="배정 취소" onclick="unassign(${a.id})">×</button>
        </div>`).join("") : `<div class="muted" style="margin-top:8px">아직 배정한 시험지가 없어요.</div>`;
}

function renderWbAssignments(list) {
    document.getElementById("ct-wb-assignments").innerHTML = list.length ? list.map(a => `
        <div class="assign-item">
            <span>📘 ${esc(a.wordbook_name)} <span class="muted">(${a.word_count}단어)</span></span>
            <button class="btn-close" title="배정 취소" onclick="unassignWordbook(${a.id})">×</button>
        </div>`).join("") : `<div class="muted" style="margin-top:8px">아직 배정한 단어장이 없어요.</div>`;
}

// 로스터 학생 카드 (숫자 학생 ID 표시, 삭제)
function renderRoster(roster) {
    const el = document.getElementById("ct-roster");
    if (!roster.length) return el.innerHTML = `<div class="empty-state">아직 학생이 없어요.<br>“＋ 학생 추가”로 등록하세요.</div>`;
    el.innerHTML = roster.map(s => `
        <div class="roster-card" onclick="openStudentDetail(${currentClass.id}, ${s.student_id})">
            <div class="rc-main">
                <span class="rc-name">${esc(s.nickname || s.email)} <span class="stu-arrow">›</span></span>
                ${s.student_sid ? `<span class="rc-id">ID ${esc(s.student_sid)}</span>` : `<span class="rc-id gray">ID 없음</span>`}
            </div>
            <button class="btn-close" title="학생 삭제" onclick="event.stopPropagation(); removeStudent(${currentClass.id}, ${s.student_id}, '${esc(s.nickname || s.email)}')">×</button>
        </div>`).join("");
}

// 학생 추가 → 반 코드 + 숫자 학생 ID 발급 안내
function addStudent() {
    openInputModal("학생 추가", "학생 이름을 입력하면 숫자 학생 ID가 발급돼요.", "예: 홍길동", "", async (name) => {
        if (!name) return;
        try {
            const r = await api(`/api/classes/${currentClass.id}/students`, { method: "POST", body: { name } });
            showStudentCredentials(r);
            openTeacherClass(currentClass.id);
        } catch (e) { toastErr(e.message); }
    });
}

// 발급된 반 코드 + 학생 ID를 크게 안내
function showStudentCredentials(r) {
    showConfirm(`✅ ${esc(r.name)} 학생 등록 완료`,
        `이 학생의 학생 ID는 ${r.sid} 예요.\n\n위의 “🔗 학생용 응시 링크”를 공유하고, 학생에게 이 학생 ID(${r.sid})를 알려주세요.\n학생은 링크에서 이름과 학생 ID를 넣으면 로그인 없이 응시할 수 있어요.`,
        { okText: "확인" });
}

async function removeStudent(cid, sid, name) {
    if (!await showConfirm("학생 삭제", `'${name}' 학생을 삭제할까요?\n학습·응시 기록이 함께 삭제됩니다.`, { okText: "삭제", danger: true })) return;
    try {
        await api(`/api/classes/${cid}/students/${sid}`, { method: "DELETE" });
        openTeacherClass(cid);
    } catch (e) { toastErr(e.message); }
}

async function assignWordbook() {
    const wid = document.getElementById("assign-wordbook").value;
    if (!wid) return toastErr("배정할 단어장이 없어요. 먼저 단어장을 만들어 주세요.");
    try {
        await api(`/api/classes/${currentClass.id}/assign-wordbook`, { method: "POST", body: { wordbook_id: parseInt(wid) } });
        openTeacherClass(currentClass.id);
    } catch (e) { toastErr(e.message); }
}

async function unassignWordbook(aid) {
    if (!await showConfirm("배정 취소", "이 단어장 배정을 취소할까요?", { okText: "배정 취소", danger: true })) return;
    try {
        await api(`/api/wordbook-assignments/${aid}`, { method: "DELETE" });
        openTeacherClass(currentClass.id);
    } catch (e) { toastErr(e.message); }
}

function renderClassDashboard(data) {
    const el = document.getElementById("ct-dashboard");
    if (!data.roster.length)
        return el.innerHTML = `<div class="empty-state">아직 참여한 학생이 없어요.<br>참여 코드를 학생에게 알려주세요.</div>`;
    // 시험지 배정 전에도 참여한 학생 명단은 항상 보이도록
    if (!data.assignments.length) {
        const list = data.roster.map(s => `
            <div class="roster-item" onclick="openStudentDetail(${currentClass.id}, ${s.student_id})">
                <span class="stu-name stu-link">${esc(s.nickname || s.email)} <span class="stu-arrow">›</span></span>
                <span class="muted">${esc(s.email)}</span>
            </div>`).join("");
        return el.innerHTML = `<p class="muted" style="margin:0 0 10px">참여한 학생 ${data.roster.length}명 · 시험지를 배정하면 점수 매트릭스가 표시됩니다.</p>
            <div class="roster-list">${list}</div>`;
    }
    const head = `<th>학생</th>` + data.assignments.map(a => `<th>${esc(a.exam_name)}</th>`).join("");
    const rows = data.roster.map(s => {
        const cells = data.assignments.map(a => {
            const sc = data.scores[s.student_id]?.[a.exam_id];
            if (!sc) return `<td><span class="cell-none">미응시</span></td>`;
            const cls = sc.best >= 80 ? "hi" : (sc.best >= 50 ? "mid" : "lo");
            return `<td><span class="cell-score ${cls}">${sc.best}%</span> <small>${sc.attempts}회</small></td>`;
        }).join("");
        return `<tr><td class="stu-name stu-link" onclick="openStudentDetail(${currentClass.id}, ${s.student_id})" title="학생 상세 보기">${esc(s.nickname || s.email)} <span class="stu-arrow">›</span></td>${cells}</tr>`;
    }).join("");
    el.innerHTML = `<table class="dash-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

async function assignExam() {
    const examId = document.getElementById("assign-exam").value;
    if (!examId) return toastErr("배정할 시험지가 없어요. 먼저 시험지를 만들어 주세요.");
    try {
        await api(`/api/classes/${currentClass.id}/assign`, { method: "POST", body: { exam_id: parseInt(examId) } });
        openTeacherClass(currentClass.id);
    } catch (e) { toastErr(e.message); }
}

async function unassign(aid) {
    if (!await showConfirm("배정 취소", "이 시험지 배정을 취소할까요?", { okText: "배정 취소", danger: true })) return;
    try {
        await api(`/api/assignments/${aid}`, { method: "DELETE" });
        openTeacherClass(currentClass.id);
    } catch (e) { toastErr(e.message); }
}

async function deleteClass() {
    if (!await showConfirm("반 삭제", `'${currentClass.name}' 반을 삭제할까요?\n학생·배정·기록이 함께 삭제됩니다.`, { okText: "삭제", danger: true })) return;
    try {
        await api(`/api/classes/${currentClass.id}`, { method: "DELETE" });
        navTo("classes");
    } catch (e) { toastErr(e.message); }
}

function copyJoinCode() {
    navigator.clipboard?.writeText(currentClass.join_code).then(
        () => toast("참여 코드를 복사했어요!", "success"), () => {});
}
function copyTakeLink() {
    const link = document.getElementById("ct-take-link").value;
    navigator.clipboard?.writeText(link).then(
        () => toast("학생용 응시 링크를 복사했어요!", "success"), () => {});
}

// ---- 학생 반 상세 ----
async function openStudentClass(cid) {
    try {
        const data = await api(`/api/classes/joined/${cid}`);
        currentClass = { id: cid, name: data.class.name, join_code: "" };
        document.getElementById("cs-name").textContent = data.class.name;
        document.getElementById("cs-teacher").textContent = `${data.class.teacher_name} 선생님`;
        document.getElementById("cs-wordbooks").innerHTML = (data.wordbooks || []).length
            ? data.wordbooks.map(w => `
                <div class="item-card" onclick="studyAssignedWordbook(${cid}, ${w.wordbook_id})">
                    <div class="ic-title">${esc(w.wordbook_name)}</div>
                    <div class="ic-desc">${langLabel(w.language)} · ${w.word_count}단어</div>
                    <div class="ic-meta"><span class="badge accent">▶ 학습하기</span></div>
                </div>`).join("")
            : `<div class="empty-state">아직 배정된 단어장이 없어요.</div>`;
        document.getElementById("cs-assignments").innerHTML = data.assignments.length
            ? data.assignments.map(a => `
                <div class="item-card" onclick="openExam(${a.exam_id})">
                    <div class="ic-title">${esc(a.exam_name)}</div>
                    <div class="ic-desc">${esc(a.format_label)} · ${a.question_count}문항</div>
                    <div class="ic-meta">
                        ${a.my_attempts ? `<span class="badge green">내 최고 ${a.my_best}%</span>`
                                        : `<span class="badge gray">미응시</span>`}
                    </div>
                </div>`).join("")
            : `<div class="empty-state">아직 배정된 시험지가 없어요.</div>`;
        showView("view-class-student");
    } catch (e) { toastErr(e.message); }
}

// 학생: 배정된 단어장 학습
async function studyAssignedWordbook(cid, wid) {
    try {
        const d = await api(`/api/classes/joined/${cid}/wordbook/${wid}/words`);
        if (!d.words || !d.words.length) return toastErr("이 단어장에 단어가 없어요.");
        startFlashcardsWith(d.words, "assigned");
    } catch (e) { toastErr(e.message); }
}

async function leaveClass() {
    if (!await showConfirm("반 나가기", `'${currentClass.name}' 반에서 나갈까요?`, { okText: "나가기", danger: true })) return;
    try {
        await api(`/api/classes/${currentClass.id}/leave`, { method: "POST" });
        navTo("classes");
    } catch (e) { toastErr(e.message); }
}

// ---- 학생 상세 (선생님용 모달) ----
async function openStudentDetail(cid, sid) {
    try {
        const d = await api(`/api/classes/${cid}/students/${sid}`);
        const st = d.student, sm = d.summary;
        document.getElementById("sd-avatar").innerHTML = st.avatar ? `<img src="${st.avatar}" alt="">` : "🙂";
        document.getElementById("sd-name").textContent = st.nickname || st.email;
        document.getElementById("sd-email").textContent = st.sid ? `학생 ID · ${st.sid}` : st.email;
        const kpi = (num, label, cls = "") =>
            `<div class="sd-kpi ${cls}"><div class="sd-kpi-num">${num}</div><div class="sd-kpi-label">${label}</div></div>`;
        const examRows = d.exams.length ? d.exams.map(e => {
            const done = e.best !== null;
            const cls = !done ? "" : (e.best >= 80 ? "hi" : (e.best >= 50 ? "mid" : "lo"));
            const badge = done ? `<span class="ri-score ${cls}">${e.best}%</span>`
                               : `<span class="badge gray">미응시</span>`;
            const hist = e.attempts.length ? `<div class="sd-attempts">${e.attempts.map(a =>
                `<div class="sd-att"><span>${fmtDate(a.created_at)}</span><span>${a.score}% · ${a.correct}/${a.total} · ${fmtTime(a.time_taken)}</span></div>`
            ).join("")}</div>` : "";
            return `<div class="sd-exam">
                <div class="sd-exam-head">
                    <div><b>${esc(e.exam_name)}</b><span class="muted"> · ${esc(e.format_label)} · ${e.question_count}문항</span></div>
                    ${badge}
                </div>${hist}
            </div>`;
        }).join("") : `<div class="empty-state">아직 배정된 시험지가 없어요.</div>`;
        document.getElementById("sd-body").innerHTML = `
            <div class="sd-kpi-row">
                ${kpi(sm.completed + "/" + sm.assigned, "완료한 과제")}
                ${kpi(sm.attempts, "총 응시")}
                ${kpi(sm.avg + "%", "평균 점수", "accent")}
                ${kpi(sm.best + "%", "최고 점수", "accent")}
            </div>
            <div class="chart-card" style="margin:14px 0">
                <h3 style="margin:0 0 10px">📈 점수 추이</h3>
                <div class="trend-chart">${trendChartHTML(d.trend)}</div>
            </div>
            <h3 style="margin:6px 0 10px">📝 과제별 응시 현황</h3>
            <div class="sd-exams">${examRows}</div>`;
        document.getElementById("student-modal").classList.remove("hidden");
    } catch (e) { toastErr(e.message); }
}
function closeStudentDetail(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("student-modal").classList.add("hidden");
}

// ============================================================
// 알림
// ============================================================
let _notifTimer = null;
async function loadNotifications() {
    try {
        const { notifications, unread } = await api("/api/notifications");
        window._notifs = notifications;
        const badge = document.getElementById("notif-badge");
        badge.textContent = unread > 9 ? "9+" : unread;
        badge.classList.toggle("hidden", unread === 0);
        renderNotif(notifications);
    } catch (e) {}
}
function renderNotif(list) {
    const el = document.getElementById("notif-list");
    if (!list || !list.length) {
        el.innerHTML = `<div class="notif-empty">새 알림이 없어요.</div>`;
        return;
    }
    el.innerHTML = list.map(n => `
        <div class="notif-item ${n.is_read ? "" : "unread"}">
            <div class="notif-title">${esc(n.title)}</div>
            ${n.body ? `<div class="notif-body">${esc(n.body)}</div>` : ""}
            <div class="notif-date">${fmtDate(n.created_at)}</div>
        </div>`).join("");
}
async function toggleNotif(e) {
    if (e) e.stopPropagation();
    const panel = document.getElementById("notif-panel");
    const willShow = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !willShow);
    if (willShow) {
        await loadNotifications();
        // 열면 읽음 처리
        try { await api("/api/notifications/read", { method: "POST" }); } catch (_) {}
        document.getElementById("notif-badge").classList.add("hidden");
    }
}
async function clearNotif() {
    try {
        await api("/api/notifications", { method: "DELETE" });
        window._notifs = [];
        renderNotif([]);
        document.getElementById("notif-badge").classList.add("hidden");
    } catch (e) { toastErr(e.message); }
}
// 바깥 클릭 시 알림 패널 / 프로필 메뉴 닫기
document.addEventListener("click", e => {
    const wrap = document.querySelector(".notif-wrap");
    const panel = document.getElementById("notif-panel");
    if (panel && !panel.classList.contains("hidden") && wrap && !wrap.contains(e.target)) {
        panel.classList.add("hidden");
    }
    const pwrap = document.querySelector(".side-profile-wrap");
    const pmenu = document.getElementById("profile-menu");
    if (pmenu && !pmenu.classList.contains("hidden") && pwrap && !pwrap.contains(e.target)) {
        pmenu.classList.add("hidden");
    }
});

// ============================================================
// 업로드 & 추출
// ============================================================
function startUpload() {
    uploadState = { filename: "", pages: 0, words: [], language: "en" };
    resetUpload();
    const en = document.querySelector('input[name="wbLang"][value="en"]');
    if (en) en.checked = true;
    showView("view-upload");
}

function resetUpload() {
    document.getElementById("file-input").value = "";
    document.getElementById("upload-drop").classList.remove("hidden");
    document.getElementById("upload-info").classList.add("hidden");
    document.getElementById("extract-progress").classList.add("hidden");
    document.getElementById("extract-result").classList.add("hidden");
    uploadState.filename = "";
}

function setupUploadArea() {
    const drop = document.getElementById("upload-drop");
    const input = document.getElementById("file-input");
    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", () => handleFile(input.files[0]));
    ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", e => { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
}

async function handleFile(file) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    try {
        const r = await api("/api/upload", { method: "POST", body: form, isForm: true });
        uploadState.filename = r.filename;
        uploadState.pages = r.page_count;
        document.getElementById("up-filename").textContent = r.original_name;
        const isPdf = r.original_name.toLowerCase().endsWith(".pdf");
        document.getElementById("up-pages").textContent = isPdf ? `(${r.page_count}페이지)` : "(이미지)";
        document.getElementById("page-range-row").classList.toggle("hidden", !isPdf);
        document.getElementById("end-page").value = r.page_count || 1;
        document.getElementById("end-page").max = r.page_count || 1;
        document.getElementById("upload-drop").classList.add("hidden");
        document.getElementById("upload-info").classList.remove("hidden");
    } catch (e) { toastErr("업로드 실패: " + e.message); }
}

function selectAllPages() {
    document.getElementById("start-page").value = 1;
    document.getElementById("end-page").value = uploadState.pages || 1;
}

async function startExtract() {
    const start = parseInt(document.getElementById("start-page").value) || 1;
    const end = parseInt(document.getElementById("end-page").value) || 1;
    uploadState.language = document.querySelector('input[name="wbLang"]:checked')?.value || "en";
    uploadState.meaning_lang = document.querySelector('input[name="wbMeaningLang"]:checked')?.value || "ko";
    document.getElementById("upload-info").classList.add("hidden");
    const prog = showProgress("extract");
    try {
        const r = await api("/api/extract-start", { method: "POST", body: { filename: uploadState.filename, start_page: start, end_page: end, language: uploadState.language, meaning_lang: uploadState.meaning_lang } });
        const result = await pollProgress(r.job_id, prog);
        uploadState.words = result.words;
        renderExtractResult(result.words);
    } catch (e) {
        prog.log("🚨 " + e.message);
        toastErr("추출 실패: " + e.message);
        document.getElementById("upload-info").classList.remove("hidden");
    }
}

function renderExtractResult(words) {
    document.getElementById("extract-progress").classList.add("hidden");
    document.getElementById("extract-result").classList.remove("hidden");
    document.getElementById("er-count").textContent = words.length;
    document.getElementById("er-total").textContent = words.length;
    // 각 단어를 체크박스 카드로 표시 (기본 전체 선택). 체크 해제 시 저장에서 제외.
    document.getElementById("er-preview").innerHTML = words.map((w, i) => {
        const reading = w.reading ? `<span class="w-reading">${esc(w.reading)}</span>` : "";
        return `<label class="wc-item">
            <input type="checkbox" class="wc-check" checked data-i="${i}" onchange="updateErSelected()">
            <span class="wc-body">
                <span class="wc-word"><b>${esc(w.word)}</b>${reading}<span class="w-page">P.${w.page || "?"}</span></span>
                <span class="wc-mean">${esc(w.meaning || "")}</span>
            </span>
        </label>`;
    }).join("");
    updateErSelected();
}

function updateErSelected() {
    const checks = document.querySelectorAll("#er-preview .wc-check");
    let n = 0;
    checks.forEach(c => { if (c.checked) n++; c.closest(".wc-item").classList.toggle("excluded", !c.checked); });
    document.getElementById("er-selected").textContent = n;
}

function erSelectAll(state) {
    document.querySelectorAll("#er-preview .wc-check").forEach(c => c.checked = state);
    updateErSelected();
}

async function saveWordbook() {
    const name = document.getElementById("wb-name").value.trim();
    const desc = document.getElementById("wb-desc").value.trim();
    if (!name) return toastErr("단어장 이름을 입력하세요.");
    // 체크된 단어만 저장 (해제한 단어 제외)
    const keepIdx = new Set();
    document.querySelectorAll("#er-preview .wc-check").forEach(c => { if (c.checked) keepIdx.add(+c.dataset.i); });
    const words = uploadState.words.filter((_, i) => keepIdx.has(i));
    if (!words.length) return toastErr("저장할 단어를 1개 이상 선택하세요.");
    try {
        await api("/api/wordbooks", { method: "POST", body: {
            name, description: desc, source_name: uploadState.filename,
            words, language: uploadState.language, meaning_lang: uploadState.meaning_lang || "ko" } });
        document.getElementById("wb-name").value = "";
        document.getElementById("wb-desc").value = "";
        toast("단어장이 저장되었어요!", "success");
        goDashboard();
    } catch (e) { toastErr("저장 실패: " + e.message); }
}

// ============================================================
// 단어장 상세 & 시험지 생성
// ============================================================
async function openWordbook(id) {
    try {
        const { wordbook, words } = await api(`/api/wordbooks/${id}`);
        currentWordbook = { ...wordbook, words };
        document.getElementById("wbd-name").innerHTML =
            `${esc(wordbook.name)} <span class="lang-badge">${langLabel(wordbook.language)}</span>`;
        document.getElementById("wbd-desc").textContent = wordbook.description || "";
        document.getElementById("wbd-words").innerHTML = wordTable(words);
        document.getElementById("wbd-source-btn").classList.toggle("hidden", !wordbook.has_source);
        showView("view-wordbook");
    } catch (e) { toastErr("불러오기 실패: " + e.message); }
}

// 단어 목록 → 깔끔한 표
function wordTable(words) {
    const hasReading = words.some(w => w.reading && w.reading.trim());
    const rows = words.map(w => `
        <tr>
            <td class="wt-num">${w.seq}</td>
            <td class="wt-word">${esc(w.word)}</td>
            ${hasReading ? `<td class="wt-reading">${esc(w.reading || "")}</td>` : ""}
            <td class="wt-mean">${esc(w.meaning || "")}</td>
            <td class="wt-page">P.${w.page || "?"}</td>
        </tr>`).join("");
    return `<table class="word-table-el">
        <thead><tr><th>#</th><th>단어</th>${hasReading ? "<th>발음</th>" : ""}<th>뜻</th><th>페이지</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
}

async function downloadWbSource() {
    if (!currentWordbook) return;
    await downloadPdf(`/api/wordbooks/${currentWordbook.id}/source`, `${currentWordbook.name}_원본`);
}

// 단어장 삭제 확인 문구 (함께 삭제될 시험지 개수 안내)
async function confirmDeleteWordbook(id, name) {
    let examMsg = "이 단어장으로 만든 시험지도 함께 삭제됩니다.";
    try {
        const { exam_count } = await api(`/api/wordbooks/${id}/exam-count`);
        examMsg = exam_count > 0
            ? `⚠️ 이 단어장으로 만든 시험지 ${exam_count}개와 그 응시 기록도 함께 삭제됩니다.`
            : "이 단어장으로 만든 시험지는 없습니다.";
    } catch (e) {}
    return showConfirm("단어장 삭제", `'${name}' 단어장을 삭제할까요?\n\n${examMsg}`, { okText: "삭제", danger: true });
}

async function deleteWordbook() {
    if (!currentWordbook) return;
    if (!await confirmDeleteWordbook(currentWordbook.id, currentWordbook.name)) return;
    try {
        const r = await api(`/api/wordbooks/${currentWordbook.id}`, { method: "DELETE" });
        toast(r.deleted_exams ? `단어장과 시험지 ${r.deleted_exams}개를 삭제했어요.` : "단어장을 삭제했어요.", "success");
        goDashboard();
    } catch (e) { toastErr("삭제 실패: " + e.message); }
}

// 대시보드 카드에서 바로 삭제
async function deleteWordbookById(id, name) {
    if (!await confirmDeleteWordbook(id, name)) return;
    try {
        const r = await api(`/api/wordbooks/${id}`, { method: "DELETE" });
        toast(r.deleted_exams ? `단어장과 시험지 ${r.deleted_exams}개를 삭제했어요.` : "단어장을 삭제했어요.", "success");
        loadStats(); loadWordbooks(); loadExams();
    } catch (e) { toastErr("삭제 실패: " + e.message); }
}

async function deleteExamById(id, name) {
    if (!await showConfirm("시험지 삭제", `'${name}' 시험지를 삭제할까요?\n응시 기록도 함께 삭제됩니다.`, { okText: "삭제", danger: true })) return;
    try {
        await api(`/api/exams/${id}`, { method: "DELETE" });
        loadStats(); loadExams();
    } catch (e) { toastErr("삭제 실패: " + e.message); }
}

// ============================================================
// 시험지 만들기 (단어장 여러 개 선택)
// ============================================================
let ecState = { wordbooks: [], selected: new Set() };

async function startExamCreate() {
    try {
        const { wordbooks } = await api("/api/wordbooks");
        if (!wordbooks.length) return toastErr("먼저 단어장을 만들어주세요.");
        ecState = { wordbooks, selected: new Set() };
        genState = { questions: [], format: "toefl" };
        renderEcWordbooks();
        // 형식/문항수/뜻언어 초기화
        document.querySelectorAll("#view-exam-create .format-card").forEach((c, i) => c.classList.toggle("selected", i === 0));
        document.getElementById("q-count").value = 10;
        document.querySelector('input[name="meaningLang"][value="ko"]').checked = true;
        document.getElementById("gen-progress").classList.add("hidden");
        document.getElementById("gen-result").classList.add("hidden");
        document.getElementById("exam-name").value = "";
        updateEcCount();
        showView("view-exam-create");
    } catch (e) { toastErr(e.message); }
}

function renderEcWordbooks() {
    document.getElementById("ec-wordbooks").innerHTML = ecState.wordbooks.map(wb => `
        <label class="ec-wb ${ecState.selected.has(wb.id) ? "sel" : ""}" data-id="${wb.id}">
            <input type="checkbox" ${ecState.selected.has(wb.id) ? "checked" : ""} onchange="toggleEcWb(${wb.id}, this.checked)">
            <span class="ec-wb-body">
                <b>${esc(wb.name)}</b>
                <span class="ec-wb-meta">${langLabel(wb.language)} · ${wb.word_count}단어</span>
            </span>
        </label>`).join("");
}

function toggleEcWb(id, checked) {
    if (checked) ecState.selected.add(id); else ecState.selected.delete(id);
    document.querySelector(`.ec-wb[data-id="${id}"]`)?.classList.toggle("sel", checked);
    updateEcCount();
}

function updateEcCount() {
    const chosen = ecState.wordbooks.filter(w => ecState.selected.has(w.id));
    const total = chosen.reduce((s, w) => s + (w.word_count || 0), 0);
    document.getElementById("ec-word-count").textContent = total;
    const langs = new Set(chosen.map(w => w.language));
    document.getElementById("ec-wb-note").textContent =
        chosen.length ? `· 단어장 ${chosen.length}개${langs.size > 1 ? " (언어 혼합)" : ""}` : "";
}

function selectFormat(el) {
    el.closest(".format-grid").querySelectorAll(".format-card").forEach(c => c.classList.remove("selected"));
    el.classList.add("selected");
    genState.format = el.dataset.fmt;
}

async function startGenerate() {
    const chosen = ecState.wordbooks.filter(w => ecState.selected.has(w.id));
    if (!chosen.length) return toastErr("단어장을 하나 이상 선택하세요.");
    // 선택한 단어장들의 단어를 모두 모으기
    let allWords = [];
    let language = chosen[0].language || "en";
    try {
        for (const wb of chosen) {
            const { words } = await api(`/api/wordbooks/${wb.id}`);
            allWords = allWords.concat(words);
        }
    } catch (e) { return toastErr("단어를 불러오지 못했어요: " + e.message); }
    if (!allWords.length) return toastErr("선택한 단어장에 단어가 없습니다.");

    const meaningLang = document.querySelector('input[name="meaningLang"]:checked')?.value || "ko";
    const explainLang = document.getElementById("ec-explain-lang")?.value || null;
    const count = Math.min(parseInt(document.getElementById("q-count").value) || 10, allWords.length);
    const payloadWords = allWords.map(w => ({
        word: w.word, reading: w.reading, meaning: w.meaning, definition: w.definition, example: w.example, page: w.page }));
    // 저장 시 연결할 단어장(첫 번째 선택)
    ecState.primaryWb = chosen[0].id;
    document.getElementById("gen-result").classList.add("hidden");
    const prog = showProgress("gen");
    try {
        const r = await api("/api/exams/generate-start", { method: "POST", body: {
            words: payloadWords, format: genState.format, count, language, meaning_lang: meaningLang, explain_lang: explainLang } });
        const result = await pollProgress(r.job_id, prog);
        genState.questions = result.questions;
        document.getElementById("gen-progress").classList.add("hidden");
        document.getElementById("gen-result").classList.remove("hidden");
        document.getElementById("gr-count").textContent = result.questions.length;
    } catch (e) {
        prog.log("🚨 " + e.message);
        document.getElementById("gen-progress").classList.add("hidden");
        toastErr("생성 실패: " + e.message);
        if (e.message.includes("크레딧")) openProfile();
    }
}

async function saveExam() {
    const name = document.getElementById("exam-name").value.trim();
    if (!name) return toastErr("시험지 이름을 입력하세요.");
    if (!genState.questions.length) return toastErr("먼저 시험지를 생성하세요.");
    try {
        await api("/api/exams", { method: "POST", body: {
            name, format: genState.format, questions: genState.questions, wordbook_id: ecState.primaryWb || null } });
        document.getElementById("exam-name").value = "";
        toast("시험지가 저장되었어요!", "success");
        goDashboard();
        switchTab("exams");
    } catch (e) { toastErr("저장 실패: " + e.message); }
}

// ============================================================
// 시험 응시
// ============================================================
async function openExam(id) {
    try {
        const { exam } = await api(`/api/exams/${id}`);
        takeState = { exam, answers: {}, timer: null, elapsed: 0, limit: 0 };
        document.getElementById("take-name").textContent = exam.name;
        document.getElementById("take-format").textContent = `${exam.format_label} · ${exam.question_count}문항`;
        document.getElementById("take-setup").classList.remove("hidden");
        document.getElementById("take-questions").classList.add("hidden");
        document.getElementById("grade-progress").classList.add("hidden");
        document.getElementById("timer").classList.add("hidden");
        loadTakeHistory(id);
        showView("view-take");
    } catch (e) { toastErr("불러오기 실패: " + e.message); }
}

// 시험 시작 화면의 지난 응시 기록 (클릭 시 결과 바로 보기)
async function loadTakeHistory(examId) {
    const el = document.getElementById("take-history");
    el.innerHTML = "";
    try {
        const { attempts } = await api(`/api/exams/${examId}/attempts`);
        if (!attempts.length) return;
        el.innerHTML = `<h3>📜 지난 응시 기록 <span class="hint-text">(클릭하면 틀린 문제까지 바로 확인)</span></h3>` +
            attempts.map(a => {
                const cls = a.score >= 80 ? "hi" : (a.score >= 50 ? "mid" : "lo");
                return `<div class="hist-row" onclick="viewAttempt(${a.id})" style="cursor:pointer">
                    <span>${fmtDate(a.created_at)}</span>
                    <span><span class="ri-score ${cls}">${a.score}%</span> · ${a.correct}/${a.total} · ${fmtTime(a.time_taken)}</span>
                </div>`;
            }).join("");
    } catch (e) {}
}

// 시험 시작 화면에서 시험지 PDF 다운로드 (풀지 않아도)
async function downloadSetupPdf() {
    if (!takeState.exam) return;
    await openPdfModal(takeState.exam.id);
}

function beginExam() {
    const mode = document.querySelector('input[name="timeMode"]:checked').value;
    takeState.limit = mode === "limit" ? (parseInt(document.getElementById("time-min").value) || 10) * 60 : 0;
    takeState.answers = {};
    takeState.elapsed = 0;
    renderQuestions();
    document.getElementById("take-qtotal").textContent = takeState.exam.questions.length;
    updateTakeProgress();
    document.getElementById("take-setup").classList.add("hidden");
    document.getElementById("take-questions").classList.remove("hidden");
    document.getElementById("timer").classList.remove("hidden");
    startTimer();
}

function renderQuestions() {
    const box = document.getElementById("questions-box");
    box.innerHTML = takeState.exam.questions.map((q, i) => {
        if (q.type === "written") {
            return `<div class="q-item q-written" id="q-item-${i}">
                <div class="q-text"><span class="q-num">${i + 1}.</span> ${esc(q.question)}</div>
                <input type="text" placeholder="뜻을 입력하세요" oninput="setAnswer(${i}, this.value)">
            </div>`;
        }
        const labels = ["A", "B", "C", "D", "E"];
        const opts = q.options.map((o, idx) => `
            <label class="q-opt" onclick="chooseOpt(this)">
                <input type="radio" name="q${i}" value="${esc(o)}" onchange="setAnswer(${i}, this.value)">
                <span class="opt-label">${labels[idx]}.</span> ${esc(o)}
            </label>`).join("");
        return `<div class="q-item" id="q-item-${i}">
            <div class="q-text"><span class="q-num">${i + 1}.</span> ${esc(q.question)}</div>
            <div class="q-options">${opts}</div>
        </div>`;
    }).join("");
}

function chooseOpt(label) {
    const group = label.closest(".q-options");
    group.querySelectorAll(".q-opt").forEach(o => o.classList.remove("chosen"));
    label.classList.add("chosen");
}

function setAnswer(idx, val) {
    takeState.answers[idx] = val;
    document.getElementById("q-item-" + idx)?.classList.toggle("answered", !!(val && String(val).trim()));
    updateTakeProgress();
}

function updateTakeProgress() {
    const total = takeState.exam?.questions?.length || 0;
    const answered = Object.values(takeState.answers).filter(v => v && String(v).trim()).length;
    document.getElementById("take-answered").textContent = answered;
    document.getElementById("take-progress-bar").style.width = total ? (answered / total * 100) + "%" : "0%";
}

// 타이머
function startTimer() {
    stopTimer();
    takeState.timer = setInterval(() => {
        takeState.elapsed++;
        let display, remaining;
        const t = document.getElementById("timer");
        if (takeState.limit) {
            remaining = takeState.limit - takeState.elapsed;
            if (remaining <= 0) { submitExam(); return; }
            display = fmtTime(remaining);
            t.classList.toggle("warning", remaining <= 30);
        } else {
            display = fmtTime(takeState.elapsed);
        }
        document.getElementById("timer-val").textContent = display;
    }, 1000);
}
function stopTimer() { if (takeState.timer) { clearInterval(takeState.timer); takeState.timer = null; } }
function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function submitExam() {
    stopTimer();
    document.getElementById("take-questions").classList.add("hidden");
    document.getElementById("timer").classList.add("hidden");
    const prog = showProgress("grade");
    try {
        const r = await api("/api/attempts/grade-start", { method: "POST", body: {
            exam_id: takeState.exam.id, answers: takeState.answers, time_taken: takeState.elapsed } });
        const result = await pollProgress(r.job_id, prog);
        reportState = { examId: takeState.exam.id, attemptId: result.attempt_id };
        renderReport(result, takeState.exam);
    } catch (e) {
        prog.log("🚨 " + e.message);
        toastErr("채점 실패: " + e.message);
    }
}

// ============================================================
// 결과 리포트
// ============================================================
async function renderReport(result, exam) {
    document.getElementById("rep-title").textContent = `📊 ${exam.name} 결과`;
    const circle = document.getElementById("score-circle");
    circle.style.setProperty("--pct", result.score + "%");
    circle.setAttribute("data-score", result.score + "%");
    circle.textContent = "";
    document.getElementById("rep-correct").textContent = result.correct;
    document.getElementById("rep-total").textContent = result.total;

    document.getElementById("rep-detail").innerHTML = result.results.map(r => `
        <div class="rep-q ${r.correct ? "" : "wrong"}">
            <div class="rq-title">Q${r.idx}. ${esc(r.question)}</div>
            <div class="rq-you ${r.correct ? "ok" : "no"}">내 답: ${esc(r.user_ans)} ${r.correct ? "✅" : "❌"}</div>
            ${r.correct ? "" : `<div class="rq-ans">정답: ${esc(r.correct_ans)}</div>`}
            ${r.feedback ? `<div class="rq-fb">💡 ${esc(r.feedback)}</div>` : ""}
        </div>`).join("");

    await loadHistory(exam.id);
    showView("view-report");
}

async function loadHistory(examId) {
    try {
        const { attempts } = await api(`/api/exams/${examId}/attempts`);
        const el = document.getElementById("rep-history");
        if (attempts.length <= 1) { el.innerHTML = ""; return; }
        el.innerHTML = `<h3>📜 응시 기록 (${attempts.length}회)</h3>` + attempts.map(a => `
            <div class="hist-row" onclick="viewAttempt(${a.id})" style="cursor:pointer">
                <span>${fmtDate(a.created_at)}</span>
                <span><span class="h-score">${a.score}%</span> · ${a.correct}/${a.total} · ${fmtTime(a.time_taken)}</span>
            </div>`).join("");
    } catch (e) {}
}

async function viewAttempt(attemptId) {
    try {
        const { attempt } = await api(`/api/attempts/${attemptId}`);
        reportState.attemptId = attemptId;
        renderReport({ score: attempt.score, correct: attempt.correct, total: attempt.total, results: attempt.results }, takeState.exam || { id: attempt.exam_id, name: "시험" });
    } catch (e) { toastErr(e.message); }
}

function retakeExam() {
    if (takeState.exam) openExam(takeState.exam.id);
}

async function downloadExamPdf() { await openPdfModal(reportState.examId); }
async function downloadReportPdf() { await downloadPdf(`/api/attempts/${reportState.attemptId}/pdf`, "report.pdf"); }

async function downloadPdf(path, fallbackName, body = null, method = "POST") {
    try {
        const opts = { method, credentials: "include" };
        if (body) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
        const res = await fetch(path, opts);
        if (!res.ok) {
            let msg = "다운로드 실패";
            try { msg = (await res.json()).detail || msg; } catch (_) {}
            throw new Error(msg);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fallbackName;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    } catch (e) { toastErr(e.message); }
}

// ============================================================
// 시험지 PDF 커스텀 (미리보기 + 옵션)
// ============================================================
let pdfState = { examId: null, exam: null, opts: {} };

async function openPdfModal(id) {
    try {
        const { exam } = await api(`/api/exams/${id}`);
        pdfState = {
            examId: id, exam,
            opts: { title: exam.name, font: "round", font_size: 10, columns: 1,
                    spacing: 8, answer_key: true, header_fields: true, show_school: true },
        };
        document.getElementById("pdf-title").value = exam.name;
        // 세그먼트/체크박스 초기화
        ["pdf-font", "pdf-size", "pdf-cols"].forEach(gid => {
            document.querySelectorAll(`#${gid} button`).forEach(b => b.classList.remove("on"));
        });
        document.querySelector('#pdf-font button[data-v="round"]').classList.add("on");
        document.querySelector('#pdf-size button[data-v="10"]').classList.add("on");
        document.querySelector('#pdf-cols button[data-v="1"]').classList.add("on");
        document.getElementById("pdf-spacing").value = 8;
        document.getElementById("pdf-answerkey").checked = true;
        document.getElementById("pdf-header").checked = true;
        document.getElementById("pdf-school").checked = true;
        // 무료 등급: 옵션 컨트롤만 잠그고, 제목 입력·다운로드는 사용 가능
        const custom = !!CURRENT_USER?.limits?.pdf_custom;
        document.getElementById("pdf-lock").classList.toggle("hidden", custom);
        document.querySelectorAll("#pdf-modal .pdf-seg button, #pdf-spacing, #pdf-answerkey, #pdf-header, #pdf-school")
            .forEach(el => { el.disabled = !custom; });
        document.querySelector(".pdf-options").classList.remove("pdf-locked");
        document.getElementById("pdf-modal").classList.remove("hidden");
        renderPdfPreview();
    } catch (e) { toastErr(e.message); }
}
function closePdfModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("pdf-modal").classList.add("hidden");
}
function pdfSet(key, val, btn) {
    pdfState.opts[key] = val;
    if (btn) { btn.parentElement.querySelectorAll("button").forEach(b => b.classList.remove("on")); btn.classList.add("on"); }
    renderPdfPreview();
}

function renderPdfPreview() {
    const o = pdfState.opts;
    o.title = document.getElementById("pdf-title").value || pdfState.exam.name;
    const qs = pdfState.exam.questions || [];
    const fontFam = { round: "'Gowun Dodum', sans-serif", gothic: "'Nanum Gothic', sans-serif", myeongjo: "'Nanum Myeongjo', serif" }[o.font] || "sans-serif";
    const labels = ["A", "B", "C", "D", "E"];
    const header = `
        <div class="pv-title">${esc(o.title)}</div>
        ${o.show_school ? `<div class="pv-brand">AI Generated by VocaShot</div>` : ""}
        ${o.header_fields ? `<div class="pv-fields">이름: __________  날짜: __________  점수: ______</div>` : ""}`;
    const qHtml = qs.map((q, i) => {
        const opts = (q.type !== "written" && q.options) ? q.options.map((op, idx) =>
            `<div class="pv-opt">${labels[idx]}. ${esc(op)}</div>`).join("") : "";
        const blank = q.type === "written" ? `<div class="pv-blank"></div>` : "";
        return `<div class="pv-q" style="margin-bottom:${o.spacing}px">
            <div class="pv-qtext">${i + 1}. ${esc(q.question)}</div>${opts}${blank}</div>`;
    }).join("");
    const note = o.answer_key ? `<div class="pv-note">＊ 정답·해설은 별도 PDF 파일로 함께 저장됩니다.</div>` : "";
    document.getElementById("pdf-preview").innerHTML = `
        <div class="pv-page ${o.columns === 2 ? "pv-2col" : ""}" style="font-family:${fontFam}; font-size:${o.font_size}px">
            <div class="pv-head">${header}</div>
            <div class="pv-body">${qHtml}</div>
            ${note}
        </div>`;
}

async function downloadCustomPdf() {
    const o = { ...pdfState.opts, title: document.getElementById("pdf-title").value || pdfState.exam.name };
    // 문제지
    await downloadPdf(`/api/exams/${pdfState.examId}/pdf`, `${o.title}.pdf`, { ...o, kind: "quiz" });
    // 정답·해설지 (별도 파일)
    if (o.answer_key) {
        await sleep(400);
        await downloadPdf(`/api/exams/${pdfState.examId}/pdf`, `${o.title}_정답.pdf`, { ...o, kind: "answers" });
        toast("문제지와 정답지 PDF를 각각 저장했어요.", "success");
    }
}

// ============================================================
// 진행바 (재사용)
// ============================================================
function showProgress(prefix) {
    // prefix: extract | gen | grade → 각 화면의 진행바 요소 id 매핑
    const map = {
        extract: { wrap: "extract-progress", msg: "ep-msg", pct: "ep-pct", bar: "ep-bar", log: "ep-log" },
        gen: { wrap: "gen-progress", msg: "gp-msg", pct: "gp-pct", bar: "gp-bar", log: "gp-log" },
        grade: { wrap: "grade-progress", msg: "grp-msg", pct: "grp-pct", bar: "grp-bar", log: "grp-log" },
    };
    const ids = map[prefix];
    const wrap = document.getElementById(ids.wrap);
    wrap.classList.remove("hidden");
    const logEl = document.getElementById(ids.log);
    logEl.innerHTML = "";
    return {
        set(pct, msg) {
            document.getElementById(ids.bar).style.width = pct + "%";
            document.getElementById(ids.pct).textContent = pct + "%";
            if (msg) document.getElementById(ids.msg).textContent = msg;
        },
        log(line) {
            const d = document.createElement("div");
            d.className = "log-line";
            d.textContent = line;
            logEl.appendChild(d);
            logEl.scrollTop = logEl.scrollHeight;
        },
    };
}

// job_id 를 폴링해 진행바를 갱신, 완료 시 result 반환
async function pollProgress(jobId, prog) {
    let seenLogs = 0;
    while (true) {
        await sleep(600);
        let job;
        try { job = await api(`/api/progress/${jobId}`); }
        catch (e) { continue; }
        prog.set(job.percent, job.message);
        if (job.logs && job.logs.length > seenLogs) {
            for (let i = seenLogs; i < job.logs.length; i++) prog.log(job.logs[i]);
            seenLogs = job.logs.length;
        }
        if (job.status === "done") return job.result;
        if (job.status === "error") throw new Error(job.error || "작업 실패");
    }
}

// ============================================================
// 다크 모드
// ============================================================
// ---- 모노크롬 라인 아이콘 (currentColor → 흑/백 자동) ----
const _svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
    home: _svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
    book: _svg('<path d="M5 4a2 2 0 0 1 2-2h12v18H7a2 2 0 0 0-2 2z"/><path d="M5 20a2 2 0 0 1 2-2h12"/>'),
    doc: _svg('<path d="M7 2h7l4 4v16H7z"/><path d="M14 2v4h4"/><path d="M10 13h5"/><path d="M10 17h5"/>'),
    calendar: _svg('<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18"/><path d="M8 2.5v4"/><path d="M16 2.5v4"/>'),
    users: _svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16.5 5.3a3 3 0 0 1 0 5.4"/><path d="M18.5 20c0-2.2-.9-4.1-2.3-5.4"/>'),
    bell: _svg('<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
    gear: _svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V15a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    moon: _svg('<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>'),
    sun: _svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2 7 7M17 17l1.8 1.8M5.2 18.8 7 17M17 7l1.8-1.8"/>'),
    repeat: _svg('<path d="M17 2l3.5 3.5L17 9"/><path d="M3.5 11V9a3.5 3.5 0 0 1 3.5-3.5h13.5"/><path d="M7 22l-3.5-3.5L7 15"/><path d="M20.5 13v2a3.5 3.5 0 0 1-3.5 3.5H3.5"/>'),
    chevron: _svg('<path d="M9 5l7 7-7 7"/>'),
    report: _svg('<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/><path d="M9 13v4M12 11v6M15 14v3"/>'),
};
function applyIcons(root = document) {
    root.querySelectorAll("[data-icon]").forEach(el => {
        const name = el.dataset.icon;
        if (ICONS[name]) el.innerHTML = ICONS[name];
    });
}

// ---- 화면 언어(i18n) ----
const I18N = {
    "nav.dashboard": { ko: "대시보드", en: "Dashboard", zh: "仪表盘", ja: "ダッシュボード" },
    "nav.wordbooks": { ko: "내 단어장", en: "My Wordbooks", zh: "我的单词本", ja: "単語帳" },
    "nav.exams": { ko: "내 시험지", en: "My Exams", zh: "我的试卷", ja: "テスト" },
    "nav.planner": { ko: "플래너", en: "Planner", zh: "计划", ja: "プランナー" },
    "nav.classes": { ko: "반", en: "Classes", zh: "班级", ja: "クラス" },
    "nav.usage": { ko: "사용량", en: "Usage", zh: "用量", ja: "使用量" },
    "nav.settings": { ko: "설정", en: "Settings", zh: "设置", ja: "設定" },
    "dash.today": { ko: "오늘 할 일", en: "Today's Tasks", zh: "今日任务", ja: "今日のタスク" },
    "dash.share": { ko: "공유", en: "Share", zh: "分享", ja: "共有" },
};
// 화면 언어는 한국어로 고정(잠금). i18n 커버리지 미완성으로 전환 기능 비활성화.
function uiLang() { return "ko"; }
function applyI18n(lang = "ko") {
    document.querySelectorAll("[data-i18n]").forEach(el => {
        const dict = I18N[el.dataset.i18n];
        if (dict && dict.ko) el.textContent = dict.ko;
    });
}
function setUiLang() { /* 잠금: 화면 언어 전환 비활성화 */ }

function initTheme() {
    // 저장된 설정 우선, 없으면 시스템 설정 따름
    const saved = localStorage.getItem("theme");
    const theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    applyTheme(theme);
}
function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    // 테마 토글 버튼 아이콘 (모노크롬 SVG)
    document.querySelectorAll(".theme-toggle-btn").forEach(btn => {
        btn.innerHTML = theme === "dark" ? ICONS.sun : ICONS.moon;
    });
    // 로고 전환: 투명 로고라 밝은/어두운 배경 모두 대응 (동일 파일)
    const logo = (theme === "dark" ? "VocaShot_Logo_Dark.png" : "VocaShot_Logo_Light.png") + "?v=3";
    document.querySelectorAll(".auth-logo, .topbar-logo").forEach(img => { img.src = logo; });
}
function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    applyTheme(next);
}

// ============================================================
// 프로필 & 등급
// ============================================================
// 정보수정 (프로필 사진 · 닉네임) — 프로필 드롭다운에서 진입
function openEditProfile() {
    const u = CURRENT_USER;
    document.getElementById("profile-menu").classList.add("hidden");
    document.getElementById("profile-nickname").value = u.nickname || "";
    const av = document.getElementById("profile-avatar");
    av.innerHTML = u.avatar ? `<img src="${u.avatar}" alt="">` : "🙂";
    document.getElementById("edit-profile-modal").classList.remove("hidden");
}
function closeEditProfile(e) {
    if (e && e.target !== e.currentTarget && e.type === "click" && e.target.closest(".modal-card")) return;
    document.getElementById("edit-profile-modal").classList.add("hidden");
}

function openProfile() {
    const u = CURRENT_USER;
    const pref = document.getElementById("pref-explain-lang");
    if (pref) pref.value = u.explain_lang || "ko";
    renderExplainLangPicker(u.explain_lang || "ko");
    renderTierPanel();
    document.getElementById("profile-modal").classList.remove("hidden");
}

// 문제·해설 언어: 플래그 칩 선택 UI
const EXPLAIN_LANGS = [
    { v: "ko", flag: "🇰🇷", name: "한국어" }, { v: "en", flag: "🇺🇸", name: "English" },
    { v: "ja", flag: "🇯🇵", name: "日本語" }, { v: "zh", flag: "🇨🇳", name: "中文" },
    { v: "es", flag: "🇪🇸", name: "Español" }, { v: "fr", flag: "🇫🇷", name: "Français" },
    { v: "de", flag: "🇩🇪", name: "Deutsch" },
];
function renderExplainLangPicker(current) {
    const box = document.getElementById("explain-lang-picker");
    if (!box) return;
    box.innerHTML = EXPLAIN_LANGS.map(l => `
        <button type="button" class="lang-chip ${l.v === current ? "on" : ""}" data-lang="${l.v}" onclick="pickExplainLang('${l.v}')">
            <span class="lc-flag">${l.flag}</span><span class="lc-name">${l.name}</span>
        </button>`).join("");
}
function pickExplainLang(v) {
    document.getElementById("pref-explain-lang").value = v;
    document.querySelectorAll("#explain-lang-picker .lang-chip").forEach(c =>
        c.classList.toggle("on", c.dataset.lang === v));
    savePrefs();
}

async function savePrefs() {
    const lang = document.getElementById("pref-explain-lang").value;
    try {
        await api("/api/profile/prefs", { method: "POST", body: { explain_lang: lang } });
        CURRENT_USER.explain_lang = lang;
        toast("문제·해설 언어가 저장되었어요.", "success");
    } catch (e) { toastErr(e.message); }
}
function closeProfile(e) {
    if (e && e.target !== e.currentTarget && e.type === "click" && e.target.closest(".modal-card")) return;
    document.getElementById("profile-modal").classList.add("hidden");
}

const TIER_INFO = {
    basic:   { label: "무료",    price: "₩0",        blurb: "단어장 3개 · AI 크레딧 50/월", feats: ["단어장 3개 · 시험지 10개", "AI 크레딧 50/월", "1회 추출 10p · 문제 15문항", "PDF (워터마크)", "반 참여 가능"] },
    premium: { label: "프리미엄", price: "₩4,900/월",  sub: "연 ₩39,900 (월 ₩3,325)", blurb: "무제한 단어장 · 크레딧 600/월", feats: ["무제한 단어장·시험지", "AI 크레딧 600/월", "추출 50p · 문제 50문항", "PDF 커스텀 · 워터마크 제거", "AI 예문 첨삭 · 망각곡선 플래너"] },
    teacher: { label: "선생님 Basic", price: "₩12,900/월", sub: "연 ₩99,000 (월 ₩8,250)", blurb: "반 5개·40명 · 크레딧 2,500/월", feats: ["프리미엄 모든 기능", "AI 크레딧 2,500/월", "반 5개 · 반당 40명", "학생 대시보드 · 과제 배정", "추출 100p · 문제 100문항"] },
    teacher_pro: { label: "선생님 Pro", price: "₩29,900/월", sub: "연 ₩299,000 (월 ₩24,900)", blurb: "반 20개·60명 · 크레딧 6,000/월", feats: ["선생님 Basic 모든 기능", "AI 크레딧 6,000/월", "반 20개 · 반당 60명", "1회 추출 200p", "문의 우선 응대 · 신규 기능 우선 제공"] },
};

// 애드온(일회성 구매) 카탈로그 — 백엔드 ADDONS와 동일
const ADDON_INFO = {
    credits:  { label: "AI 크레딧 팩", unit: "500 크레딧", price: "₩4,900", icon: "⚡" },
    classes:  { label: "반 슬롯",     unit: "반 +1",      price: "₩3,900", icon: "🏫" },
    students: { label: "학생 슬롯",   unit: "학생 +10",   price: "₩3,900", icon: "👥" },
};

// 사이드바 하단: 사용량(작게) + 요금제(등급·혜택·업그레이드)
function renderSideMeta() {
    const u = CURRENT_USER;
    if (!u) return;
    const lim = u.limits || {}, use = u.usage || {}, tier = u.tier || "basic";
    const info = TIER_INFO[tier] || TIER_INFO.basic;
    const bar = (label, used, max) => {
        const unlimited = (max || 0) >= 9999;
        const pct = unlimited ? 8 : Math.min(100, Math.round((used || 0) / (max || 1) * 100));
        return `<div class="su-item">
            <div class="su-label"><span>${label}</span><span>${used || 0}<i>/${unlimited ? "∞" : max}</i></span></div>
            <div class="su-track"><div class="su-fill" style="width:${pct}%"></div></div>
        </div>`;
    };
    const su = document.getElementById("side-usage");
    if (su) su.innerHTML =
        bar("단어장", use.wordbooks, lim.wordbooks) +
        bar("시험지", use.exams, lim.exams) +
        bar("AI 크레딧", use.ai_credits || 0, lim.ai_credits || 50);

    const st = document.getElementById("side-tier");
    if (st) {
        // 각 라인의 최상위 등급(프리미엄·선생님 Pro)은 업그레이드 버튼 숨김
        const hideUpgrade = tier === "premium" || tier === "teacher_pro";
        st.innerHTML = `
            <div class="st-info">
                <span class="tier-badge ${tier}">${info.label}</span>
                <span class="st-blurb">${info.blurb}</span>
            </div>
            ${hideUpgrade ? "" : `<button class="st-up" onclick="openProfile()">업그레이드</button>`}`;
    }
}

// 사용량 모달 (메뉴바 진입)
function openUsage() { renderUsage(); document.getElementById("usage-modal").classList.remove("hidden"); }
function closeUsage(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("usage-modal").classList.add("hidden");
}
function renderUsage() {
    const u = CURRENT_USER;
    const badge = document.getElementById("profile-tier");
    if (badge) { badge.textContent = TIER_INFO[u.tier]?.label || "무료"; badge.className = "tier-badge " + (u.tier || "basic"); }
    const lim = u.limits, use = u.usage;
    const bar = (label, used, max, unit = "") => {
        const unlimited = max >= 9999;
        const pct = unlimited ? 6 : Math.min(100, Math.round(used / max * 100));
        return `<div class="usage-item">
            <div class="usage-label"><span>${label}</span><span>${used} / ${unlimited ? "무제한" : max}${unit}</span></div>
            <div class="usage-track"><div class="usage-fill" style="width:${pct}%"></div></div>
        </div>`;
    };
    const box = document.getElementById("usage-box");
    if (box) box.innerHTML =
        bar("단어장", use.wordbooks, lim.wordbooks) + bar("시험지", use.exams, lim.exams) +
        bar("AI 크레딧 (이번 달)", use.ai_credits || 0, lim.ai_credits || 50);
}

function renderTierPanel() {
    const u = CURRENT_USER;
    // 요금제 카드 (선생님 Basic/Pro 세분화)
    document.getElementById("tier-cards").innerHTML = ["basic", "premium", "teacher", "teacher_pro"].map(t => {
        const info = TIER_INFO[t], cur = u.tier === t;
        const cta = cur ? `<div class="tc2-current">✓ 현재 등급</div>`
            : `<button class="tc2-btn ${t}" onclick="setTier('${t}')">${t === "basic" ? "기본으로 전환" : "이 등급으로 전환"}</button>`;
        return `<div class="tier-card2 ${t} ${cur ? "current" : ""}">
            <div class="tc2-head"><span class="tc2-name">${info.label}</span><span class="tc2-price">${info.price}</span>
                ${info.sub ? `<span class="tc2-sub">${info.sub}</span>` : ""}</div>
            <ul class="tc2-feats">${info.feats.map(f => `<li>${f}</li>`).join("")}</ul>
            ${cta}
        </div>`;
    }).join("");
    renderAddons();
}

// 애드온(일회성 구매) 렌더 + 구매
function renderAddons() {
    const box = document.getElementById("addon-cards");
    if (!box) return;
    const lim = CURRENT_USER?.limits || {};
    const isTeacher = !!lim.can_create_class;
    const owned = { credits: lim.addon_credits || 0, classes: lim.addon_classes || 0, students: lim.addon_students || 0 };
    // 반·학생 슬롯은 선생님 계정에게만 노출
    const kinds = isTeacher ? ["credits", "classes", "students"] : ["credits"];
    box.innerHTML = kinds.map(k => ADDON_INFO[k] && [k, ADDON_INFO[k]]).filter(Boolean).map(([k, a]) => `
        <div class="addon-card">
            <div class="addon-ico">${a.icon}</div>
            <div class="addon-body">
                <div class="addon-name">${a.label} <span class="addon-unit">${a.unit}</span></div>
                <div class="addon-owned">${owned[k] ? `보유 +${owned[k]}` : "미보유"}</div>
            </div>
            <button class="tc2-btn premium" onclick="buyAddon('${k}')">${a.price} 구매</button>
        </div>`).join("");
}

async function buyAddon(kind) {
    const a = ADDON_INFO[kind];
    if (!await showConfirm("추가 구매 (데모)", `${a.label} (${a.unit})을(를) ${a.price}에 구매할까요?\n\n※ 데모 — 실제 결제 없이 한도가 즉시 늘어납니다.`, { okText: "구매" })) return;
    try {
        const r = await api("/api/addons/buy", { method: "POST", body: { kind } });
        CURRENT_USER.limits = r.limits;
        renderUserChip();
        renderAddons();
        toast(`${a.label} 구매 완료! 한도가 늘어났어요.`, "success");
    } catch (e) { toastErr(e.message); }
}

async function saveProfile() {
    const nickname = document.getElementById("profile-nickname").value.trim();
    if (!nickname) return toastErr("닉네임을 입력하세요.");
    try {
        await api("/api/profile", { method: "POST", body: { nickname } });
        CURRENT_USER.nickname = nickname;
        renderUserChip();
        const greet = document.getElementById("dash-greeting");
        if (greet) greet.innerHTML = pickGreeting();
        closeEditProfile();
        toast("프로필이 저장되었어요.", "success");
    } catch (e) { toast(e.message, "error"); }
}

// 파일 선택 → 크롭 모달 열기 (직접 업로드 대신 편집 단계 추가)
function uploadAvatar() {
    const input = document.getElementById("avatar-input");
    const file = input.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toastErr("이미지가 너무 큽니다 (8MB 이하)."); input.value = ""; return; }
    const reader = new FileReader();
    reader.onload = e => openCrop(e.target.result);
    reader.readAsDataURL(file);
    input.value = "";
}

// ---- 크롭/리사이즈 ----
let cropState = { img: null, scale: 1, minScale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

function openCrop(src) {
    const img = new Image();
    img.onload = () => {
        const c = document.getElementById("crop-canvas");
        const size = c.width; // 280
        cropState.img = img;
        cropState.minScale = Math.max(size / img.width, size / img.height);
        cropState.scale = cropState.minScale;
        cropState.x = (size - img.width * cropState.scale) / 2;
        cropState.y = (size - img.height * cropState.scale) / 2;
        document.getElementById("crop-zoom").value = 1;
        drawCrop();
        document.getElementById("crop-modal").classList.remove("hidden");
    };
    img.src = src;
}
function closeCrop() { document.getElementById("crop-modal").classList.add("hidden"); }

function drawCrop() {
    const c = document.getElementById("crop-canvas");
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    const im = cropState.img;
    ctx.drawImage(im, cropState.x, cropState.y, im.width * cropState.scale, im.height * cropState.scale);
}
function clampCrop() {
    const size = document.getElementById("crop-canvas").width;
    const w = cropState.img.width * cropState.scale, h = cropState.img.height * cropState.scale;
    cropState.x = Math.min(0, Math.max(size - w, cropState.x));
    cropState.y = Math.min(0, Math.max(size - h, cropState.y));
}
function cropZoom() {
    const zoom = parseFloat(document.getElementById("crop-zoom").value);
    const size = document.getElementById("crop-canvas").width;
    const newScale = cropState.minScale * zoom;
    const cx = size / 2, cy = size / 2, ratio = newScale / cropState.scale;
    cropState.x = cx - (cx - cropState.x) * ratio;
    cropState.y = cy - (cy - cropState.y) * ratio;
    cropState.scale = newScale;
    clampCrop();
    drawCrop();
}

function setupCrop() {
    const c = document.getElementById("crop-canvas");
    const factor = () => c.width / c.getBoundingClientRect().width;
    c.addEventListener("pointerdown", e => {
        cropState.dragging = true; cropState.lastX = e.clientX; cropState.lastY = e.clientY;
        c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", e => {
        if (!cropState.dragging) return;
        const f = factor();
        cropState.x += (e.clientX - cropState.lastX) * f;
        cropState.y += (e.clientY - cropState.lastY) * f;
        cropState.lastX = e.clientX; cropState.lastY = e.clientY;
        clampCrop(); drawCrop();
    });
    c.addEventListener("pointerup", () => cropState.dragging = false);
    c.addEventListener("pointercancel", () => cropState.dragging = false);
    document.getElementById("crop-zoom").addEventListener("input", cropZoom);
}

async function applyCrop() {
    const c = document.getElementById("crop-canvas");
    const size = c.width, out = 256, r = out / size;
    const canvas = document.createElement("canvas");
    canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext("2d");
    const im = cropState.img;
    ctx.drawImage(im, cropState.x * r, cropState.y * r, im.width * cropState.scale * r, im.height * cropState.scale * r);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    try {
        const res = await api("/api/profile/avatar-crop", { method: "POST", body: { avatar: dataUrl } });
        CURRENT_USER.avatar = res.avatar;
        document.getElementById("profile-avatar").innerHTML = `<img src="${res.avatar}" alt="">`;
        renderUserChip();
        closeCrop();
    } catch (e) { toastErr(e.message); }
}

// ---- 학부모 리포트 공유 ----
let _sharePath = null;
function showShare(path) {
    _sharePath = path || null;
    const active = document.getElementById("share-active");
    const inactive = document.getElementById("share-inactive");
    const status = document.getElementById("share-status");
    if (!active) return;
    if (path) {
        document.getElementById("share-url").value = location.origin + path;
        active.classList.remove("hidden");
        inactive.classList.add("hidden");
        if (status) { status.textContent = "공유 중"; status.className = "share-status on"; }
    } else {
        active.classList.add("hidden");
        inactive.classList.remove("hidden");
        if (status) { status.textContent = "공유 안 함"; status.className = "share-status off"; }
    }
}
async function downloadShareReport() {
    await downloadPdf("/api/report/pdf", "학습리포트.pdf");
}
async function loadShare() {
    try {
        const r = await api("/api/report/share");
        showShare(r.path);
    } catch (e) { showShare(null); }
}
async function createShare() {
    try {
        const r = await api("/api/report/share", { method: "POST" });
        showShare(r.path);
    } catch (e) { toastErr(e.message); }
}
async function revokeShare() {
    if (!await showConfirm("공유 중단", "공유를 중단할까요?\n기존 링크는 더 이상 열리지 않습니다.", { okText: "공유 중단", danger: true })) return;
    try {
        await api("/api/report/share", { method: "DELETE" });
        showShare(null);
    } catch (e) { toastErr(e.message); }
}
function copyShare() {
    const input = document.getElementById("share-url");
    input.select();
    navigator.clipboard?.writeText(input.value).then(
        () => toast("링크를 복사했어요!", "success"),
        () => { document.execCommand("copy"); toast("링크를 복사했어요!", "success"); }
    );
}

async function resetStats() {
    if (!await showConfirm("통계 초기화", "정말 통계를 초기화할까요?\n응시 기록과 복습 숙련도가 모두 삭제됩니다.\n(단어장·시험지는 유지)", { okText: "초기화", danger: true })) return;
    try {
        await api("/api/stats/reset", { method: "POST" });
        toast("통계가 초기화되었습니다.", "success");
        document.getElementById("profile-modal").classList.add("hidden");
        goDashboard();
    } catch (e) { toastErr(e.message); }
}

async function setTier(tier) {
    try {
        await api("/api/tier", { method: "POST", body: { tier } });
        CURRENT_USER = await api("/api/me");   // 한도까지 최신화
        renderUserChip();
        applyRoleNav();                        // 선생님↔일반 전환 시 플래너·반 메뉴 갱신
        navTo("dashboard");                    // 대시보드(선생님/개인) 다시 렌더
        renderTierPanel();
        toast(`${TIER_INFO[tier]?.label || tier} 등급으로 전환됐어요!`, "success");
    } catch (e) { toast(e.message, "error"); }
}

// ---- 비밀번호 변경 (설정) ----
function checkPwChangeRules() {
    const pw = document.getElementById("pw-new").value;
    const rules = {
        len: pw.length >= 6 && pw.length <= 15,
        alpha: /[A-Za-z]/.test(pw),
        num: /[0-9]/.test(pw),
        special: /[^A-Za-z0-9]/.test(pw),
    };
    document.querySelectorAll("#pw-change-rules li").forEach(li =>
        li.classList.toggle("ok", rules[li.dataset.rule]));
    return Object.values(rules).every(Boolean);
}

async function changePassword() {
    const cur = document.getElementById("pw-current").value;
    const nw = document.getElementById("pw-new").value;
    const cf = document.getElementById("pw-confirm").value;
    if (!cur || !nw) return toastErr("현재 비밀번호와 새 비밀번호를 입력하세요.");
    if (!checkPwChangeRules()) return toastErr("새 비밀번호가 요구사항을 충족하지 않습니다.");
    if (nw !== cf) return toastErr("새 비밀번호 확인이 일치하지 않습니다.");
    try {
        await api("/api/profile/password", { method: "POST", body: { current: cur, new: nw } });
        document.getElementById("pw-current").value = "";
        document.getElementById("pw-new").value = "";
        document.getElementById("pw-confirm").value = "";
        checkPwChangeRules();
        toast("비밀번호가 변경되었어요.", "success");
    } catch (e) { toastErr(e.message); }
}

// 회원가입 비밀번호 규칙 실시간 표시
function checkPwRules() {
    const pw = document.getElementById("signup-password").value;
    const rules = {
        len: pw.length >= 6 && pw.length <= 15,
        alpha: /[A-Za-z]/.test(pw),
        num: /[0-9]/.test(pw),
        special: /[^A-Za-z0-9]/.test(pw),
    };
    document.querySelectorAll("#pw-rules li").forEach(li => {
        li.classList.toggle("ok", rules[li.dataset.rule]);
    });
    return Object.values(rules).every(Boolean);
}

// ============================================================
// UI 헬퍼 — 토스트 & 입력 모달
// ============================================================
// 에러/안내용 팝업 토스트 (기존 alert 대체)
function toastErr(msg) { toast(msg, "error"); }

// ---- 확인 팝업 모달 (기존 confirm 대체) ----
let _confirmResolve = null;
function showConfirm(title, message, { okText = "확인", danger = false } = {}) {
    return new Promise(resolve => {
        document.getElementById("cm-title").textContent = title;
        document.getElementById("cm-msg").textContent = message;
        const ok = document.getElementById("cm-ok");
        ok.textContent = okText;
        ok.className = danger ? "btn-danger" : "btn-primary";
        _confirmResolve = resolve;
        document.getElementById("confirm-modal").classList.remove("hidden");
    });
}
function _finishConfirm(result) {
    document.getElementById("confirm-modal").classList.add("hidden");
    const r = _confirmResolve; _confirmResolve = null;
    if (r) r(result);
}
function cancelConfirmModal(e) {
    if (e && e.target !== e.currentTarget) return;
    _finishConfirm(false);
}
function okConfirmModal() { _finishConfirm(true); }

function toast(msg, type = "info") {
    const c = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    c.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 2800);
}

let _inputModalCb = null;
function openInputModal(title, desc, placeholder, value, cb) {
    document.getElementById("im-title").textContent = title;
    document.getElementById("im-desc").textContent = desc || "";
    const input = document.getElementById("im-input");
    input.placeholder = placeholder || "";
    input.value = value || "";
    _inputModalCb = cb;
    document.getElementById("input-modal").classList.remove("hidden");
    setTimeout(() => input.focus(), 50);
}
function closeInputModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("input-modal").classList.add("hidden");
    _inputModalCb = null;
}
function submitInputModal() {
    const v = document.getElementById("im-input").value.trim();
    const cb = _inputModalCb;
    document.getElementById("input-modal").classList.add("hidden");
    _inputModalCb = null;
    if (cb) cb(v);
}

// ============================================================
// 유틸
// ============================================================
function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// 인라인 onclick 핸들러에 문자열을 안전하게 넣기 위한 JS 리터럴 인코딩
function jsStr(s) {
    return JSON.stringify(String(s == null ? "" : s)).replace(/</g, "\\u003c");
}
// 객체/배열을 작은따옴표 HTML 속성 안 인라인 핸들러에 안전하게 넣기
function jsAttr(obj) {
    return JSON.stringify(obj)
        .replace(/&/g, "&amp;").replace(/</g, "\\u003c")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const LANG_LABELS = { en: "🇺🇸 영어", zh: "🇨🇳 중국어", ja: "🇯🇵 일본어", es: "🇪🇸 스페인어", fr: "🇫🇷 프랑스어", de: "🇩🇪 독일어" };
function langLabel(lang) { return LANG_LABELS[lang] || "🇺🇸 영어"; }
function wordRow(w) {
    const reading = w.reading ? `<span class="w-reading">${esc(w.reading)}</span>` : "";
    return `<div class="word-row">
        <span class="w-left"><span class="w-num">${w.seq}.</span><b>${esc(w.word)}</b>${reading}<span class="w-page">P.${w.page || "?"}</span></span>
        <span class="w-mean">${esc(w.meaning || "")}</span>
    </div>`;
}
function fmtDate(iso) {
    try {
        const d = new Date(iso);
        const p = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (e) { return iso; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 부팅 ----------
document.addEventListener("DOMContentLoaded", () => {
    applyIcons();
    applyI18n();
    initTheme();
    setupUploadArea();
    setupCrop();
    init();
    // Enter 키로 로그인/인증 편의
    document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
    document.getElementById("verify-code").addEventListener("keydown", e => { if (e.key === "Enter") doVerify(); });
});
