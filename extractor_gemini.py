######################################################################################################
# 참고 가이드:
# Gemini API 이미지 이해: https://ai.google.dev/gemini-api/docs/image-understanding?hl=ko
######################################################################################################


#라이브러리 호출
import os
import json
import base64
import requests
import re 
from dotenv import load_dotenv

#env 파일 읽기
load_dotenv()
API_KEY = os.getenv("GOOGLE_API_KEY") #os.getenv()를 통하여 env 파일에서 API_KEY를 불러와 저장.

#이미지 파일을 base64로 인코딩. (컴퓨터가 이미지를 텍스트로 이해할 수 있도록 변환하는 것임)
#image_path는 인코딩할 이미지 파일의 경로를 나타내는 매개변수
def encode_image(image_path):
    #이미지 파일을 바이너리 모드로 열어서 읽어들임 (rb는 read binary의 약자)
    #바이너리 모드로 읽어드리는 것은 이미지 파일은 이진 데이터 형태로 저장 되어 있기 때문
    with open(image_path, "rb") as f:
        #base64.b64encode()는 바이너리 데이터를 base64로 인코딩하는 함수
        #인코딩된 데이터는 bytes 형태로 반환되므로, decode('utf-8')을 사용하여 문자열로 변환
        return base64.b64encode(f.read()).decode('utf-8')

def clean_json_string(text):
    text = re.sub(r"```json", "", text, flags=re.IGNORECASE).replace("```", "").strip()
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if match: return match.group(0)
    return text


#이미지에서 텍스트 추출, 본 프로젝트에서는 Gemini 사용
def extract_data_with_gemini(image_path):
    if not API_KEY: return [] #예외처리, API_KEY가 없는 경우 빈 리스트를 반환
    try: base64_image = encode_image(image_path) #이미지 파일을 base64로 인코딩하여 base64_image 변수에 저장
    except: return [] #예외처리, 실패시 빈 리스트 반환

    #Gemini API에 요청할 프롬프트
    prompt_text = """
    You are an expert English-Korean Dictionary Editor.
    
    [TASK]
    Extract vocabulary words from the image.
    
    [CRITICAL RULES FOR "MEANING"]
    1. If the image has an English definition:
        - TRANSLATE that specific definition into Korean.
        - Do NOT just translate the word itself; consider the context of the definition.
        - Example: Word "Bank", Def "Sloping land" -> Meaning "둑" (Not 은행).
    
    2. If the image has NO definition (Word only):
        - You act as a dictionary. GENERATE the most common Korean meaning.
        - GENERATE a simple English definition.
        - GENERATE a simple example sentence.

    [OUTPUT FIELDS]
    - "word": English word.
    - "definition": English definition (Extracted or Generated).
    - "meaning": Korean meaning (Translated from definition).
    - "example": English sentence (Extracted or Generated).

    Output: Valid JSON Array ONLY.
    """

    #URL은 Gemini API의 엔드포인트로, 모델과 작업 유형에 따라 다를 수 있음. 여기서는 "gemini-flash-latest" 모델을 사용하여 콘텐츠 생성을 요청하는 URL을 구성.
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={API_KEY}"
    
    headers = {"Content-Type": "application/json"}

    #payload는 Gemini API에 요청할 데이터로, 프롬프트와 이미지 데이터를 포함하는 JSON 형식의 객체입니다.
    payload = {
        "contents": [{"parts": [{"text": prompt_text}, {"inline_data": {"mime_type": "image/jpeg", "data": base64_image}}]}],
        "generationConfig": {"temperature": 0.1, "response_mime_type": "application/json"}
    }

    try:
        response = requests.post(url, headers=headers, data=json.dumps(payload))
        if response.status_code == 200:
            raw = response.json()['candidates'][0]['content']['parts'][0]['text']
            return json.loads(clean_json_string(raw))
        return []
    except: return []