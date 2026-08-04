import os
import requests
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.getenv("GOOGLE_API_KEY")

if not API_KEY:
    print("API 키가 없습니다.")
    exit()

print(f"🔑 사용 중인 키: {API_KEY[:5]}...*****")
print("📡 구글 서버에 사용 가능한 모델 목록을 요청합니다...\n")

url = f"https://generativelanguage.googleapis.com/v1beta/models?key={API_KEY}"
response = requests.get(url)

if response.status_code == 200:
    data = response.json()
    print("✅ 사용 가능한 모델 목록:")
    found_flash = False
    for model in data.get('models', []):
        name = model['name']
        # 'generateContent' 기능을 지원하는 모델만 출력
        if 'generateContent' in model['supportedGenerationMethods']:
            print(f"- {name}")
            if "gemini-1.5-flash" in name:
                found_flash = True
    
    print("\n------------------------------------------------")
    if found_flash:
        print("결과: gemini-1.5-flash가 목록에 있습니다! (오타 문제였을 수 있음)")
    else:
        print("결과: gemini-1.5-flash가 목록에 없습니다! (다른 모델을 써야 함)")
else:
    print(f"🚨 에러 발생: {response.status_code}")
    print(response.text)