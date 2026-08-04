import os
import json
import random
import requests
from dotenv import load_dotenv # 환경변수 로드 라이브러리, dontenv 파일에서 API 키를 안전하게 불러오기 위해 사용

load_dotenv()
API_KEY = os.getenv("GOOGLE_API_KEY")

#result.json 파일에 저장된 데이터들을 활용하여 퀴즈를 생성하는 함수
def generate_mixed_quiz(words_subset, selected_types):
    #API 키가 없는 경우 예외 처리
    if not API_KEY:
        print("🚨 API Key Missing")
        return []

    #프롬프트 구성 (퀴즈 유형 설명)
    #type_descriptions 리스트를 추가하는 이유는 사용자가 선택한 퀴즈 유형을 프롬프트에 추가하여 API가 어떤 문제를 생성해야하는지 명확히 알게 하기 위함
    #문제 추가하고 싶을 때 여기서 설명 추가하면 됨.
    type_descriptions = []
    if 1 in selected_types: type_descriptions.append("1. Blank: Sentence with '____'. Options: English Words.")
    if 2 in selected_types: type_descriptions.append("2. Eng->Kor: Question: English Word. Options: Korean Meanings.")
    if 3 in selected_types: type_descriptions.append("3. Kor->Eng: Question: Korean Meaning. Options: English Words.")
    if 4 in selected_types: type_descriptions.append("4. Def->Word: Question: English Definition. Options: English Words.")
    if 5 in selected_types: type_descriptions.append("5. Word->Def: Question: English Word. Options: English Definitions.")

    #API가 퀴즈를 생성하게 하기 위한 prompt
    #여기서 json.dumps(words_subset, ensure_ascii=False) 부분은 words_subset 리스트를 JSON 형식의 문자열로 변환하는 역할을 함.
    #ensure_ascii=False 옵션은 한글이 깨지지 않도록 하기 위해 사용됨. 이렇게 변환된 문자열은 프롬프트에 포함되어 API가 퀴즈를 생성할 때 참고할 수 있도록 제공됨.
    #quiz_data.json으로 파일이 저장 될 것임.
    prompt_text = f"""
    You are an English Quiz Master.
    Create a multiple-choice quiz using these words:
    {json.dumps(words_subset, ensure_ascii=False)}

    [TASK]
    Create exactly {len(words_subset)} questions.
    Randomly mix these question types:
    {chr(10).join(type_descriptions)}

    [REQUIREMENTS]
    1. 4 Options per question.
    2. Explanation must be in Korean.
    3. Output JSON Array ONLY.

    [OUTPUT FORMAT]
    [
        {{
        "type": 1,
        "question": "The question text here...",
        "options": ["Option A", "Option B", "Option C", "Option D"],
        "answer": "Option A",
        "explanation": "이유 설명."
        }}
    ]
    """
    #API 요청을 보내고 응답을 처리하는 부분
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={API_KEY}"
    
    try:
        #API 요청을 보내는 부분, headers에는 Content-Type이 application/json으로 설정되어 있고, data에는 프롬프트를 포함한 JSON 데이터가 포함됨.
        response = requests.post(
            url, 
            headers={"Content-Type": "application/json"}, 
            data=json.dumps({
                "contents": [{"parts": [{"text": prompt_text}]}],
                "generationConfig": {"response_mime_type": "application/json"}
            })
        )
        
        #response.status_code가 200인 경우, 즉 API 요청이 성공한 경우에는 응답에서 퀴즈 데이터를 추출하여 반환함. 그렇지 않은 경우에는 에러 메시지를 출력하고 빈 리스트를 반환함.
        if response.status_code == 200:
            res_json = response.json()
            # 안전하게 데이터 추출
            candidates = res_json.get('candidates', [])
            if not candidates: return []
            
            # API 응답에서 텍스트 부분을 추출하여 raw_text 변수에 저장, 이후 마크다운 제거 및 JSON 파싱을 통해 최종적으로 퀴즈 데이터를 반환함.
            raw_text = candidates[0]['content']['parts'][0]['text']
            
            # 마크다운 제거 (안전장치)
            import re
            cleaned_text = re.sub(r"```json", "", raw_text, flags=re.IGNORECASE).replace("```", "").strip()
            
            return json.loads(cleaned_text)
        else:
            # API 요청이 실패한 경우 에러 메시지를 출력하고 빈 리스트를 반환함.
            print(f"🚨 API Error: {response.text}")
            return []
    
    # 예외 처리, API 요청 중에 발생할 수 있는 예외를 잡아서 에러 메시지를 출력하고 빈 리스트를 반환함.
    except Exception as e:
        print(f"🚨 Quiz Gen Error: {e}")
        return []