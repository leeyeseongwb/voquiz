import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed # 병렬 처리용
from pdf2image import convert_from_path, pdfinfo_from_path # PDF 페이지 수 계산용 
from extractor_gemini import extract_data_with_gemini

# PDF 페이지 수 계산 함수
def count_pdf_pages(pdf_path):
    try:
        info = pdfinfo_from_path(pdf_path)
        return info["Pages"]
    except: return 0

# 페이지 하나를 처리하는 함수 (병렬 실행용)
def process_single_page(page_image, page_num):
    # 고유한 임시 파일명 생성 (충돌 방지)
    # temp 파일은 반드시 삭제해야 하므로, try-finally 구조로 안전하게 처리
    # 고유한 임시 파일명 생성 (충돌 방지)
    temp_filename = f"temp_{uuid.uuid4()}.jpg"
    
    try:
        page_image.save(temp_filename, "JPEG")
        
        # AI 분석 호출
        page_data = extract_data_with_gemini(temp_filename)
        
        # 결과에 페이지 번호 태그
        if page_data:
            for item in page_data:
                item['page'] = page_num
        
        return {
            "status": "success",
            "page": page_num,
            "data": page_data
        }
        
    except Exception as e:
        return {
            "status": "error",
            "page": page_num,
            "msg": str(e)
        }
    finally:
        # 파일 삭제 (무조건 실행)
        if os.path.exists(temp_filename):
            try: os.remove(temp_filename)
            except: pass

# PDF 전체를 처리하는 제너레이터 함수 (실시간 로그 및 데이터 반환)
def process_pdf_generator(pdf_path, start_page=1, end_page=None):
    yield ("log", f"🚀 Starting Turbo Processing (Page {start_page}~{end_page})...")
    
    try:
        # 이미지 변환 (여기는 시간이 좀 걸림)
        yield ("log", "📂 Converting PDF to Images...")
        pages = convert_from_path(pdf_path, dpi=300, first_page=start_page, last_page=end_page)
    except Exception as e:
        yield ("error", f"PDF Convert Failed: {e}")
        return

    total_extracted = 0
    # [핵심] 병렬 처리 (Multi-threading)
    # max_workers=5 : 5페이지씩 동시에 처리 (속도 5배 향상)
    # 결제 계정이므로 10~20까지 늘려도 되지만, 5~8 정도가 안정적.
    with ThreadPoolExecutor(max_workers=5) as executor:
        # 작업 예약 (Future 객체 생성)
        # Queue 개념 사용, FIFO!
        future_to_page = {}
        for i, page_img in enumerate(pages):
            current_page_num = start_page + i
            future = executor.submit(process_single_page, page_img, current_page_num)
            future_to_page[future] = current_page_num
            yield ("log", f"⚡ Queued Page {current_page_num}...")

        # 완료되는 순서대로 결과 받기
        for future in as_completed(future_to_page):
            page_num = future_to_page[future]
            try:
                result = future.result()
                
                if result["status"] == "success":
                    data = result["data"]
                    if data:
                        count = len(data)
                        total_extracted += count
                        yield ("data", data)
                        yield ("log", f"   ✅ P.{page_num}: Found {count} words.")
                    else:
                        yield ("log", f"   ⚠️ P.{page_num}: No words.")
                else:
                    yield ("log", f"   🚨 Error P.{page_num}: {result['msg']}")
                    
            except Exception as exc:
                yield ("log", f"   🚨 Critical Error P.{page_num}: {exc}")

    yield ("done", total_extracted)