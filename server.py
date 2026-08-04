from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import shutil
import os
import json
import random
import requests
import re
from pdf_processor import process_pdf_generator, count_pdf_pages
from pdf_exporter import create_quiz_pdf, create_report_pdf

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# --- Logs ---
logs = []
def add_log(msg: str):
    print(msg)
    logs.append(msg)
    if len(logs) > 200: logs.pop(0)

@app.get("/logs")
def get_logs(): return {"logs": logs}

@app.post("/reset")
def reset_server():
    logs.clear()
    return {"status": "reset"}

# --- Upload & Extract (기존 동일) ---
@app.post("/upload")
def upload_file(file: UploadFile = File(...)):
    add_log(f"📂 Uploading: {file.filename}...")
    safe_name = f"uploaded_{file.filename}"
    with open(safe_name, "wb") as b: shutil.copyfileobj(file.file, b)
    try: pages = count_pdf_pages(safe_name) if safe_name.endswith('.pdf') else 1
    except: pages = 0
    add_log(f"✅ Uploaded. Total Pages: {pages}")
    return {"status": "success", "filename": safe_name, "original_name": file.filename, "page_count": pages}

@app.post("/extract")
def extract_words(filename: str = Form(...), start_page: int = Form(...), end_page: int = Form(...)):
    add_log(f"⚡ Extracting (P.{start_page}~{end_page})...")
    final = []
    try:
        for mtype, content in process_pdf_generator(filename, start_page, end_page):
            if mtype == "log": add_log(content)
            elif mtype == "data": final.extend(content)
            elif mtype == "error": add_log(f"🚨 {content}")
        for idx, item in enumerate(final):
            if not item.get("id"): item["id"] = str(idx + 1)
        if not final: return {"status": "fail", "message": "No words found"}
        add_log(f"🎉 Done! Found {len(final)} words.")
        return {"status": "success", "data": final}
    except Exception as e: return {"status": "error", "message": str(e)}

# --- Quiz Generation (Type 6 추가) ---
@app.post("/generate-quiz")
def create_quiz(words: str = Form(...), count: int = Form(...), types: str = Form(...)):
    add_log(f"🚀 Generating Quiz ({count} Qs)...")
    try:
        word_list = json.loads(words)
        type_list = [int(t) for t in types.split(",")]
        
        if len(word_list) > count: selected = random.sample(word_list, count)
        else: selected = word_list
        
        # 주관식(Type 6)인 경우
        if 6 in type_list:
            quiz_data = []
            for item in selected:
                quiz_data.append({
                    "type": 6,
                    "question": item['word'],
                    "answer": item['meaning'], # 정답은 뜻
                    "options": [], # 보기 없음
                    "explanation": item.get('example', '')
                })
            add_log(f"✨ Created {len(quiz_data)} Writing Questions!")
            return {"status": "success", "quiz": quiz_data}

        # 객관식(Type 1~5)인 경우
        type_desc = []
        if 1 in type_list: type_desc.append("1. Blank: Sentence with '____'. Options: Words.")
        if 2 in type_list: type_desc.append("2. Eng->Kor: Q: Word. Options: Meanings.")
        if 3 in type_list: type_desc.append("3. Kor->Eng: Q: Meaning. Options: Words.")
        if 4 in type_list: type_desc.append("4. Def->Word: Q: Definition. Options: Words.")
        if 5 in type_list: type_desc.append("5. Word->Def: Q: Word. Options: Definitions.")

        prompt = f"""
        Create a quiz for these words:
        {json.dumps(selected, ensure_ascii=False)}
        Mix these types:
        {chr(10).join(type_desc)}
        Output JSON Array:
        [{{"type": 1, "question": "...", "options": ["A","B","C","D"], "answer": "A", "explanation": "..."}}]
        """
        
        api_key = os.getenv("GOOGLE_API_KEY")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={api_key}"
        resp = requests.post(url, headers={"Content-Type": "application/json"}, data=json.dumps({"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"response_mime_type": "application/json"}}))
        
        if resp.status_code == 200:
            res_json = resp.json()
            cleaned = re.sub(r"```json", "", res_json['candidates'][0]['content']['parts'][0]['text'], flags=re.IGNORECASE).replace("```", "").strip()
            return {"status": "success", "quiz": json.loads(cleaned)}
        else: return {"status": "error", "message": "AI Error"}
    except Exception as e: return {"status": "error", "message": str(e)}

# --- [NEW] AI Grading (주관식 채점) ---
@app.post("/grade-quiz")
def grade_quiz(payload: str = Form(...)):
    add_log("🤖 AI Grading Started...")
    try:
        data = json.loads(payload) # [{"question": "apple", "user_ans": "사과", "correct_ans": "사과"}, ...]
        
        prompt = f"""
        You are a warm and helpful teacher. Grade the student's answers.
        
        [Data]
        {json.dumps(data, ensure_ascii=False)}
        
        [Rules]
        1. Compare 'user_ans' with 'correct_ans'.
        2. If the meaning is similar (even if not exact), mark as CORRECT (true).
        3. If completely wrong or empty, mark as WRONG (false).
        4. Provide short, encouraging feedback in Korean.

        [Output Format JSON]
        [
            {{"correct": true, "feedback": "정확해요!"}},
            {{"correct": false, "feedback": "아쉽네요. 정답은 '사과'입니다."}}
        ]
        """
        
        api_key = os.getenv("GOOGLE_API_KEY")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={api_key}"
        resp = requests.post(url, headers={"Content-Type": "application/json"}, data=json.dumps({"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"response_mime_type": "application/json"}}))
        
        if resp.status_code == 200:
            res_json = resp.json()
            cleaned = re.sub(r"```json", "", res_json['candidates'][0]['content']['parts'][0]['text'], flags=re.IGNORECASE).replace("```", "").strip()
            results = json.loads(cleaned)
            add_log("✅ Grading Complete.")
            return {"status": "success", "results": results}
        else: return {"status": "error", "message": "Grading Failed"}
        
    except Exception as e:
        return {"status": "error", "message": str(e)}

# --- PDF (기존 동일) ---
@app.post("/download-pdf")
def download_pdf(quiz_data: str = Form(...)):
    try:
        create_quiz_pdf(json.loads(quiz_data), "quiz_final.pdf")
        return FileResponse("quiz_final.pdf", filename="quiz_final.pdf", media_type='application/pdf')
    except Exception as e: return {"status": "error", "message": str(e)}

@app.post("/download-report")
def download_report(report_data: str = Form(...)):
    try:
        create_report_pdf(json.loads(report_data), "report_final.pdf")
        return FileResponse("report_final.pdf", filename="report_final.pdf", media_type='application/pdf')
    except Exception as e: return {"status": "error", "message": str(e)}