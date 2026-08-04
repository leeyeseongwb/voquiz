import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

const modelId = "gemma-2-2b-it-q4f16_1-MLC";

async function checkGPUSupport() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

async function loadModel() {
  const hasGPU = await checkGPUSupport();
  
  if (!hasGPU) {
    console.log("⚠️ WebGPU 미지원 — AI 기능 비활성화, 룰 기반 채점으로 전환");
    return null; // AI 없이 진행, 본체 앱에서 이 null을 룰 기반 경로로 분기
  }

  console.log("✅ WebGPU 사용 가능 — AI 피드백 활성화");
  try {
    const engine = await CreateMLCEngine("gemma-2-2b-it-q4f16_1-MLC", {
      initProgressCallback: (r) => console.log(r.text, r.progress),
    });
    console.log("로딩 완료!");
    return engine;
  } catch (err) {
    console.error("GPU는 있지만 로딩 실패:", err);
    return null; // GPU 있어도 실패하면 마찬가지로 룰 기반 폴백
  }
}

window.loadModel = loadModel; // 콘솔에서 호출 가능하게 노출
loadModel(); // 페이지 로드시 자동 실행은 그대로 유지
