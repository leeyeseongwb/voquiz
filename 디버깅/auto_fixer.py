import os
import json
import base64
import requests

# ==============================================================================
# 🚨 [필수] 여기에 아까 받은 '새 프로젝트'의 API 키를 직접 붙여넣으세요.
# .env 파일 로딩 문제일 수도 있어서 직접 넣는 것이 확실합니다.
# ==============================================================================
MY_API_KEY = "AIzaSyAqMUDIPt-hqoP8Jk_aX2xnMB_CNR4nD6w" # <--- 따옴표 안에 키를 붙여넣으세요!

# 테스트할 이미지 파일명
IMAGE_FILE = "test_voca.jpg"

# ------------------------------------------------------------------------------
# 사용할 수 있는 모든 모델 후보군 (순서대로 시도합니다)
# ------------------------------------------------------------------------------
CANDIDATE_MODELS = [
    "gemini-1.5-flash",          # 1순위: 표준
    "gemini-1.5-flash-latest",   # 2순위: 최신 별칭
    "gemini-1.5-flash-001",      # 3순위: 고정 버전
    "gemini-flash-latest",       # 4순위: 플래시 별칭
    "gemini-1.5-pro",            # 5순위: 프로 버전 (무료 티어 있음)
    "gemini-pro",                # 6순위: 구버전 (1.0) - 이건 거의 무조건 됨
    "gemini-2.0-flash-lite-preview-02-05", # 7순위: 특정 프리뷰
]

def encode_image(image_path):
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

def try_model(model_name, base64_image):
    print(f"\n🔎 [테스트 중] 모델: {model_name}...")
    
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={MY_API_KEY}"
    
    headers = {"Content-Type": "application/json"}
    payload = {
        "contents": [{
            "parts": [
                {"text": "Extract word, meaning, example from this image in JSON."}, # 간단한 테스트용 프롬프트
                {"inline_data": {
                    "mime_type": "image/jpeg",
                    "data": base64_image
                }}
            ]
        }],
        "generationConfig": {
            "response_mime_type": "application/json"
        }
    }

    try:
        response = requests.post(url, headers=headers, data=json.dumps(payload), timeout=30)
        
        if response.status_code == 200:
            print(f"✅ [성공!] 작동하는 모델을 찾았습니다: {model_name}")
            return response.json()
        elif response.status_code == 404:
            print(f"❌ [실패] 모델 없음 (404)")
        elif response.status_code == 429:
            print(f"❌ [실패] 용량 초과 (429) - 이 모델은 무료로 못 씀")
        else:
            print(f"❌ [실패] 기타 에러 ({response.status_code})")
            
    except Exception as e:
        print(f"❌ [에러] 요청 중 문제 발생: {e}")
    
    return None

# ------------------------------------------------------------------------------
# 메인 실행 로직
# ------------------------------------------------------------------------------
if __name__ == "__main__":
    if MY_API_KEY == "AIzaSy..." or len(MY_API_KEY) < 10:
        print("🚨 오류: 코드 8번째 줄에 API 키를 입력하지 않았습니다!")
        exit()

    if not os.path.exists(IMAGE_FILE):
        print(f"🚨 오류: {IMAGE_FILE} 파일이 없습니다.")
        exit()

    print("🚀 자동으로 작동하는 모델을 찾기 시작합니다...")
    
    b64_img = encode_image(IMAGE_FILE)
    success_data = None
    working_model = None

    # 후보 모델들을 하나씩 순회하며 테스트
    for model in CANDIDATE_MODELS:
        result = try_model(model, b64_img)
        if result:
            success_data = result
            working_model = model
            break # 성공하면 반복문 탈출!

    # 결과 출력
    if success_data:
        print("\n" + "="*50)
        print(f"🎉 최종 성공! 사용한 모델: {working_model}")
        print("="*50)
        try:
            # 결과 파싱해서 보여주기
            text_content = success_data['candidates'][0]['content']['parts'][0]['text']
            parsed = json.loads(text_content)
            print(json.dumps(parsed, indent=2, ensure_ascii=False))
            print("\n💡 앞으로 코드를 짤 때 이 모델 이름을 쓰세요!")
        except:
            print("데이터 파싱은 실패했지만 연결은 성공했습니다.")
            print(success_data)
    else:
        print("\n😭 모든 모델 테스트 실패. API 키가 올바른지, 구글 클라우드 결제 설정 등을 확인해야 합니다.")