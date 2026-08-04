from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import black, grey, red, green, blue
import os

def register_fonts():
    fonts = {"Title": ["NanumSquareRoundB.ttf"], "Body": ["NanumSquareRoundR.ttf"]}
    selected = {"Title": "Helvetica-Bold", "Body": "Helvetica"}
    for k, v in fonts.items():
        for p in v:
            if os.path.exists(p):
                pdfmetrics.registerFont(TTFont(p, p)); selected[k]=p; break
    return selected

def create_quiz_pdf(quiz_list, filename="quiz_output.pdf"):
    c = canvas.Canvas(filename, pagesize=A4); w, h = A4; fonts = register_fonts()
    title, body = fonts["Title"], fonts["Body"]
    
    # 1. Questions
    c.setFont(title, 20); c.drawCentredString(w/2, h-40, "Vocabulary Quiz")
    c.setFont("Helvetica", 7); c.setFillColor(grey); c.drawCentredString(w/2, h-52, "AI Generated"); c.setFillColor(black)
    c.setFont(body, 10); c.line(40, h-65, w-40, h-65); c.drawString(40, h-80, "Name: ________________   Date: ________________   Score: _______")
    
    y = h - 110
    for i, q in enumerate(quiz_list):
        if y < 60: c.showPage(); y = h-50
        c.setFont(body, 10)
        
        # 주관식(Type 6) 처리
        if q.get('type') == 6:
            c.drawString(40, y, f"{i+1}. {q['question']}")
            c.line(40, y-20, w-40, y-20) # 입력선
            y -= 35
        else:
            # 객관식
            c.drawString(40, y, f"{i+1}. {q['question']}")
            y -= 15
            c.setFont(body, 9)
            labels = ["A", "B", "C", "D"]
            for idx, opt in enumerate(q['options']):
                c.drawString(55, y, f"{labels[idx]}. {opt}"); y -= 11
            y -= 10
    
    c.showPage()
    
    # 2. Answer Key
    c.setFont(title, 18); c.drawCentredString(w/2, h-50, "Answer Key & Explanation")
    c.setFont(body, 9); y = h - 80
    for i, q in enumerate(quiz_list):
        if y < 50: c.showPage(); y = h-50
        ans_label = ""
        if q.get('type') != 6:
            for idx, opt in enumerate(q['options']):
                if opt == q['answer']: ans_label = f"{['A','B','C','D'][idx]}. "; break
        
        c.setFont(title, 10); c.setFillColor(black)
        c.drawString(40, y, f"{i+1}. {ans_label}{q['answer']}")
        y -= 12
        c.setFont(body, 8); c.setFillColor(grey); c.drawString(40, y, f"   💡 {q.get('explanation','')}"); y -= 18
    c.save()

def create_report_pdf(data, filename="report.pdf"):
    c = canvas.Canvas(filename, pagesize=A4); w, h = A4; fonts = register_fonts()
    title, body = fonts["Title"], fonts["Body"]
    
    c.setFont(title, 22); c.drawCentredString(w/2, h-50, "Detailed Quiz Report")
    c.setFont(title, 30); c.drawCentredString(w/2, h-100, f"{data['score']}%"); 
    c.setFont(body, 12); c.drawCentredString(w/2, h-130, f"Correct: {data['correct']} / {data['total']}")
    c.line(50, h-150, w-50, h-150)
    
    y = h - 180; c.setFont(title, 14); c.drawString(50, y, "Review Results"); y -= 30
    c.setFont(body, 10)
    
    for item in data.get('wrong_list', []): # 실제로는 all_list를 보내서 다 찍는게 좋음
        if y < 80: c.showPage(); y = h-50
        c.setFont(title, 10); c.setFillColor(black); c.drawString(50, y, f"Q{item['idx']}. {item['question']}"); y -= 15
        
        # User Answer
        c.setFont(body, 10)
        c.setFillColor(red if item['user_ans'] != item['correct_ans'] else green)
        c.drawString(60, y, f"Your Answer: {item['user_ans']}")
        y -= 12
        
        # Correct Answer
        c.setFillColor(green)
        c.drawString(60, y, f"Correct Answer: {item['correct_ans']}")
        y -= 12
        
        # Feedback (주관식) or Expl
        c.setFillColor(grey); c.setFont(body, 9)
        c.drawString(60, y, f"Note: {item['explanation']}")
        y -= 25
        
    c.save()