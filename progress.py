"""
progress.py
-----------
장시간 작업(단어 추출 / 문제 생성)의 진행 상황을 저장하는 인메모리 스토어.

동작 방식:
1. 프론트가 작업을 시작하면 서버가 job_id 를 즉시 발급하고 백그라운드 스레드에서 처리.
2. 처리 중 percent / message / 로그를 이 스토어에 계속 갱신.
3. 프론트는 /progress/{job_id} 를 폴링해 진행 바와 로그를 실시간 표시.
4. 완료되면 status=done 과 result(또는 error)를 담아둔다.

인메모리라 서버 재시작 시 사라지지만, 진행 상황 추적 용도로는 충분하다.
"""

import time
import uuid
import threading

_jobs = {}
_lock = threading.Lock()


def create_job() -> str:
    """새 작업 등록 후 job_id 반환."""
    job_id = uuid.uuid4().hex
    with _lock:
        _jobs[job_id] = {
            "status": "running",   # running | done | error
            "percent": 0,
            "message": "시작하는 중...",
            "logs": [],
            "result": None,
            "error": None,
            "updated": time.time(),
        }
    return job_id


def update(job_id: str, percent=None, message=None, log=None):
    """진행률/메시지/로그 갱신."""
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        if percent is not None:
            job["percent"] = max(0, min(100, int(percent)))
        if message is not None:
            job["message"] = message
        if log is not None:
            job["logs"].append(log)
            if len(job["logs"]) > 300:
                job["logs"].pop(0)
        job["updated"] = time.time()


def finish(job_id: str, result):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["status"] = "done"
        job["percent"] = 100
        job["message"] = "완료!"
        job["result"] = result
        job["updated"] = time.time()


def fail(job_id: str, error: str):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["status"] = "error"
        job["error"] = error
        job["message"] = f"오류: {error}"
        job["updated"] = time.time()


def get(job_id: str):
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def cleanup(max_age_sec=3600):
    """오래된 완료 작업 정리(메모리 누수 방지)."""
    now = time.time()
    with _lock:
        stale = [k for k, v in _jobs.items()
                 if v["status"] != "running" and now - v["updated"] > max_age_sec]
        for k in stale:
            _jobs.pop(k, None)
