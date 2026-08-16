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

let _llmCancel = null; // 로딩 중일 때만 세팅되는 취소 트리거

function cancelLLMLoad() {
    if (_llmCancel) _llmCancel(); // 취소 버튼이 부름 → 로딩 대기를 중단
}

async function getEngine() {
    if (engine) return engine; // 이미 로딩된 엔진이 있으면 재사용 (로딩창 안 뜸)
    if (await checkGPUSupport()) {
        try {
            _llmLoadingShow(); // 로딩 오버레이 표시
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
            console.log("로딩 완료!");
            return engine;
        } catch (err) {
            _llmCancel = null;
            _llmLoadingHide();
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
    const prompt = `You are a warm, encouraging English teacher grading a Korean student's vocabulary answers.
[Data] ${JSON.stringify(payload)}

[Rules]
1. Compare 'user_ans' with 'correct_ans'.
2. If the meaning is essentially correct (even if wording differs / synonyms), mark correct=true.
3. If wrong or empty, correct=false.
4. 'feedback' must be short and in Korean.

[Output] JSON array, same length and order as input:
[{"correct": true, "feedback": "정확해요!"}] 
`;
    return prompt;
}
// 스코프(scope): 함수 안 변수는 호출 끝나면 사라진다 → 기억하려면 함수 밖에
// 섀도잉: 안에서 다시 선언하면 바깥 변수를 가려버린다
// 선언 vs 대입: 키워드 있으면 "새로 만들기", 없으면 "기존 것에 넣기"
// 싱글톤 패턴: 비싼 자원(1.4GB 모델)은 한 번만 만들고 재사용'

window.gradeWrittenOnDevice = gradeWrittenOnDevice; // 갇혀있던 함수가 전역에 올라가 app.js가 gradeWrittenOnDevice()를 볼 수 있음.
window.cancelLLMLoad = cancelLLMLoad;                         // 로딩 오버레이의 취소 버튼용
window.prepareOnDeviceAI = async () => !!(await getEngine()); // 메인 배너에서 미리 다운로드용
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
        let result = JSON.parse(text)
        return result;
    } catch (err){
        return null;
    }
    

}