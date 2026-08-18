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
    ["view-dashboard", "view-upload", "view-wordbook", "view-exam-create", "view-take", "view-report",
     "view-flashcards", "view-game", "view-cover", "view-dictation", "view-speed", "view-chat", "view-admin"]
        .forEach(v => document.getElementById(v).classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
    // 게임 화면을 벗어나면 타이머 정지
    if (id !== "view-game" && typeof gameState !== "undefined" && gameState.timer) {
        clearInterval(gameState.timer);
    }
    document.getElementById("report-fab")?.classList.toggle("hidden", id !== "view-report"); // 리포트에서만 신고 버튼
    window.scrollTo(0, 0);
}

function goDashboard() {
    navTo("dashboard");
}

// 사이드바 내비게이션: dashboard(개요) | wordbooks | exams
function navTo(section) {
    stopTimer();
    document.querySelectorAll(".side-link").forEach(l => l.classList.remove("active"));
    document.querySelector(`.side-link[data-nav="${section}"]`)?.classList.add("active");
    showView("view-dashboard");
    const isDash = section === "dashboard";
    document.querySelector(".dash-stats").classList.toggle("hidden", !isDash);
    ["wordbooks", "exams"].forEach(t =>
        document.getElementById("tab-" + t).classList.toggle("hidden", isDash || t !== section));
    if (isDash) loadStats();
    else switchTab(section);
    maybeShowLLMBanner();
    window.scrollTo(0, 0);
}

// ===== 온디바이스 AI 다운로드 배너 (메인 상단) =====
let _llmBannerDismissed = false;
function maybeShowLLMBanner() {
    const banner = document.getElementById("llm-banner");
    if (!banner) return;
    const supported = window.hasWebGPU && window.hasWebGPU();       // WebGPU 되는 기기만
    const ready = window.isOnDeviceAIReady && window.isOnDeviceAIReady(); // 이미 받았나
    const show = supported && !ready && !_llmBannerDismissed;
    banner.classList.toggle("hidden", !show);
}
async function downloadLLM() {
    const ok = await window.prepareOnDeviceAI(); // 로딩 오버레이 뜨고 모델 다운로드
    if (ok) {
        toast("온디바이스 AI 준비 완료! 🎉", "success");
        document.getElementById("llm-banner")?.classList.add("hidden");
    } else {
        toastErr("온디바이스 AI를 불러오지 못했어요. 채점 시 서버로 진행돼요.");
    }
    updateModeStatus();       // 배지 갱신 (Gemini → 온디바이스)
    renderOnDeviceSettings(); // 설정 버튼 갱신 (다운로드 → 삭제)
}
function dismissLLMBanner() {
    _llmBannerDismissed = true; // 이번 세션 동안만 숨김
    document.getElementById("llm-banner")?.classList.add("hidden");
}

// ===== 채점 모드 상태 표시 (읽기 전용) — 우측 상단 =====
// WebGPU 지원 기기면 온디바이스(무료·무제한), 아니면 Gemini(서버·유료 → 하루 한도).
let gradeConfig = { gemini_daily_limit: null, gemini_used_today: null };
async function loadGradeConfig() {
    try { gradeConfig = await api("/api/grade-config"); } catch (_) {}
    updateModeStatus();
}
// 온디바이스가 '실제로 준비(다운로드)됐는지' — 배지·채점·설정이 이걸 기준으로 함
function isOnDeviceReady() {
    return !!navigator.gpu && window.isOnDeviceAIReady && window.isOnDeviceAIReady();
}
function updateModeStatus() {
    const el = document.getElementById("mode-status");
    if (!el) return;
    el.removeAttribute("title"); // 네이티브 툴팁 대신 커스텀 인앱 팝업 사용
    if (isOnDeviceReady()) {
        el.className = "mode-status ondevice";
        el.innerHTML = `<span class="ms-label">🧠 온디바이스 AI</span>
            <div class="mode-tip">
                <b>🧠 온디바이스 AI</b>
                <ul><li>답안이 이 기기 밖으로 나가지 않아요 (비공개)</li>
                    <li>무료이고 사용 제한이 없어요</li></ul>
            </div>`;
    } else {
        el.className = "mode-status gemini";
        const lim = gradeConfig.gemini_daily_limit, used = gradeConfig.gemini_used_today;
        const limTxt = (lim != null) ? `하루 ${lim}문제 제한 (오늘 ${used ?? 0}문제 사용)` : "하루 사용량 제한이 있어요";
        const rec = navigator.gpu
            ? "온디바이스 AI를 <b>다운로드</b>하면 무제한·비공개로 채점돼요 (설정 또는 상단 배너)"
            : "이 기기는 온디바이스 AI(WebGPU)를 지원하지 않아요";
        el.innerHTML = `<span class="ms-label">☁️ Gemini <span class="ms-warn">· 사용량 제한</span></span>
            <div class="mode-tip">
                <b>☁️ Gemini (서버 채점)</b>
                <ul><li>${limTxt} — 유료 API 비용 때문</li>
                    <li>${rec}</li></ul>
            </div>`;
    }
}
// 설정의 온디바이스 AI 섹션: 상태에 따라 다운로드/삭제/미지원 안내
function renderOnDeviceSettings() {
    const box = document.getElementById("ondevice-settings-body");
    if (!box) return;
    if (isOnDeviceReady()) {
        box.innerHTML = `<button class="btn-ghost danger" style="width:100%" onclick="clearOnDeviceAI()">🗑 온디바이스 AI 모델 캐시 삭제 (약 1.4GB)</button>
            <p class="muted" style="margin-top:8px">브라우저에 저장된 온디바이스 AI 모델을 삭제해요. 저장 공간을 비우거나 온디바이스 채점을 끄고 싶을 때 사용하세요. 삭제 후에는 서버 Gemini로 채점돼요 (하루 한도 있음).</p>
            <p style="margin-top:6px; font-size:12px; color:var(--red)">⚠️ 자주 지웠다 다시 받으면 모델 서버가 일시적으로 요청을 제한(429)할 수 있어요. 꼭 필요할 때만 지우세요.</p>`;
    } else if (navigator.gpu) {
        box.innerHTML = `<button class="btn-primary" style="width:100%" onclick="downloadLLM()">⬇️ 온디바이스 AI 다운로드 (약 1.4GB)</button>
            <p class="muted" style="margin-top:8px">지금 받아두면 주관식 답안을 이 기기 안에서 채점해요 (무료·무제한·비공개). 처음 한 번만 내려받으면 돼요.</p>`;
    } else {
        box.innerHTML = `<p class="muted">이 기기는 온디바이스 AI(WebGPU)를 지원하지 않아 서버 Gemini로 채점돼요. 최신 Chrome/Edge 등 지원 브라우저에서 사용할 수 있어요.</p>`;
    }
}
// 설정: 온디바이스 AI 모델 캐시 삭제 (저장공간 비우기 / 온디바이스 끄기)
async function clearOnDeviceAI() {
    if (!await showConfirm("온디바이스 AI 캐시 삭제",
        "온디바이스 AI 모델 캐시(약 1.4GB)를 삭제할까요?\n이후 채점은 서버 Gemini로 진행돼요 (하루 한도 있음).\n\n⚠️ 자주 지웠다 다시 받으면 모델 서버가 일시적으로 요청을 제한(429)할 수 있어요.",
        { okText: "삭제", danger: true })) return;
    try {
        if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k))); // 브라우저 캐시(모델 가중치) 삭제
        }
        localStorage.removeItem("vocashot_llm_cached");
        window.resetOnDeviceAI && window.resetOnDeviceAI(); // 메모리 엔진 해제
        _llmBannerDismissed = false;                        // 배너 다시 뜰 수 있게
        toast("온디바이스 AI 모델 캐시를 삭제했어요.", "success");
        updateModeStatus();       // 배지 갱신 (온디바이스 → Gemini)
        renderOnDeviceSettings(); // 설정 버튼 갱신 (삭제 → 다운로드)
        maybeShowLLMBanner();     // 다운로드 배너 다시 표시
    } catch (e) { toastErr("삭제 실패: " + e.message); }
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
    ["login", "signup", "verify"].forEach(p =>
        document.getElementById(`pane-${p}`).classList.toggle("hidden", p !== name));
    hideAuthError();
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
    try {
        const r = await api("/api/signup", { method: "POST", body: { email, password } });
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
    document.getElementById("view-app").classList.add("hidden");
    document.getElementById("view-auth").classList.remove("hidden");
}

async function enterApp() {
    const me = await api("/api/me");
    CURRENT_USER = me;
    renderUserChip();
    document.getElementById("nav-admin")?.classList.toggle("hidden", !me.is_admin); // 관리자 메뉴는 관리자만
    document.getElementById("view-auth").classList.add("hidden");
    document.getElementById("view-app").classList.remove("hidden");
    goDashboard();
}

// 상단바 프로필 칩 렌더링 (닉네임 / 아바타)
function renderUserChip() {
    const u = CURRENT_USER;
    document.getElementById("topbar-nick").textContent = u.nickname || u.email;
    const av = document.getElementById("topbar-avatar");
    av.innerHTML = u.avatar ? `<img src="${u.avatar}" alt="">` : "🙂";
}

// 페이지 로드 시 세션 확인
async function init() {
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
    } catch (e) {}
    loadShare();       // 공유 카드 상태
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


let _weakAll = [];


// ============================================================
// 학습 기능 — 플래시카드 & 단어 맞추기 게임
// ============================================================
function backToWordbook() {
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
    updateStudyCount();
    document.getElementById("study-modal").classList.remove("hidden");
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
        document.getElementById("fc-practice-actions").classList.remove("hidden");
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
    ["wordbooks", "exams"].forEach(t =>
        document.getElementById("tab-" + t).classList.toggle("hidden", t !== name));
    if (name === "wordbooks") loadWordbooks();
    if (name === "exams") loadExams();
}


// ============================================================
// 학습 플랜 (표시 + AI 플래너)


let plState = { wordbooks: [], selected: new Set(), preview: null };







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






















// ============================================================
// 알림
// ============================================================
// 바깥 클릭 시 프로필 메뉴 닫기
document.addEventListener("click", e => {
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
    // 단어장 구성이 바뀌면 이전 범위 설정은 무효 → 전체로 리셋
    ecState.selectedWords = null;
    const note = document.getElementById("ec-range-note");
    if (note) note.textContent = "범위: 전체 단어";
    updateEcCount();
}

// ============================================================
// 시험 범위 설정 (선택 단어장의 단어를 미리보고 범위/제외 지정)
// ============================================================
async function openRangeModal() {
    const chosen = ecState.wordbooks.filter(w => ecState.selected.has(w.id));
    if (!chosen.length) return toastErr("먼저 단어장을 선택하세요.");
    let words = [];
    try {
        for (const wb of chosen) {
            const { words: ws } = await api(`/api/wordbooks/${wb.id}`);
            words = words.concat(ws);
        }
    } catch (e) { return toastErr("단어를 불러오지 못했어요: " + e.message); }
    if (!words.length) return toastErr("선택한 단어장에 단어가 없습니다.");
    ecState.rangeWords = words;
    // 이전 선택이 있으면 복원(단어 기준), 없으면 전체 선택
    if (ecState.selectedWords && ecState.selectedWords.length) {
        const keys = new Set(ecState.selectedWords.map(w => w.word + "|" + (w.meaning || "")));
        ecState.rangeSel = new Set();
        words.forEach((w, i) => { if (keys.has(w.word + "|" + (w.meaning || ""))) ecState.rangeSel.add(i); });
    } else {
        ecState.rangeSel = new Set(words.map((_, i) => i));
    }
    document.getElementById("range-from").value = "";
    document.getElementById("range-to").value = "";
    document.getElementById("range-exclude-input").value = "";
    document.getElementById("range-total").textContent = words.length;
    renderRangeWords();
    document.getElementById("range-modal").classList.remove("hidden");
}

function renderRangeWords() {
    const box = document.getElementById("range-words");
    box.innerHTML = ecState.rangeWords.map((w, i) => {
        const sel = ecState.rangeSel.has(i);
        return `<label class="range-word ${sel ? "sel" : ""}" data-i="${i}">
            <input type="checkbox" ${sel ? "checked" : ""} onchange="toggleRangeWord(${i}, this.checked)">
            <span class="rw-num">${i + 1}</span>
            <span class="rw-word">${esc(w.word || "")}</span>
            <span class="rw-meaning muted">${esc(w.meaning || w.definition || "")}</span>
        </label>`;
    }).join("");
    updateRangeCount();
}

function toggleRangeWord(i, checked) {
    if (checked) ecState.rangeSel.add(i); else ecState.rangeSel.delete(i);
    document.querySelector(`.range-word[data-i="${i}"]`)?.classList.toggle("sel", checked);
    updateRangeCount();
}

// 범위 입력 → 그 범위만 정확히 선택 (나머지는 해제)
function applyRange() {
    const total = ecState.rangeWords.length;
    let from = parseInt(document.getElementById("range-from").value);
    let to = parseInt(document.getElementById("range-to").value);
    if (isNaN(from)) from = 1;
    if (isNaN(to)) to = total;
    from = Math.max(1, Math.min(from, total));
    to = Math.max(1, Math.min(to, total));
    if (from > to) { const t = from; from = to; to = t; }
    ecState.rangeSel = new Set();
    for (let i = from - 1; i <= to - 1; i++) ecState.rangeSel.add(i);
    renderRangeWords();
}

function selectAllRange(on) {
    ecState.rangeSel = on ? new Set(ecState.rangeWords.map((_, i) => i)) : new Set();
    renderRangeWords();
}

// "5, 12, 20-22" 같은 입력을 파싱해 해당 번호를 선택 해제
function applyExclude() {
    const raw = document.getElementById("range-exclude-input").value.trim();
    if (!raw) return;
    const total = ecState.rangeWords.length;
    raw.split(",").forEach(part => {
        part = part.trim();
        const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
            let a = parseInt(m[1]), b = parseInt(m[2]);
            if (a > b) { const t = a; a = b; b = t; }
            for (let n = a; n <= b; n++) if (n >= 1 && n <= total) ecState.rangeSel.delete(n - 1);
        } else {
            const n = parseInt(part);
            if (!isNaN(n) && n >= 1 && n <= total) ecState.rangeSel.delete(n - 1);
        }
    });
    renderRangeWords();
}

function updateRangeCount() {
    document.getElementById("range-sel-count").textContent = ecState.rangeSel.size;
}

function closeRangeModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("range-modal").classList.add("hidden");
}

function confirmRange() {
    if (!ecState.rangeSel.size) return toastErr("최소 한 단어는 선택해야 해요.");
    ecState.selectedWords = [...ecState.rangeSel].sort((a, b) => a - b).map(i => ecState.rangeWords[i]);
    const total = ecState.rangeWords.length;
    const n = ecState.selectedWords.length;
    document.getElementById("ec-range-note").textContent =
        n === total ? "범위: 전체 단어" : `범위: ${n}개 선택됨`;
    document.getElementById("range-modal").classList.add("hidden");
    toast(`${n}개 단어로 범위를 설정했어요.`, "success");
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
    // 범위 설정이 있으면 그 단어만, 없으면 선택 단어장의 전체 단어
    let allWords = [];
    let language = chosen[0].language || "en";
    if (ecState.selectedWords && ecState.selectedWords.length) {
        allWords = ecState.selectedWords;
    } else {
        try {
            for (const wb of chosen) {
                const { words } = await api(`/api/wordbooks/${wb.id}`);
                allWords = allWords.concat(words);
            }
        } catch (e) { return toastErr("단어를 불러오지 못했어요: " + e.message); }
    }
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

async function submitExam() { // 자동으로 전역이 됨.
    stopTimer();
    document.getElementById("take-questions").classList.add("hidden");
    document.getElementById("timer").classList.add("hidden");
    const prog = showProgress("grade");
    try {
        // 주관식 payload 만들기
        let payload = [];
        takeState.exam.questions.forEach((q, i) => {
            if (q.type === "written"){
                payload.push({ question: q.question, user_ans: takeState.answers[i] || "", correct_ans: q.answer })
            }
        })

        // 온디바이스 채점 호출
        let ai_pregraded = null;
        // 온디바이스 모델이 준비(다운로드)됐을 때만 온디바이스 채점. 아니면 서버 Gemini로.
        if (payload.length > 0 && isOnDeviceReady()){
            ai_pregraded = await gradeWrittenOnDevice(payload);
        }



        const r = await api("/api/attempts/grade-start", { method: "POST", body: {
            exam_id: takeState.exam.id, answers: takeState.answers, time_taken: takeState.elapsed, ai_pregraded: ai_pregraded } });
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

    reportState.results = result.results;  // 플로팅 신고 버튼 피커에서 사용
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

// 파일럿: 우측 하단 플로팅 신고 버튼 → 문항 선택 → 신고
let _reportSelIdx = null;
function openReportPicker() {
    if (!reportState.attemptId) return toastErr("먼저 채점을 완료해주세요.");
    _reportSelIdx = null;
    const rs = reportState.results || [];
    document.getElementById("report-picker-list").innerHTML = rs.map(r => `
        <button class="rp-item ${r.correct ? "" : "wrong"}" onclick="selectReportItem(${r.idx}, this)">
            <span class="rp-q">Q${r.idx}. ${esc(r.question)}</span>
            <span class="rp-you">내 답: ${esc(r.user_ans)} ${r.correct ? "✅" : "❌"}</span>
        </button>`).join("");
    document.getElementById("report-comment").value = "";
    document.getElementById("report-picker-modal").classList.remove("hidden");
}
function selectReportItem(idx, el) {
    _reportSelIdx = idx;
    document.querySelectorAll("#report-picker-list .rp-item").forEach(b => b.classList.remove("sel"));
    el.classList.add("sel");
}
function closeReportPicker(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById("report-picker-modal").classList.add("hidden");
}
async function submitReport() {
    if (_reportSelIdx == null) return toastErr("먼저 문항을 선택해주세요.");
    const comment = document.getElementById("report-comment").value.trim();
    try {
        await api(`/api/attempts/${reportState.attemptId}/report-grade`, { method: "POST", body: { idx: _reportSelIdx, comment } });
        toast("신고 접수 — 감사합니다! 🙏", "success");
        closeReportPicker();
    } catch (e) { toastErr(e.message); }
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
    "nav.planner": { ko: "캘린더", en: "Calendar", zh: "日历", ja: "カレンダー" },
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
    renderOnDeviceSettings(); // 온디바이스 AI 섹션: 상태에 따라 다운로드/삭제 버튼
    document.getElementById("profile-modal").classList.remove("hidden");
}

// 좌측 메뉴 '파일럿 데이터'(관리자) → 전용 뷰
function openAdminView() {
    document.querySelectorAll(".side-link").forEach(l => l.classList.remove("active"));
    document.getElementById("nav-admin")?.classList.add("active");
    showView("view-admin");
    loadAdminPanel();
    window.scrollTo(0, 0);
}

// 관리자 콘솔: 파일럿 데이터(모드 분포·온디바이스 성공률·오채점 신고) — 관리자에게만
async function loadAdminPanel() {
    const body = document.getElementById("admin-body");
    if (!body) return;
    body.innerHTML = `<p class="muted">불러오는 중…</p>`;
    try {
        const d = await api("/api/admin/pilot");
        const modeStr = Object.entries(d.modes || {}).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—";
        const rows = (d.reports || []).map(r => `
            <tr>
                <td>${esc(r.word || "")}</td>
                <td>${esc(r.student_ans || "")}</td>
                <td>${r.model_correct ? "정답처리" : "오답처리"}</td>
                <td>${esc(r.graded_by || "")}</td>
                <td>${esc(r.comment || "")}</td>
                <td class="muted">${esc((r.email || "").split("@")[0])}</td>
                <td class="muted">${esc((r.created_at || "").slice(5, 16))}</td>
            </tr>`).join("");
        body.innerHTML = `
            <div class="admin-stats">
                <div><b>${d.participants}</b><span>참가자</span></div>
                <div><b>${d.total_attempts}</b><span>총 응시</span></div>
                <div><b>${d.ondevice_rate == null ? "—" : d.ondevice_rate + "%"}</b><span>온디바이스 성공률</span></div>
                <div><b>${d.report_count}</b><span>오채점 신고</span></div>
            </div>
            <p class="muted" style="margin:10px 0 6px">채점 모드 분포: ${esc(modeStr)}</p>
            <div class="admin-table-wrap"><table class="admin-table">
                <thead><tr><th>단어</th><th>학생 답</th><th>모델 판정</th><th>모드</th><th>설명</th><th>학생</th><th>시각</th></tr></thead>
                <tbody>${rows || `<tr><td colspan="7" class="muted">아직 신고 없음</td></tr>`}</tbody>
            </table></div>`;
    } catch (e) {
        body.innerHTML = `<p class="muted">불러오기 실패: ${esc(e.message)}</p>`;
    }
}

// ===== AI 튜터 (온디바이스 채팅) =====
let chatHistory = [];  // [{role:'user'|'assistant', content}]
function openChat() {
    document.querySelectorAll(".side-link").forEach(l => l.classList.remove("active"));
    document.getElementById("nav-chat")?.classList.add("active");
    showView("view-chat");
    if (!chatHistory.length) {
        chatHistory = [];
        renderChat();
        addChatBubble("assistant", "안녕하세요! 영어 단어 학습을 도와드릴게요 🤖\n궁금한 단어의 뜻·용법·예문을 물어보세요. (답변은 이 기기 안에서 만들어져요)");
    }
    setTimeout(() => document.getElementById("chat-input")?.focus(), 100);
    window.scrollTo(0, 0);
}
function renderChat() {
    document.getElementById("chat-messages").innerHTML = "";
}
function addChatBubble(role, text) {
    const box = document.getElementById("chat-messages");
    const d = document.createElement("div");
    d.className = "chat-bubble " + role;
    if (role === "assistant") d.innerHTML = mdToHtml(text);  // AI 답변은 마크다운 렌더
    else d.textContent = text;                                // 사용자 입력은 그대로(안전)
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
    return d;
}

// 아주 가벼운 마크다운 → HTML (먼저 HTML 이스케이프 후 적용, XSS 방지)
function mdToHtml(md) {
    let h = esc(md || "");
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");          // `코드`
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"); // **굵게**
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");  // *기울임*
    const lines = h.split("\n");
    let out = "", ul = false, ol = false;
    const closeLists = () => { if (ul) { out += "</ul>"; ul = false; } if (ol) { out += "</ol>"; ol = false; } };
    for (const line of lines) {
        const mUl = line.match(/^\s*[-*]\s+(.*)$/);
        const mOl = line.match(/^\s*\d+\.\s+(.*)$/);
        if (mUl) { if (ol) { out += "</ol>"; ol = false; } if (!ul) { out += "<ul>"; ul = true; } out += `<li>${mUl[1]}</li>`; }
        else if (mOl) { if (ul) { out += "</ul>"; ul = false; } if (!ol) { out += "<ol>"; ol = true; } out += `<li>${mOl[1]}</li>`; }
        else { closeLists(); if (line.trim()) out += `<div>${line}</div>`; }
    }
    closeLists();
    return out;
}
async function sendChat() {
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    if (!window.isOnDeviceAIReady || !window.isOnDeviceAIReady()) {
        return toastErr("AI 튜터는 온디바이스 AI가 필요해요. 대시보드에서 먼저 다운로드해주세요.");
    }
    input.value = "";
    document.getElementById("chat-send").disabled = true;
    addChatBubble("user", text);
    chatHistory.push({ role: "user", content: text });
    const thinking = addChatBubble("assistant", "생각 중…");
    try {
        const reply = await window.chatOnDevice(chatHistory.slice(-8)); // 최근 맥락만
        thinking.innerHTML = mdToHtml(reply || "죄송해요, 답변을 만들지 못했어요. 다시 물어봐 주세요.");
        if (reply) chatHistory.push({ role: "assistant", content: reply });
    } catch (e) {
        thinking.innerHTML = mdToHtml("오류가 났어요. 다시 시도해주세요.");
    } finally {
        document.getElementById("chat-send").disabled = false;
        document.getElementById("chat-messages").scrollTop = 1e9;
    }
}
async function clearChat() {
    if (chatHistory.length &&
        !await showConfirm("대화 지우기", "지금까지의 대화를 모두 지울까요?", { okText: "지우기", danger: true })) return;
    chatHistory = [];
    renderChat();
    addChatBubble("assistant", "새 대화를 시작해요! 궁금한 단어를 물어보세요 🤖");
    toast("대화를 지웠어요.", "success");
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
    updateModeStatus();
    loadGradeConfig();
    setupUploadArea();
    setupCrop();
    init();
    // Enter 키로 로그인/인증 편의
    document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
    document.getElementById("verify-code").addEventListener("keydown", e => { if (e.key === "Enter") doVerify(); });
});
