const API_URL = "http://127.0.0.1:8000";
let serverFile = "", totalPages = 0;
let rawWords = [], filteredWords = [], quizData = [], userAnswers = {}, reportData = {};
let currentTypes = [1]; // 기본값: 빈칸 채우기
let logInterval = null, lastLogCount = 0;

// ============================================================
// 1. Log System (Polling)
// ============================================================
const logBox = document.getElementById('log-content');

function startLogPolling() {
    if (logInterval) clearInterval(logInterval);
    fetch(`${API_URL}/clear_logs`, { method: "POST" });
    logInterval = setInterval(async () => {
        try {
            const res = await fetch(`${API_URL}/logs`);
            const data = await res.json();
            const logs = data.logs;
            if (logs.length > lastLogCount) {
                for (let i = lastLogCount; i < logs.length; i++) addLogToScreen(logs[i]);
                lastLogCount = logs.length;
            }
        } catch (e) {}
    }, 1000);
}

function addLogToScreen(msg) {
    const div = document.createElement('div');
    div.className = "log-line";
    let color = "#aaa";
    if (msg.includes("✅") || msg.includes("Success")) color = "#4caf50";
    if (msg.includes("🚨") || msg.includes("Error") || msg.includes("Fail")) color = "#ff5252";
    if (msg.includes("📄") || msg.includes("Page") || msg.includes("Upload") || msg.includes("Grading")) color = "#58a6ff";
    div.innerHTML = `<span style="color:${color}">${msg}</span>`;
    logBox.appendChild(div);
    logBox.scrollTop = logBox.scrollHeight;
}
startLogPolling();

// ============================================================
// 2. Full Reset
// ============================================================
window.fullReset = async function() {
    try { await fetch(`${API_URL}/reset`, { method: "POST" }); } catch(e){}
    serverFile = ""; totalPages = 0; 
    rawWords = []; filteredWords = []; quizData = []; userAnswers = {}; reportData = {};
    currentTypes = [1];
    
    document.getElementById('fileInput').value = "";
    
    // UI 초기화
    document.getElementById('step-1').classList.remove('hidden');
    document.getElementById('view-upload').classList.remove('hidden');
    document.getElementById('view-file-info').classList.add('hidden');
    
    document.getElementById('step-2').classList.add('hidden');
    document.getElementById('step-3').classList.add('hidden');
    document.getElementById('step-4').classList.add('hidden');
    
    // 타입 선택 초기화
    document.querySelectorAll('.type-card').forEach(el => el.classList.remove('selected'));
    const defaultType = document.querySelector('.type-card[data-value="1"]');
    if(defaultType) defaultType.classList.add('selected');

    logBox.innerHTML = '<div class="log-line" style="color:#aaa;">[SYSTEM] Ready.</div>';
    lastLogCount = 0;
};

document.getElementById('btn-reset-top').addEventListener('click', () => { if(confirm("Confirm Reset?")) window.fullReset(); });
document.getElementById('btn-restart').addEventListener('click', window.fullReset);

// ============================================================
// 3. Upload Logic
// ============================================================
const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('change', async () => {
    if (serverFile) { alert("File exists. Reset first."); fileInput.value = ""; return; }
    const f = fileInput.files[0];
    if (!f) return;
    
    addLogToScreen("⏳ Uploading...");
    const form = new FormData(); form.append("file", f);
    
    try {
        const res = await fetch(`${API_URL}/upload`, { method:"POST", body:form });
        const result = await res.json();
        if (result.status === "success") {
            serverFile = result.filename; totalPages = result.page_count;
            
            document.getElementById('view-upload').classList.add('hidden');
            document.getElementById('view-file-info').classList.remove('hidden');
            
            document.getElementById('file-name').innerText = result.original_name;
            document.getElementById('page-count').innerText = `(${totalPages} Pages)`;
            
            document.getElementById('endPage').value = totalPages || 1;
            document.getElementById('endPage').max = totalPages || 1;
            
            const pEnd = document.getElementById('pEnd');
            if(pEnd) { pEnd.max = totalPages || 1; pEnd.value = totalPages || 1; }
            
        } else alert("Upload Failed");
    } catch (e) { alert("Server Error"); }
});

window.removeFile = function() { window.fullReset(); }
document.getElementById('btn-remove-file').addEventListener('click', window.fullReset);

window.selectAll = function() { 
    document.getElementById('startPage').value = 1; 
    document.getElementById('endPage').value = totalPages || 1; 
}
document.getElementById('btn-select-all').addEventListener('click', window.selectAll);

// ============================================================
// 4. Extract Logic
// ============================================================
document.getElementById('btn-extract').addEventListener('click', async () => {
    const start = document.getElementById('startPage').value;
    const end = document.getElementById('endPage').value;
    const btn = document.getElementById('btn-extract');
    
    btn.disabled = true; btn.innerText = "⏳ Extracting...";
    
    const form = new FormData();
    form.append("filename", serverFile); form.append("start_page", start); form.append("end_page", end);
    
    try {
        const res = await fetch(`${API_URL}/extract`, { method:"POST", body:form });
        const result = await res.json();
        if (result.status === "success") {
            rawWords = result.data;
            document.getElementById('step-1').classList.add('hidden');
            document.getElementById('step-2').classList.remove('hidden');
            document.getElementById('wEnd').value = rawWords.length;
            updateList();
        } else alert("Failed: " + result.message);
    } catch (e) { alert("Server Error"); } 
    finally { btn.disabled = false; btn.innerText = "⚡ Extract Words"; }
});

// ============================================================
// 5. Filter Logic
// ============================================================
['wStart', 'wEnd', 'pStart', 'pEnd', 'exclude'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', updateList);
});

// 라디오 버튼 이벤트 (필터 모드)
document.querySelectorAll('input[name="filterMode"]').forEach(radio => {
    radio.addEventListener('change', updateList);
});

function updateList() {
    const modeRadio = document.querySelector('input[name="filterMode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'seq';
    const exSet = new Set(document.getElementById('exclude').value.split(',').map(s=>s.trim()));
    filteredWords = [];

    if (mode === 'seq') {
        document.getElementById('seq-controls').classList.remove('hidden');
        document.getElementById('page-controls').classList.add('hidden');
        const s = parseInt(document.getElementById('wStart').value) || 1;
        const e = parseInt(document.getElementById('wEnd').value) || rawWords.length;
        filteredWords = rawWords.filter((w, i) => {
            const seq = i + 1;
            const idCheck = w.id ? !exSet.has(w.id) : true;
            return seq >= s && seq <= e && !exSet.has(String(seq)) && idCheck;
        });
    } else {
        document.getElementById('seq-controls').classList.add('hidden');
        document.getElementById('page-controls').classList.remove('hidden');
        const ps = parseInt(document.getElementById('pStart').value) || 1;
        const pe = parseInt(document.getElementById('pEnd').value) || 1;
        filteredWords = rawWords.filter(w => {
            const p = w.page || 1;
            const idCheck = w.id ? !exSet.has(w.id) : true;
            return p >= ps && p <= pe && idCheck;
        });
    }
    
    const container = document.getElementById('word-preview');
    if (filteredWords.length === 0) container.innerHTML = "<div style='text-align:center; padding:20px; color:#666;'>No words selected.</div>";
    else container.innerHTML = filteredWords.map((w, i) => `<div style="font-size:0.85em; border-bottom:1px solid #a7a7a7; padding:5px; display:flex; justify-content:space-between;"><span><span style="color:#2979ff;">${i+1}.</span> <b>${w.word}</b> (P.${w.page||'?'})</span><span style="color:#888;">${w.meaning||''}</span></div>`).join('');
}

// ============================================================
// 6. Type Selector (New Card Style)
// ============================================================
window.toggleType = function(el, mode) {
    const val = parseInt(el.getAttribute('data-value'));
    
    if (mode === 'single') {
        // 주관식(6) 선택 시 나머지 해제
        document.querySelectorAll('.type-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        currentTypes = [6];
    } else {
        // 객관식 선택 시 주관식(6) 해제
        const type6 = document.querySelector('.type-card[data-value="6"]');
        if(type6) type6.classList.remove('selected');
        if (currentTypes.includes(6)) currentTypes = [];
        
        el.classList.toggle('selected');
        
        if (el.classList.contains('selected')) {
            if(!currentTypes.includes(val)) currentTypes.push(val);
        } else {
            currentTypes = currentTypes.filter(t => t !== val);
        }
    }
};

// ============================================================
// 7. Generate Quiz
// ============================================================
document.getElementById('btn-generate').addEventListener('click', async () => {
    const count = document.getElementById('qCount').value;
    
    if (!filteredWords.length) return alert("No words selected");
    if (!currentTypes.length) return alert("Select at least one quiz type");
    
    const btn = document.getElementById('btn-generate');
    btn.innerText = "Generating..."; btn.disabled = true;
    
    const form = new FormData();
    form.append("words", JSON.stringify(filteredWords));
    form.append("count", count); 
    form.append("types", currentTypes.join(","));
    
    try {
        const res = await fetch(`${API_URL}/generate-quiz`, { method:"POST", body:form });
        const result = await res.json();
        
        if (result.status === "success") {
            quizData = result.quiz;
            document.getElementById('step-2').classList.add('hidden');
            document.getElementById('step-3').classList.remove('hidden');
            renderQuiz();
        } else alert("Failed: " + result.message);
    } catch (e) { alert("Server Error"); }
    finally { btn.innerText = "🔥 Generate Quiz"; btn.disabled = false; }
});

// ============================================================
// 8. Render Quiz (Normal vs Type 6)
// ============================================================
function renderQuiz() {
    const box = document.getElementById('quiz-container');
    box.innerHTML = ""; userAnswers = {};
    
    // Type 6: Writing (Grid)
    if (quizData.length > 0 && quizData[0].type === 6) {
        const grid = document.createElement('div');
        grid.className = "writing-grid"; // style.css에 정의됨
        
        quizData.forEach((q, i) => {
            grid.innerHTML += `
                <div class="writing-word">${i+1}. ${q.question}</div>
                <div class="writing-cell">
                    <input id = "writing-input-${i}" type="text" class="writing-input" data-idx="${i}" placeholder="뜻을 입력하세요" size = "30" style="width: 100%; padding: 10px; background: var(--card); border: 1px solid var(--border); color: var(--text); border-radius: 4px; box-sizing: border-box;">
                </div>
            `;
        });
        box.appendChild(grid);
        
        // 입력 이벤트
        document.querySelectorAll('.writing-input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                userAnswers[e.target.dataset.idx] = e.target.value;
            });
        });

    } else {
        // Normal: Multiple Choice
        const labels = ["A", "B", "C", "D"];
        quizData.forEach((q, i) => {
            const item = document.createElement('div');
            item.className = "quiz-item";
            const opts = q.options.map((o, idx) => `
                <label class="quiz-opt">
                    <input type="radio" name="q${i}" value="${o}" onclick="check(${i}, '${q.answer.replace(/'/g, "\\'")}', this)"> 
                    <span style="color:#58a6ff; font-weight:bold; margin-right:8px;">${labels[idx]}.</span> ${o}
                </label>
            `).join('');
            item.innerHTML = `<div class="quiz-q">${i+1}. ${q.question}</div><div class="quiz-options">${opts}</div><div id="ans-${i}" class="ans-box"></div>`;
            box.appendChild(item);
        });
    }
}

// 객관식 정답 체크
window.check = function(idx, ans, radio) {
    userAnswers[idx] = radio.value;
    const div = document.getElementById(`ans-${idx}`);
    const expl = quizData[idx].explanation;
    div.classList.remove('correct', 'wrong'); div.classList.add('show');
    if (radio.value === ans) {
        div.classList.add('correct'); div.innerHTML = `✅ Correct!<br><small>${expl}</small>`;
    } else {
        div.classList.add('wrong'); div.innerHTML = `❌ Wrong. Answer: <b>${ans}</b><br><small>${expl}</small>`;
    }
};

// ============================================================
// 9. Finish & Grade
// ============================================================
document.getElementById('btn-finish').addEventListener('click', async () => {
    const btn = document.getElementById('btn-finish');
    
    // Type 6: AI Grading
    if (quizData.length > 0 && quizData[0].type === 6) {
        btn.innerText = "🤖 AI Grading..."; btn.disabled = true;
        const payload = quizData.map((q, i) => ({
            question: q.question, user_ans: userAnswers[i] || "", correct_ans: q.answer
        }));
        
        try {
            const form = new FormData(); form.append("payload", JSON.stringify(payload));
            const res = await fetch(`${API_URL}/grade-quiz`, { method:"POST", body:form });
            const result = await res.json();
            if (result.status === "success") {
                showReportType6(result.results);
            } else alert("Grading Failed");
        } catch(e) { alert("Error"); }
        finally { btn.innerText = "🏁 Finish Quiz"; btn.disabled = false; }
        
    } else {
        showReportNormal();
    }
});

function showReportNormal() {
    let correct = 0;
    reportData = { score:0, total:quizData.length, correct:0, wrong_list:[] };
    const list = document.getElementById('wrong-list');
    list.innerHTML = "";
    
    quizData.forEach((q, i) => {
        if (userAnswers[i] === q.answer) correct++;
        else {
            reportData.wrong_list.push({ idx: i+1, question: q.question, user_ans: userAnswers[i]||"-", correct_ans: q.answer, explanation: q.explanation });
            list.innerHTML += `<div style="margin-bottom:10px; padding:10px; background:#f5f5f5; border-radius:4px;"><b>Q${i+1}. ${q.question}</b><br><span style="color:#ff5252">You: ${userAnswers[i]||"-"}</span> / <span style="color:#2979ff">Ans: ${q.answer}</span></div>`;
        }
    });
    finalizeReport(correct);
}

function showReportType6(results) {
    let correct = 0;
    reportData = { score:0, total:quizData.length, correct:0, wrong_list:[] };
    const list = document.getElementById('wrong-list');
    list.innerHTML = "";
    
    results.forEach((r, i) => {
        if (r.correct) correct++;
        else {
            reportData.wrong_list.push({ idx: i+1, question: quizData[i].question, user_ans: userAnswers[i]||"-", correct_ans: quizData[i].answer, explanation: r.feedback });
            list.innerHTML += `<div style="margin-bottom:10px; padding:10px; background:#f5f5f5; border-radius:4px;">
                <b>${quizData[i].question}</b><br>
                <span style="color:#ff5252">You: ${userAnswers[i]||"-"}</span><br>
                <span style="color:#2979ff">Ans: ${quizData[i].answer}</span><br>
                <span style="color:#aaa; font-size:0.85em;">🤖 ${r.feedback}</span>
            </div>`;
        }
    });
    finalizeReport(correct);
}

function finalizeReport(correct) {
    const total = quizData.length;
    reportData.score = Math.round((correct/total)*100);
    reportData.correct = correct;
    
    document.getElementById('score-display').innerText = `${reportData.score}%`;
    document.getElementById('correct-count').innerText = correct;
    document.getElementById('total-count').innerText = total;
    
    document.getElementById('step-3').classList.add('hidden');
    document.getElementById('step-4').classList.remove('hidden');
}

// ============================================================
// 10. Downloads (Timestamped Filename)
// ============================================================
function getTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

async function handleDownload(type, btnId) {
    if (!quizData.length) return;
    const btn = document.getElementById(btnId);
    const oldText = btn.innerText; btn.innerText = "⏳..."; btn.disabled = true;
    
    const endpoint = type === 'quiz' ? '/download-pdf' : '/download-report';
    const payloadKey = type === 'quiz' ? 'quiz_data' : 'report_data';
    const payloadData = type === 'quiz' ? quizData : reportData;
    
    const timeStr = getTimestamp();
    const fileName = type === 'quiz' ? `Vocab Quiz Generated on ${timeStr}.pdf` : `Quiz Report Generated on ${timeStr}.pdf`;

    const form = new FormData(); 
    form.append(payloadKey, JSON.stringify(payloadData));
    
    try {
        const res = await fetch(`${API_URL}${endpoint}`, { method:"POST", body:form });
        if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download=fileName;
            document.body.appendChild(a); a.click(); a.remove();
        } else alert("Failed");
    } catch (e) { alert("Server Error"); }
    finally { btn.innerText = oldText; btn.disabled = false; }
}

document.getElementById('btn-download-quiz').addEventListener('click', () => handleDownload('quiz', 'btn-download-quiz'));
document.getElementById('btn-dl-quiz-2').addEventListener('click', () => handleDownload('quiz', 'btn-dl-quiz-2'));
document.getElementById('btn-dl-report').addEventListener('click', () => handleDownload('report', 'btn-dl-report'));



// Finish & Generate Report Data
window.finishQuiz = function() {
    const total = quizData.length;
    let correctCount = 0;
    const wrongListDiv = document.getElementById('wrong-list');
    wrongListDiv.innerHTML = "";
    
    // [중요] 모든 문제 데이터를 리포트에 담습니다 (오답만 담는게 아니라)
    reportData = { score: 0, total: total, correct: 0, wrong_list: [] };
    
    quizData.forEach((q, i) => {
        let isCorrect = false;
        // 주관식은 AI가 채점한 결과 사용, 객관식은 단순 비교
        if(q.type === 6) {
            // (이미 grade-quiz API를 통해 채점된 결과가 있다고 가정하거나, 여기서 단순 비교)
            // 간단하게 텍스트 포함 여부로 처리 (실제로는 AI 채점 결과를 써야 함)
            isCorrect = (userAnswers[i] && userAnswers[i].trim() === q.answer.trim());
        } else {
            isCorrect = (userAnswers[i] === q.answer);
        }

        if (isCorrect) correctCount++;
        
        // 리포트용 데이터 (모든 문제 저장)
        reportData.wrong_list.push({
            idx: i + 1,
            question: q.question,
            user_ans: userAnswers[i] || "(Skipped)",
            correct_ans: q.answer,
            explanation: q.explanation
        });

        // 화면에는 틀린 것만 표시 (공간 절약)
        if (!isCorrect) {
            const div = document.createElement('div');
            div.style.cssText = "margin-bottom:15px; padding:15px; background:#f5f5f5; border-radius:6px; border-left:4px solid #ff5252;";
            div.innerHTML = `
                <div style="font-weight:bold; margin-bottom:5px; color:#ddd;">Q${i+1}. ${q.question}</div>
                <div style="color:#ff5252;">Your: ${userAnswers[i] || "-"}</div>
                <div style="color:#2979ff;">Ans: ${q.answer}</div>
                <div style="color:#888; font-size:0.85em; margin-top:5px;">💡 ${q.explanation}</div>
            `;
            wrongListDiv.appendChild(div);
        }
    });
    
    const percentage = Math.round((correctCount/total)*100);
    reportData.score = percentage;
    reportData.correct = correctCount;

    document.getElementById('score-display').innerText = `${percentage}%`;
    document.getElementById('correct-count').innerText = correctCount;
    document.getElementById('total-count').innerText = total;
    
    if(correctCount === total) wrongListDiv.innerHTML = "<div style='text-align:center; padding:20px; color:#2979ff;'>🎉 Perfect Score!</div>";
    
    document.getElementById('step-3').classList.add('hidden');
    document.getElementById('step-4').classList.remove('hidden');
};