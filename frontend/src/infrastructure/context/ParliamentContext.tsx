import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import confetti from "canvas-confetti";
import { SessionTelemetry, MemberScorecard, SessionReport, Member, UserSession } from "../../shared/types";
import {
  subscribeToSessionStream,
  fetchMembers,
  fetchMemberScorecard,
  fetchSessionReport,
  triggerEmergency as apiTriggerEmergency,
  resetEmergency as apiResetEmergency,
  setActiveSpeaker as apiSetActiveSpeaker,
  raiseHand as apiRaiseHand,
  withdrawHand as apiWithdrawHand,
  rejectFloorRequest as apiRejectFloorRequest,
  releaseFloor as apiReleaseFloor,
  toggleSessionState as apiToggleSessionState,
  startSession as apiStartSession,
  stopSession as apiStopSession,
  pauseSession as apiPauseSession,
  resumeSession as apiResumeSession,
  setSessionMode as apiSetSessionMode,
  acknowledgeAlert as apiAcknowledgeAlert,
  simulateAIEvent as apiSimulateAIEvent,
  sendAudioTelemetry,
  speakerMicOn as apiSpeakerMicOn,
  speakerMicOff as apiSpeakerMicOff
} from "../api/api";
import {
  setChamberMuted,
  playChamberAlertChime,
  speakAlert,
  speakFloorSpeech,
  isSystemAlertPlaying,
  isSystemAlertEcho
} from "../../shared/utils/chamberAudio";
import {
  startVoiceSend,
  stopVoiceSend,
  startVoiceListen,
  stopVoiceListen
} from "../../shared/utils/chamberVoice";

export interface ParliamentContextType {
  telemetry: SessionTelemetry | null;
  members: Member[];
  refreshMembers: () => Promise<void>;
  currentTab: "speaker" | "member" | "admin";
  setCurrentTab: (tab: "speaker" | "member" | "admin") => void;
  currentUser: UserSession | null;
  activeView: "login" | "register" | "dashboard";
  setActiveView: (view: "login" | "register" | "dashboard") => void;
  login: (role: "admin" | "speaker" | "member", memberId?: string, displayName?: string) => void;
  logout: () => void;
  navigateToRegister: () => void;
  navigateToLogin: () => void;
  selectedMemberId: string;
  setSelectedMemberId: (id: string) => void;
  activeScorecard: MemberScorecard | null;
  isScorecardOpen: boolean;
  openScorecard: (memberId: string) => Promise<void>;
  closeScorecard: () => void;
  activeReport: SessionReport | null;
  isReportOpen: boolean;
  openReport: () => Promise<void>;
  closeReport: () => void;
  isEndingSession: boolean;
  endSessionAndGenerateReport: () => Promise<void>;
  triggerEmergency: (source?: string) => Promise<void>;
  resetEmergency: () => Promise<void>;
  switchSpeaker: (memberId: string) => Promise<void>;
  raiseHand: () => Promise<boolean>;
  withdrawHand: () => Promise<void>;
  rejectFloorRequest: (memberId: string) => Promise<void>;
  releaseFloor: () => Promise<void>;
  startSession: () => Promise<void>;
  toggleSession: (start: boolean) => Promise<void>;
  pauseSession: () => Promise<void>;
  resumeSession: () => Promise<void>;
  switchMode: (mode: "LIVE" | "DEMO") => Promise<void>;
  acknowledgeAlert: (alertId: string) => Promise<void>;
  simulateEvent: (eventType: string) => Promise<void>;
  isMuted: boolean;
  setIsMuted: (muted: boolean) => void;
  activateSpeakerMic: () => Promise<void>;
  deactivateSpeakerMic: () => Promise<void>;
  isWebcamActive: boolean;
  setIsWebcamActive: (active: boolean) => void;
  isMicActive: boolean;
  setIsMicActive: (active: boolean) => void;
  liveMicDb: number;
  interimTranscript: string;
}

export const ParliamentContext = createContext<ParliamentContextType | undefined>(undefined);

export function ParliamentProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [telemetry, setTelemetry] = useState<SessionTelemetry | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  // Authentication & Role Session
  const [currentUser, setCurrentUser] = useState<UserSession | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const role = params.get("role") as "admin" | "speaker" | "member" | null;
    const id = params.get("id");
    if (role && (role === "admin" || role === "speaker" || role === "member")) {
      const user = {
        role,
        memberId: id || (role === "speaker" ? "SP001" : role === "member" ? "M001" : "USR-ADM-001"),
        loginTime: new Date().toLocaleTimeString()
      };
      try {
        sessionStorage.setItem("parlisense_auth_user", JSON.stringify(user));
        localStorage.setItem("parlisense_auth_user", JSON.stringify(user));
      } catch (_) {}
      return user;
    }
    try {
      const saved = sessionStorage.getItem("parlisense_auth_user") || localStorage.getItem("parlisense_auth_user");
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return null;
  });

  const [activeView, setActiveView] = useState<"login" | "register" | "dashboard">(() => {
    if (window.location.pathname === "/register" || window.location.hash === "#register") return "register";
    return currentUser ? "dashboard" : "login";
  });

  const [currentTab, setCurrentTab] = useState<"speaker" | "member" | "admin">(() => {
    return currentUser?.role || "speaker";
  });

  const [selectedMemberId, setSelectedMemberId] = useState<string>(() => {
    return currentUser?.memberId || "M001";
  });
  const [activeScorecard, setActiveScorecard] = useState<MemberScorecard | null>(null);
  const [isScorecardOpen, setIsScorecardOpen] = useState(false);
  const [activeReport, setActiveReport] = useState<SessionReport | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isWebcamActive, setIsWebcamActive] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [liveMicDb, setLiveMicDb] = useState<number>(52.4);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isEndingSession, setIsEndingSession] = useState(false);

  // Tracks mic intent so the Web Speech API restart logic survives stale closures
  const micActiveRef = useRef(isMicActive);
  micActiveRef.current = isMicActive;
  // Tracks the floor member so recognition is NOT torn down/restarted whenever
  // a scorecard selects a different member mid-speech.
  const selectedMemberIdRef = useRef(selectedMemberId);
  selectedMemberIdRef.current = selectedMemberId;
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;
  const telemetryRef = useRef(telemetry);
  telemetryRef.current = telemetry;

  const refreshMembers = async () => {
    try {
      const res = await fetchMembers();
      const list = res?.members ?? (Array.isArray(res) ? res : []);
      setMembers(list);
    } catch (err) {
      console.error("Failed to refresh members:", err);
    }
  };

  useEffect(() => {
    setChamberMuted(isMuted);
  }, [isMuted]);

  useEffect(() => {
    refreshMembers();

    const seenTranscriptIds = new Set<string>();
    const seenAlertIds = new Set<string>();
    let initialSyncDone = false;

    const unsubscribe = subscribeToSessionStream((data) => {
      setTelemetry(data);

      if (!initialSyncDone) {
        // Prime seen sets with historical data on initial load
        (data.recent_transcripts || []).forEach((t) => seenTranscriptIds.add(t.id));
        (data.recent_alerts || []).forEach((a) => seenAlertIds.add(a.alert_id));
        initialSyncDone = true;
        return;
      }

      const isUserSpeaker = currentUserRef.current?.role === "speaker";
      const isUserAdmin = currentUserRef.current?.role === "admin";
      const currentMemberId = isUserSpeaker
        ? (currentUserRef.current?.memberId || "SP001")
        : (currentUserRef.current?.memberId || selectedMemberIdRef.current);

      // 1. Live Floor Speech — real voice is broadcast via /ws/audio WebSocket.
      // No TTS synthesis here; actual microphone audio plays on all listeners.
      // We still track seen IDs so we don't re-process old transcripts on reconnect.
      (data.recent_transcripts || []).forEach((t) => {
        if (!seenTranscriptIds.has(t.id)) {
          seenTranscriptIds.add(t.id);
          // Real voice audio is handled by chamberVoice.ts — nothing to do here.
        }
      });

      // 2. Live Decorum Alerts & Warnings Audio:
      // When rule infractions occur, play the alert chime and voice the warning message.
      (data.recent_alerts || []).forEach((a) => {
        if (!seenAlertIds.has(a.alert_id)) {
          seenAlertIds.add(a.alert_id);

          const isTargetedToMe = !a.member_id || a.member_id === currentMemberId || a.seat_id === currentMemberId;
          const isChamberWide = !a.member_id && !a.seat_id;
          const shouldPlayForUser = isTargetedToMe || isChamberWide || isUserSpeaker || isUserAdmin;

          if (shouldPlayForUser) {
            playChamberAlertChime(a.severity);
            const alertMsg = a.member_audio_message || a.description || a.title;
            if (alertMsg) {
              const isCritical = a.severity === "CRITICAL" || a.severity === "HIGH";
              speakAlert(alertMsg, a.rule_id || a.type || "alert", isCritical);
            }
          }
        }
      });
    });

    return () => unsubscribe();
  }, []);

  // Real-time microphone: dB analyser + Web Speech API STT + real-voice broadcast
  useEffect(() => {
    if (!isMicActive) {
      // Not sending — listen to others' real voice
      startVoiceListen();
      return () => {
        stopVoiceListen();
      };
    }

    // Mic is active — send real voice to all listeners, stop listening to avoid feedback
    stopVoiceListen();

    let audioContext: AudioContext | null = null;
    let micStream: MediaStream | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let recognition: any = null;
    let recognitionRunning = false;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    let lastInterimText = "";
    let interimFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushInterim = () => {
      if (lastInterimText.trim().length >= 2) {
        const textToCommit = lastInterimText.trim();
        lastInterimText = "";
        if (isSystemAlertPlaying() || isSystemAlertEcho(textToCommit)) {
          if (!cancelled) setInterimTranscript("");
          return;
        }
        const isUserSpeakerRole = currentUserRef.current?.role === "speaker";
        const currentMemberId = isUserSpeakerRole
          ? (currentUserRef.current?.memberId || "SP001")
          : (currentUserRef.current?.memberId || selectedMemberIdRef.current);

        sendAudioTelemetry(0, textToCommit, currentMemberId).catch((err) => {
          console.warn("[STT] Failed to send audio telemetry:", err);
        });
        if (!cancelled) setInterimTranscript("");
      }
    };

    const setupRecognition = () => {
      if (!SpeechRecognitionAPI || cancelled) return null;
      try {
        const rec = new SpeechRecognitionAPI();
        rec.continuous = true;
        rec.interimResults = true;
        // Prioritize Indian English, fallback to browser locale or US English
        rec.lang = "en-IN";
        rec.maxAlternatives = 1;

        rec.onstart = () => {
          recognitionRunning = true;
          console.log("[STT] Speech recognition started listening...");
        };

        rec.onresult = (event: any) => {
          // If system warning alert voice is currently speaking, suppress microphone pickup
          if (isSystemAlertPlaying()) {
            lastInterimText = "";
            if (!cancelled) setInterimTranscript("");
            return;
          }

          let interim = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const text = event.results[i][0].transcript.trim();

            // Filter out system alert echoes (e.g. "unparliamentary language", "maintain decorum", "seating boundary")
            if (isSystemAlertEcho(text)) {
              console.log("[STT] Suppressed system alert voice pickup:", text);
              continue;
            }

            if (event.results[i].isFinal) {
              if (text.length >= 2) {
                lastInterimText = "";
                if (interimFlushTimer) clearTimeout(interimFlushTimer);
                const isUserSpeakerRole = currentUserRef.current?.role === "speaker";
                const currentMemberId = isUserSpeakerRole
                  ? (currentUserRef.current?.memberId || "SP001")
                  : (currentUserRef.current?.memberId || selectedMemberIdRef.current);

                console.log(`[STT] Final transcript detected for ${currentMemberId}: "${text}"`);
                sendAudioTelemetry(0, text, currentMemberId).catch((err) => {
                  console.warn("[STT] Failed to send audio telemetry:", err);
                });
              }
            } else {
              interim += text;
            }
          }
          lastInterimText = interim;
          if (!cancelled) setInterimTranscript(interim);

          // Flush unfinalized interim speech after 1.8s of silence so words are never dropped
          if (interimFlushTimer) clearTimeout(interimFlushTimer);
          if (interim.length >= 2) {
            interimFlushTimer = setTimeout(() => {
              flushInterim();
            }, 1800);
          }
        };

        rec.onerror = (e: any) => {
          console.warn("[STT] recognition error event:", e.error);
          recognitionRunning = false;
          if (e.error === "not-allowed") {
            console.error("[STT] Microphone permission denied in browser.");
            return;
          }
          if (!cancelled && micActiveRef.current) {
            if (restartTimer) clearTimeout(restartTimer);
            restartTimer = setTimeout(startRecognition, 400);
          }
        };

        rec.onend = () => {
          recognitionRunning = false;
          flushInterim();
          if (!cancelled && micActiveRef.current) {
            if (restartTimer) clearTimeout(restartTimer);
            restartTimer = setTimeout(startRecognition, 300);
          }
        };

        return rec;
      } catch (err) {
        console.warn("[STT] Failed to initialize SpeechRecognition:", err);
        return null;
      }
    };

    const startRecognition = () => {
      if (cancelled || !micActiveRef.current) return;
      if (recognitionRunning) return;

      if (!recognition) {
        recognition = setupRecognition();
      }
      if (!recognition) return;

      try {
        recognition.start();
        recognitionRunning = true;
      } catch (err: any) {
        recognitionRunning = false;
        // In case recognition was in closing state or InvalidStateError, re-setup fresh instance
        if (err?.name === "InvalidStateError") {
          try { recognition.stop(); } catch (_) {}
          recognition = null;
        }
        if (!cancelled && micActiveRef.current) {
          if (restartTimer) clearTimeout(restartTimer);
          restartTimer = setTimeout(startRecognition, 500);
        }
      }
    };

    const stopRecognition = () => {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      recognitionRunning = false;
      if (recognition) {
        try { recognition.stop(); } catch (_) {}
        recognition = null;
      }
    };

    // 1. Start SpeechRecognition immediately & independently
    if (SpeechRecognitionAPI) {
      startRecognition();
    } else {
      console.warn("Web Speech API not supported in this browser. Chrome or Edge recommended.");
    }

    // 2. Start audio dB analyser if getUserMedia is permitted
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          micStream = stream;
          startVoiceSend(stream);
          audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          const source = audioContext.createMediaStreamSource(stream);
          source.connect(analyser);
          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          intervalId = setInterval(() => {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            const avg = sum / dataArray.length;
            // Calculate realistic acoustic decibels (42 dB ambient up to 96 dB for loud voice)
            const decibels = Math.round((42 + (avg / 128) * 46) * 10) / 10;
            setLiveMicDb(decibels);
            sendAudioTelemetry(decibels, undefined, selectedMemberIdRef.current).catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.warn("Audio meter getUserMedia notice (non-fatal):", err?.message || err);
          // Do NOT cancel isMicActive here so SpeechRecognition can continue running natively!
        });
    }

    return () => {
      cancelled = true;
      setInterimTranscript("");
      stopRecognition();
      stopVoiceSend();
      if (intervalId) clearInterval(intervalId);
      if (micStream) micStream.getTracks().forEach((t) => t.stop());
      if (audioContext) audioContext.close();
    };
  }, [isMicActive]);

  const openScorecard = async (memberId: string) => {
    try {
      const card = await fetchMemberScorecard(memberId);
      setActiveScorecard(card);
      setSelectedMemberId(memberId);
      setIsScorecardOpen(true);
    } catch (err) {
      console.error("Failed to load scorecard:", err);
    }
  };

  const closeScorecard = () => {
    setIsScorecardOpen(false);
  };

  const openReport = async () => {
    try {
      const rep = await fetchSessionReport();
      setActiveReport(rep);
      setIsReportOpen(true);
    } catch (err) {
      console.error("Failed to load session report:", err);
    }
  };

  const closeReport = () => {
    setIsReportOpen(false);
  };

  const endSessionAndGenerateReport = async () => {
    setIsEndingSession(true);
    setIsMicActive(false);
    setInterimTranscript("");
    // Instant optimistic update across all local components & tabs
    setTelemetry((prev) => (prev ? {
      ...prev,
      is_active: false,
      is_paused: false,
      active_speaker: undefined,
      speaking_duration_seconds: 0
    } : null));

    try {
      await apiStopSession();
    } catch (err) {
      console.warn("API stopSession warning:", err);
    }

    try {
      const rep = await fetchSessionReport();
      setActiveReport(rep);
      setIsReportOpen(true);
      try {
        confetti({
          particleCount: 80,
          spread: 70,
          origin: { y: 0.6 },
          colors: ["#d97706", "#f59e0b", "#10b981", "#3b82f6"]
        });
      } catch (_) {}
    } catch (err) {
      console.error("Failed to generate session report:", err);
    } finally {
      setIsEndingSession(false);
    }
  };

  const triggerEmergency = async (source?: string) => {
    try {
      await apiTriggerEmergency(source);
    } catch (err) {
      console.error("Failed to trigger emergency:", err);
    }
  };

  const resetEmergency = async () => {
    try {
      await apiResetEmergency();
    } catch (err) {
      console.error("Failed to reset emergency:", err);
    }
  };

  const switchSpeaker = async (memberId: string) => {
    try {
      await apiSetActiveSpeaker(memberId);
    } catch (err) {
      console.error("Failed to switch speaker:", err);
    }
  };

  const raiseHand = async (): Promise<boolean> => {
    try {
      await apiRaiseHand();
      return true;
    } catch (err: any) {
      console.error("Failed to raise hand:", err);
      // Surface the error to the member so they know to log in properly
      const msg = err?.message?.includes("401") || err?.message?.includes("Authentication")
        ? "Authentication required. Please log out and log back in as a Member."
        : err?.message || "Could not raise hand. Please try again.";
      alert(msg);
      return false;
    }
  };

  const withdrawHand = async () => {
    try {
      await apiWithdrawHand();
    } catch (err) {
      console.error("Failed to withdraw hand:", err);
    }
  };

  const rejectFloorRequest = async (memberId: string) => {
    try {
      await apiRejectFloorRequest(memberId);
    } catch (err) {
      console.error("Failed to decline request:", err);
    }
  };

  const releaseFloor = async () => {
    try {
      await apiReleaseFloor();
    } catch (err) {
      console.error("Failed to release floor:", err);
    }
  };

  const pauseSession = async () => {
    try {
      await apiPauseSession();
    } catch (err) {
      console.error("Failed to pause session:", err);
    }
  };

  const resumeSession = async () => {
    try {
      await apiResumeSession();
    } catch (err) {
      console.error("Failed to resume session:", err);
    }
  };

  const startSession = async () => {
    try {
      const res = await apiStartSession();
      setInterimTranscript("");
      setIsMicActive(false);
      setTelemetry((prev) => prev ? {
        ...prev,
        session_id: res?.session_id || `PAR-${Date.now()}`,
        is_active: true,
        is_paused: false,
        session_duration_seconds: 0,
        session_duration_formatted: "00:00:00",
        active_speaker: undefined,
        speaking_duration_seconds: 0,
        member_speaking_seconds: {},
        recent_transcripts: [],
        recent_alerts: []
      } : prev);
    } catch (err) {
      console.error("Failed to start session:", err);
      throw err;
    }
  };

  const toggleSession = async (start: boolean) => {
    try {
      if (!start) {
        await pauseSession();
      } else if (!telemetry?.is_active) {
        // Fresh launch: use the live start endpoint instead of the resume
        // endpoint (which expects an already-active, paused session).
        await startSession();
      } else {
        await resumeSession();
      }
    } catch (err) {
      console.error("Failed to toggle session:", err);
    }
  };

  const switchMode = async (mode: "LIVE" | "DEMO") => {
    try {
      await apiSetSessionMode(mode);
    } catch (err) {
      console.error("Failed to switch mode:", err);
    }
  };

  const acknowledgeAlert = async (alertId: string) => {
    try {
      await apiAcknowledgeAlert(alertId);
    } catch (err) {
      console.error("Failed to acknowledge alert:", err);
    }
  };

  const simulateEvent = async (eventType: string) => {
    try {
      await apiSimulateAIEvent(eventType);
    } catch (err) {
      console.error("Failed to simulate event:", err);
    }
  };

  const login = (role: "admin" | "speaker" | "member", memberId?: string, displayName?: string) => {
    const resolvedMemberId = memberId || (role === "speaker"
      ? members.find((member) => member.role?.toLowerCase() === "speaker")?.member_id
      : role === "member" ? (members[0]?.member_id || "M001") : undefined);
    const mem = resolvedMemberId ? members.find((m) => m.member_id === resolvedMemberId) : undefined;
    const session: UserSession = {
      role,
      memberId: resolvedMemberId,
      memberName: mem?.name || displayName || (role === "admin" ? "Parliament Administrator" : undefined),
      seatId: mem?.seat_id,
      loginTime: new Date().toLocaleTimeString()
    };
    setCurrentUser(session);
    try {
      sessionStorage.setItem("parlisense_auth_user", JSON.stringify(session));
    } catch (_) {}
    if (session.memberId) {
      setSelectedMemberId(session.memberId);
    }
    setCurrentTab(role);
    setActiveView("dashboard");
    navigate("/dashboard");
  };

  const logout = () => {
    sessionStorage.removeItem("parlisense_token");
    setCurrentUser(null);
    try {
      localStorage.removeItem("parlisense_auth_user");
      sessionStorage.removeItem("parlisense_auth_user");
    } catch (_) {}
    window.history.replaceState({}, "", window.location.pathname);
    setActiveView("login");
    navigate("/login");
  };

  const navigateToRegister = () => {
    setActiveView("register");
    navigate("/register");
  };

  const navigateToLogin = () => {
    setActiveView("login");
    navigate("/login");
  };

  useEffect(() => {
    if (currentUser?.role === "member" && currentUser.memberId) {
      const m = members.find((x) => x.member_id === currentUser.memberId);
      if (m && (!currentUser.memberName || !currentUser.seatId)) {
        setCurrentUser((prev) => prev ? ({ ...prev, memberName: m.name, seatId: m.seat_id }) : null);
      }
    }
  }, [members, currentUser]);

  // Synchronize router location with activeView and currentTab
  useEffect(() => {
    if (location.pathname === "/register") {
      setActiveView("register");
    } else if (location.pathname === "/login") {
      setActiveView("login");
    } else if (location.pathname === "/speaker") {
      setCurrentTab("speaker");
      setActiveView("dashboard");
    } else if (location.pathname.startsWith("/member")) {
      setCurrentTab("member");
      setActiveView("dashboard");
    } else if (location.pathname === "/admin") {
      setCurrentTab("admin");
      setActiveView("dashboard");
    } else if (location.pathname === "/dashboard" || location.pathname === "/") {
      setActiveView("dashboard");
    }
  }, [location.pathname]);

  return (
    <ParliamentContext.Provider
      value={{
        telemetry,
        members,
        refreshMembers,
        currentTab,
        setCurrentTab,
        currentUser,
        activeView,
        setActiveView,
        login,
        logout,
        navigateToRegister,
        navigateToLogin,
        selectedMemberId,
        setSelectedMemberId,
        activeScorecard,
        isScorecardOpen,
        openScorecard,
        closeScorecard,
        activeReport,
        isReportOpen,
        openReport,
        closeReport,
        isEndingSession,
        endSessionAndGenerateReport,
        triggerEmergency,
        resetEmergency,
        switchSpeaker,
        raiseHand,
        withdrawHand,
        rejectFloorRequest,
        releaseFloor,
        startSession,
        toggleSession,
        pauseSession,
        resumeSession,
        switchMode,
        acknowledgeAlert,
        simulateEvent,
        isMuted,
        setIsMuted,
        isWebcamActive,
        setIsWebcamActive,
        isMicActive,
        setIsMicActive,
        liveMicDb,
        interimTranscript
      }}
    >
      {children}
    </ParliamentContext.Provider>
  );
}

export function useParliament() {
  const context = useContext(ParliamentContext);
  if (!context) {
    throw new Error("useParliament must be used within a ParliamentProvider");
  }
  return context;
}
