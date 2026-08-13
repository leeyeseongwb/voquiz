import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

const modelId = "gemma-2-2b-it-q4f16_1-MLC";
let engine = null; //engine 상태 전역변수

async function checkGPUSupport() {
    if (!navigator.gpu) return false;
    try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
    } catch {
    return false;
    } 
}

async function getEngine() {
    if (engine) return engine; // 이미 로딩된 엔진이 있으면 재사용
    if (await checkGPUSupport()) {
        try {
        engine = await CreateMLCEngine("gemma-2-2b-it-q4f16_1-MLC", { // GPU 지원시 엔진 로딩 및 저장
            initProgressCallback: (r) => console.log(r.text, r.progress),
        });
        console.log("로딩 완료!");
        return engine;
        } catch (err) {
        console.error("GPU는 있지만 로딩 실패:", err);
        return null; // GPU 있어도 실패하면 마찬가지로 룰 기반 폴백
        }
    }
    else{ // GPU 미지원 시 null 반환    
        console.log("⚠️ WebGPU 미지원 — AI 기능 비활성화, 룰 기반 채점으로 전환");
        return null;
    }
}


// 스코프(scope): 함수 안 변수는 호출 끝나면 사라진다 → 기억하려면 함수 밖에
// 섀도잉: 안에서 다시 선언하면 바깥 변수를 가려버린다
// 선언 vs 대입: 키워드 있으면 "새로 만들기", 없으면 "기존 것에 넣기"
// 싱글톤 패턴: 비싼 자원(1.4GB 모델)은 한 번만 만들고 재사용