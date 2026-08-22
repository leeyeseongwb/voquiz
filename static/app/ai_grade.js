import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

const modelId = "gemma-2-2b-it-q4f16_1-MLC";
let engine = null; //engine 상태 전역변수

async function checkGPUSupport() { // async는 코드 안에 await를 해야하는 느린 작업이 있을 떄 쓰임
    if (!navigator.gpu) return false;
    try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
    } catch {
    return false;
    } 
}

// ===== 온디바이스 LLM 로딩 오버레이 제어 =====
function _llmLoadingShow() {
    document.getElementById("llm-loading-progress")?.classList.remove("hidden");
    document.getElementById("llm-loading-error")?.classList.add("hidden");
    document.getElementById("llm-loading")?.classList.remove("hidden");
    _llmLoadingUpdate("시작하는 중…", 0);
}
function _llmLoadingUpdate(text, progress) {
    const pct = Math.round((progress || 0) * 100);
    const bar = document.getElementById("llm-loading-bar");
    if (bar) bar.style.width = pct + "%";
    const pctEl = document.getElementById("llm-loading-pct");
    if (pctEl) pctEl.textContent = pct + "%";
    const msgEl = document.getElementById("llm-loading-msg");
    if (msgEl && text) msgEl.textContent = text;
}
function _llmLoadingHide() {
    document.getElementById("llm-loading")?.classList.add("hidden");
}
function _llmLoadingError(msg) { // 오버레이를 에러 상태로 전환 (다운로드 실패 시)
    const errMsg = document.getElementById("llm-error-msg");
    if (errMsg) errMsg.textContent = msg;
    document.getElementById("llm-loading-progress")?.classList.add("hidden");
    document.getElementById("llm-loading-error")?.classList.remove("hidden");
    document.getElementById("llm-loading")?.classList.remove("hidden");
}
function _llmFriendlyError(err) { // 에러 종류에 따라 사람이 읽을 안내로 변환
    const m = (err && (err.message || String(err))) || "";
    if (/429|too many requests|request failed|failed to execute 'add' on 'cache'/i.test(m))
        return "모델 서버 요청이 일시적으로 많아요 (GitHub 제한, 429). 10~30분 뒤에 다시 시도해 주세요. 그동안은 서버 Gemini로 채점돼요.";
    if (/device lost|webgpu|adapter|gpu/i.test(m))
        return "GPU 상태 문제로 로딩에 실패했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.";
    return "온디바이스 AI 로딩에 실패했어요. 잠시 후 다시 시도해 주세요. 그동안은 서버 Gemini로 채점돼요.";
}

// 파일럿 계측: 모델 로딩 성공/실패·시간을 서버에 기록
function _reportDevice(data) {
    fetch("/api/pilot/device", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data) }).catch(() => {});
}

let _llmCancel = null; // 로딩 중일 때만 세팅되는 취소 트리거

function cancelLLMLoad() {
    if (_llmCancel) _llmCancel(); // 취소 버튼이 부름 → 로딩 대기를 중단
}

async function getEngine(showError = false) { // showError=true면 실패 시 오버레이에 안내(명시적 다운로드용)
    if (engine) return engine; // 이미 로딩된 엔진이 있으면 재사용 (로딩창 안 뜸)
    if (await checkGPUSupport()) {
        try {
            _llmLoadingShow(); // 로딩 오버레이 표시
            const _t0 = performance.now(); // 로딩 시간 측정(파일럿)
            // 취소 지원: 로딩 완료 vs 사용자 취소 중 먼저 끝나는 것을 기다림
            const cancelPromise = new Promise((resolve) => { _llmCancel = () => resolve("__CANCELLED__"); });
            const loadPromise = CreateMLCEngine("gemma-2-2b-it-q4f16_1-MLC", { // GPU 지원시 엔진 로딩
                initProgressCallback: (r) => { console.log(r.text, r.progress); _llmLoadingUpdate(r.text, r.progress); },
            });
            const result = await Promise.race([loadPromise, cancelPromise]);
            _llmCancel = null;
            _llmLoadingHide();
            if (result === "__CANCELLED__") {
                console.log("온디바이스 로딩 취소됨 → 서버 채점으로 폴백");
                loadPromise.then(e => { try { e && e.unload && e.unload(); } catch (_) {} }).catch(() => {}); // 뒤늦게 끝나면 메모리 해제
                return null;
            }
            engine = result;
            localStorage.setItem("vocashot_llm_cached", "1"); // 다운로드 완료 표시(배너 숨김용)
            _reportDevice({ model_loaded: true, load_ms: Math.round(performance.now() - _t0) }); // 계측
            console.log("로딩 완료!");
            return engine;
        } catch (err) {
            _llmCancel = null;
            if (showError) _llmLoadingError(_llmFriendlyError(err)); // 명시적 다운로드면 안내 표시
            else _llmLoadingHide();                                  // 채점 중이면 조용히 서버 Gemini 폴백
            _reportDevice({ model_loaded: false }); // 계측: 로딩 실패
            console.error("GPU는 있지만 로딩 실패:", err);
            return null; // GPU 있어도 실패하면 마찬가지로 룰 기반 폴백
        }
    }
    else{ // GPU 미지원 시 null 반환
        console.log("⚠️ WebGPU 미지원 — AI 기능 비활성화, 룰 기반 채점으로 전환");
        return null;
    }
}

function buildPrompt(payload) {
    /* 주관식 답안을 Gemini 로 채점. 실패 시 단순 문자열 비교로 폴백 */
    const prompt = `You are a STRICT but fair English teacher grading a Korean student's vocabulary answers.
Grade ONLY on whether 'user_ans' actually means the same as 'correct_ans'. Do not be lenient just to be kind.
[Data] ${JSON.stringify(payload)}

[Rules]
1. Compare 'user_ans' with 'correct_ans' by MEANING.
2. correct=true ONLY if 'user_ans' expresses essentially the same meaning as 'correct_ans' (synonyms or different wording are fine).
3. correct=false if the answer is wrong, unrelated, empty, or random/nonsense characters (e.g. "asdf", "ㄴㅇㄹ", "..."). Never mark gibberish as correct.
4. When unsure, mark correct=false.
5. 'feedback' must be short and in Korean.

[Examples]
correct_ans "현실주의자", user_ans "현실적인 사람" -> correct=true
correct_ans "현실주의자", user_ans "ㄴㅇㄹㅇ" -> correct=false
correct_ans "현실주의자", user_ans "" -> correct=false

[Output] JSON array, same length and order as input:
[{"correct": true, "feedback": "정확해요!"}]
`;
    return prompt;
}

// 모델 응답에서 JSON 배열만 추출 (마크다운 코드펜스나 앞뒤 잡텍스트 제거)
function extractJson(text) {
    let t = (text || "").replace(/```(?:json)?/gi, "").replace(/```/g, ""); // 코드펜스 제거
    const start = t.indexOf("[");
    if (start === -1) return t.trim();
    // 첫 '['부터 괄호 깊이를 세서 짝 맞는 ']'까지만 추출 (뒤에 붙는 설명/코드의 대괄호는 무시).
    // 문자열 안의 대괄호는 세지 않도록 따옴표 상태를 추적한다.
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "[") depth++;
        else if (c === "]" && --depth === 0) { end = i; break; }
    }
    const json = (end === -1) ? t.slice(start) : t.slice(start, end + 1);
    return json.replace(/,\s*([\]}])/g, "$1"); // 후행 콤마 제거 (Gemma가 종종 },] 로 붙임)
}

// 스코프(scope): 함수 안 변수는 호출 끝나면 사라진다 → 기억하려면 함수 밖에
// 섀도잉: 안에서 다시 선언하면 바깥 변수를 가려버린다
// 선언 vs 대입: 키워드 있으면 "새로 만들기", 없으면 "기존 것에 넣기"
// 싱글톤 패턴: 비싼 자원(1.4GB 모델)은 한 번만 만들고 재사용'

window.gradeWrittenOnDevice = gradeWrittenOnDevice; // 갇혀있던 함수가 전역에 올라가 app.js가 gradeWrittenOnDevice()를 볼 수 있음.
window.cancelLLMLoad = cancelLLMLoad;                         // 로딩 오버레이의 취소 버튼용
window.prepareOnDeviceAI = async () => !!(await getEngine(true)); // 배너/설정 다운로드 (실패 시 오버레이에 안내)
window.hasWebGPU = () => !!navigator.gpu;                     // 배너를 보여줄지 판단
window.isOnDeviceAIReady = () => localStorage.getItem("vocashot_llm_cached") === "1"; // 이미 받았나
window.resetOnDeviceAI = () => { try { engine && engine.unload && engine.unload(); } catch (_) {} engine = null; }; // 캐시 삭제 시 메모리 엔진도 해제

async function gradeWrittenOnDevice(payload){ // 그 파일 안에 갇힘. app.js가 못 봄. 그래서 위에 window. 추가하는 거임
    // 엔진 얻기
    const engine = await getEngine();
    if (engine == null) {
        return null
    }

    // 프롬프트 만들기
    const prompt = buildPrompt(payload)
    
    // 모델로 보내기
    try{
        const reply = await engine.chat.completions.create({
            messages: [{ role: "user", content: prompt}],
            temperature: 0, // 0 = 매번 같은 답 (채점은 재현성이 중요함)
            // temperature는 LLM의 단어 선택의 무작위성을 제어하는 도구이다. 1이면 창의적이고 같은 질문에 매번 다른 답을 준다.
            // 그러나 0은 거의 결정론적이다. 그렇기에 같은 답에서도 채점을 다르게 하는 것을 수정해준다.
        })
        let text = reply.choices[0].message.content;
        console.log("[온디바이스] 모델 원본 응답:", text);       // 진단용
        let result = JSON.parse(extractJson(text));              // 펜스·잡텍스트 제거 후 파싱
        return result;
    } catch (err){
        console.error("[온디바이스] 채점 실패(→ 서버 폴백):", err); // 왜 실패했는지 콘솔에 표시
        return null;
    }


}

// ===== 온디바이스 AI 튜터 (단어 학습 관련 질문만) =====
const CHAT_SYSTEM = `You are a friendly English vocabulary tutor for Korean students.
ONLY help with English vocabulary and language learning: word meanings, usage, example sentences, synonyms/antonyms, nuance, collocations, pronunciation, and grammar related to words.
If the question is NOT about English words or language learning (e.g., personal chat, math, coding, news, politics, other unrelated topics), do NOT answer it. Politely refuse in Korean and steer back, exactly like: "저는 영어 단어 학습만 도와드릴 수 있어요 🙂 궁금한 단어나 표현을 물어봐 주세요!"
Reply in Korean unless the student writes in another language. Keep answers clear and concise, and add a short example sentence when helpful.`;

async function chatOnDevice(messages) {
    const engine = await getEngine();          // 이미 로딩된 모델 재사용
    if (!engine) return null;                  // 온디바이스 불가 → 채팅 비활성
    try {
        const reply = await engine.chat.completions.create({
            messages: [{ role: "system", content: CHAT_SYSTEM }, ...messages],
            temperature: 0.4,                  // 채점(0)보다 약간 부드럽게
        });
        return reply.choices[0].message.content;
    } catch (err) {
        console.error("[온디바이스] 채팅 실패:", err);
        return null;
    }
}
window.chatOnDevice = chatOnDevice;