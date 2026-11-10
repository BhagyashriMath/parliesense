"""
FastAPI Backend Application for AI-Based Parliament Session Monitoring
Provides REST APIs, WebSocket streaming (/ws/session), and telemetry dispatch.
"""

import os
import json
import asyncio
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from services.session_service import SessionService
from services.alert_service import AlertService
from services.report_service import ReportService

app = FastAPI(
    title="AI-Based Parliament Session Monitoring System",
    description="Automated Decision-Support, Decorum Monitoring, and Analytical Scorecard System",
    version="2.4.0"
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

session_service = SessionService()
alert_service = AlertService()
report_service = ReportService()

class EmergencyRequest(BaseModel):
    source: str = "Software Console"
    member_id: Optional[str] = None

class SpeakerChangeRequest(BaseModel):
    member_id: str

@app.get("/")
def root():
    return {
        "system": "AI-Based Parliamentary Monitoring System",
        "status": "OPERATIONAL",
        "version": "2.4.0",
        "mode": session_service.is_demo_mode and "DEMO" or "LIVE",
        "docs_url": "/docs"
    }

@app.get("/api/session/status")
def get_session_status():
    return {
        "session_id": session_service.session_id,
        "is_active": session_service.is_active,
        "mode": "DEMO" if session_service.is_demo_mode else "LIVE",
        "current_bill": session_service.current_bill,
        "active_speaker": session_service.get_active_member(),
        "emergency_status": session_service.emergency_status
    }

@app.get("/api/session/current")
def get_current_session():
    return session_service.generate_current_telemetry()

@app.post("/api/session/start")
def start_session():
    session_service.is_active = True
    return {"status": "SESSION_STARTED", "session_id": session_service.session_id}

@app.post("/api/session/stop")
def stop_session():
    session_service.is_active = False
    return {"status": "SESSION_STOPPED", "session_id": session_service.session_id}

@app.post("/api/session/speaker")
def change_speaker(req: SpeakerChangeRequest):
    session_service.set_active_speaker(req.member_id)
    return {"status": "SPEAKER_UPDATED", "active_speaker": session_service.get_active_member()}

@app.get("/api/transcript")
def get_transcript():
    return {
        "transcripts": session_service.recent_transcripts,
        "count": len(session_service.recent_transcripts)
    }

@app.get("/api/alerts")
def get_alerts():
    return {
        "alerts": session_service.recent_alerts,
        "total_count": len(session_service.recent_alerts)
    }

@app.get("/api/violations")
def get_violations():
    violations = [a for a in session_service.recent_alerts if a.get("rule_id") != "RULE_8_EMERGENCY_BUTTON"]
    return {
        "violations": violations,
        "count": len(violations)
    }

@app.get("/api/members")
def get_members():
    return {
        "members": session_service.members,
        "total_count": len(session_service.members)
    }

@app.get("/api/members/{member_id}")
def get_member_detail(member_id: str):
    for m in session_service.members:
        if m["member_id"] == member_id:
            return m
    raise HTTPException(status_code=404, detail="Member not found")

@app.get("/api/members/{member_id}/scorecard")
def get_member_scorecard(member_id: str):
    member = None
    for m in session_service.members:
        if m["member_id"] == member_id:
            member = m
            break
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")

    history = session_service.member_history.get(member_id, {
        "speaking_time_seconds": 120,
        "speaking_turns": 1,
        "avg_agenda_relevance": 88.0,
        "time_violations": 0,
        "seat_violations": 0,
        "offensive_count": 0,
        "interruption_count": 0,
        "presence_ratio": 1.0
    })
    return session_service.scoring_engine.compute_scorecard(member, history)

@app.get("/api/session/report")
def get_session_report():
    telemetry = session_service.generate_current_telemetry()
    session_data = {
        "session_id": session_service.session_id,
        "current_bill": session_service.current_bill,
        "session_duration_formatted": telemetry.get("session_duration_formatted", "01:00:00"),
        "members": session_service.members
    }
    return report_service.generate_session_report(session_data, session_service.recent_alerts)

@app.get("/api/analytics")
def get_analytics():
    return {
        "noise_history": [52, 54, 58, 62, 55, 78, 83, 60, 54, 52],
        "agenda_relevance_history": [92, 88, 85, 90, 89, 45, 87, 91],
        "emotion_distribution": {
            "Calm": 35,
            "Neutral": 42,
            "Heated": 18,
            "Angry": 3,
            "Positive": 2
        }
    }

@app.get("/api/seats")
def get_seats():
    vision_data = session_service.vision_tracker.process_frame(active_speaker_seat=session_service.get_active_member()["seat_id"])
    return {
        "seats": vision_data["seat_status"],
        "seat_layout": session_service.vision_tracker.seat_layout
    }

@app.get("/api/ai/status")
def get_ai_status():
    return {
        "status": "OPERATIONAL",
        "modules": session_service.get_ai_status()
    }

@app.post("/api/emergency")
def trigger_emergency_event(req: EmergencyRequest):
    alert = session_service.trigger_emergency(source=req.source, member_id=req.member_id)
    return {"status": "EMERGENCY_TRIGGERED", "alert": alert}

@app.post("/api/emergency/reset")
def reset_emergency_event():
    session_service.reset_emergency()
    return {"status": "EMERGENCY_RESET"}

# WebSocket endpoint for real-time live dashboard broadcast
@app.websocket("/ws/session")
async def websocket_session_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            telemetry = session_service.generate_current_telemetry()
            await websocket.send_json(telemetry)
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] Disconnection or error: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
