/* ============================================================
   VoQuiz 소개 사이트 — 스크롤 엔진
   - rAF 하나로 모든 스크롤 연동 처리 (스크롤 이벤트마다 계산 X)
   - 히어로: 스크롤에 따라 기기가 펴지고 커지며, 카피는 멀어짐
   - PINNED: 화면을 고정한 채 3개 장면이 스크롤로 전환 (Apple 방식)
   - 상단 진행 바 / 내비 다크 전환 / 등장 애니메이션 / 카운트업
   ============================================================ */

const clamp = (v, a = 0, b = 1) => Math.min(Math.max(v, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
// 구간 [i,o] 안에서의 진행도(0~1)
const range = (v, i, o) => clamp((v - i) / (o - i));

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobile = () => window.innerWidth <= 960;

/* ---------- 등장 (한 번만) ---------- */
const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.classList.add("in");
        io.unobserve(e.target);
    });
}, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" });

document.querySelectorAll(".reveal, .lines").forEach(el => {
    // 형제 카드들은 살짝 시간차로
    const sibs = el.parentElement ? [...el.parentElement.children].filter(c => c.classList.contains("reveal")) : [];
    const i = sibs.indexOf(el);
    if (i > 0) el.style.transitionDelay = Math.min(i * 80, 320) + "ms";
    io.observe(el);
});

/* ---------- 숫자 카운트업 ---------- */
const cio = new IntersectionObserver((entries) => {
    entries.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target, target = parseInt(el.dataset.count, 10), dur = 1400, t0 = performance.now();
        const step = (t) => {
            const k = clamp((t - t0) / dur);
            el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));   // easeOutCubic
            if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        cio.unobserve(el);
    });
}, { threshold: 0.6 });
document.querySelectorAll("[data-count]").forEach(c => cio.observe(c));

/* ---------- 요소 ---------- */
const nav      = document.getElementById("nav");
const bar      = document.getElementById("progress");
const hero     = document.querySelector(".hero");
const heroCopy = document.getElementById("hero-copy");
const win      = document.querySelector(".hero-device .window");
const pin      = document.getElementById("how");
const steps    = [...document.querySelectorAll(".step")];
const scenes   = [...document.querySelectorAll(".scene")];
const darkSecs = [...document.querySelectorAll(".sec-dark, .pin, .final")];

let activeStep = -1;

/* ---------- 스크롤 연동 업데이트 ----------
   스크롤이 있을 때만 rAF 한 번으로 처리(coalescing).
   상시 rAF 루프를 돌리지 않아 배터리를 아낀다. */
function update() {
    const y  = window.scrollY;
    const vh = window.innerHeight;

    // 상단 진행 바
    const max = document.body.scrollHeight - vh;
    bar.style.transform = `scaleX(${max > 0 ? clamp(y / max) : 0})`;

    // 내비: 경계선 + 다크 섹션 위에서 반전
    nav.classList.toggle("scrolled", y > 8);
    let onDark = false;
    for (const s of darkSecs) {
        const r = s.getBoundingClientRect();
        if (r.top <= 26 && r.bottom >= 26) { onDark = true; break; }   // 내비 중앙(26px) 기준
    }
    nav.classList.toggle("dark", onDark);

    if (!isMobile() && !reduced) {
        // ---- 히어로 스크럽 ----
        // 0 → 1 : 기기가 26deg 기울기에서 정면으로 펴지고, 살짝 커진다
        if (hero && win) {
            const p = range(y, 0, vh * 1.15);
            win.style.setProperty("--rx", lerp(26, 0, p).toFixed(2) + "deg");
            win.style.setProperty("--sc", lerp(0.92, 1.04, p).toFixed(3));
            // 카피는 먼저 멀어지며 사라진다
            const q = range(y, 0, vh * 0.72);
            heroCopy.style.transform = `translateY(${(-q * 90).toFixed(1)}px) scale(${lerp(1, .94, q).toFixed(3)})`;
            heroCopy.style.opacity = (1 - range(y, vh * 0.22, vh * 0.62)).toFixed(3);
        }

        // ---- PINNED: 스크롤 구간을 3등분해 장면 전환 ----
        if (pin) {
            const r = pin.getBoundingClientRect();
            const total = pin.offsetHeight - vh;              // 고정되어 있는 동안의 스크롤 길이
            const p = clamp(-r.top / total);                  // 0 → 1
            const n = scenes.length;
            const idx = Math.min(Math.floor(p * n), n - 1);   // 현재 장면
            const local = clamp(p * n - idx);                 // 그 장면 안에서의 진행도

            if (idx !== activeStep) {
                activeStep = idx;
                steps.forEach((s, i) => s.classList.toggle("active", i === idx));
                scenes.forEach((s, i) => s.classList.toggle("active", i === idx));
            }
            // 활성 스텝의 진행 레일 채우기
            steps.forEach((s, i) => {
                const railFill = s.querySelector(".s-rail i");
                if (railFill) railFill.style.width = (i < idx ? 100 : i === idx ? local * 100 : 0) + "%";
            });
        }
    }
}

let ticking = false;
function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { update(); ticking = false; });
}
window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("resize", onScroll);
update();                       // 첫 진입(새로고침·앵커 링크) 시 1회
window.__vs = { update };       // 디버그용

/* ---------- 소식 레일 ---------- */
const rail = document.getElementById("news-rail");
const prev = document.getElementById("news-prev");
const next = document.getElementById("news-next");
if (rail) {
    const amount = () => (rail.querySelector(".news-card")?.offsetWidth || 320) + 18;
    prev.addEventListener("click", () => rail.scrollBy({ left: -amount(), behavior: "smooth" }));
    next.addEventListener("click", () => rail.scrollBy({ left: amount(), behavior: "smooth" }));
    const sync = () => {
        prev.disabled = rail.scrollLeft < 8;
        next.disabled = rail.scrollLeft > rail.scrollWidth - rail.clientWidth - 8;
    };
    rail.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    sync();
}
