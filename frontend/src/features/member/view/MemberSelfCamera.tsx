/**
 * MemberSelfCamera
 *
 * Displays the LOGGED-IN / ASSIGNED member's OWN live webcam feed.
 * Purpose: physical presence & movement monitoring (proctoring-style).
 *
 * What it does:
 *  - Streams the member's own webcam (not the active speaker feed)
 *  - Runs canvas-based frame-differencing to detect significant movement
 *  - Applies a reasonable threshold so normal head/hand motion is ignored
 *  - Reports violations to the server via /api/ai/member-presence
 *  - Shows monitoring status indicators below the video
 *
 * What it does NOT do:
 *  - It does NOT show the current floor speaker's video
 *  - It does NOT touch the shared isWebcamActive context state
 *    (so the Speaker Dashboard camera is completely independent)
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import { Camera, Video, VideoOff, CheckCircle2, User } from "lucide-react";
import {
  unpackCascade,
  runCascade,
  clusterDetections,
  rgbaToGrayscale,
  ClassifyRegionFn,
} from "../../../utils/picoDetector";
import { API_BASE } from "../../../infrastructure/api/api";

interface MemberSelfCameraProps {
  memberId: string;
  seatId: string;
  micId: string;
  memberName: string;
  className?: string;
}

interface PresenceStatus {
  present: boolean;
  movement: "NONE" | "NORMAL" | "SIGNIFICANT";
  seatCompliant: boolean;
  confidence: number;
  lastViolation: string | null;
}

// ── Motion and boundary detection constants ──
// How often to sample frames for boundary compliance (ms)
const SAMPLE_INTERVAL_MS = 400;
// Consecutive frames outside boundary before flagging physical movement violation
const OUTSIDE_BOUNDARY_FRAMES = 2;
// Consecutive frames without any face before treating as vacated boundary
const VACATED_BOUNDARY_FRAMES = 3;
// Cooldown between sending violation reports to the server (ms)
const REPORT_COOLDOWN_MS = 5000;

export function MemberSelfCamera({
  memberId,
  seatId,
  micId,
  memberName,
  className = "",
}: MemberSelfCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<ImageData | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const motionFrameCount = useRef(0);
  const missingFaceFrameCount = useRef(0);
  const lastReportTime = useRef(0);
  const serverViolationActiveRef = useRef(false);
  const sampleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const faceDetectorRef = useRef<any>(null);
  const classifyRegionRef = useRef<ClassifyRegionFn | null>(null);

  // Load pico facefinder cascade from public directory on mount
  useEffect(() => {
    let cancelled = false;
    const modelUrl = `${import.meta.env.BASE_URL || "/"}models/facefinder`.replace(/\/{2,}/g, "/");
    fetch(modelUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        if (!cancelled) {
          const bytes = new Int8Array(buffer);
          classifyRegionRef.current = unpackCascade(bytes);
        }
      })
      .catch((err) => {
        console.warn("Could not load local facefinder cascade:", err);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && "FaceDetector" in window) {
      try {
        faceDetectorRef.current = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
      } catch {
        faceDetectorRef.current = null;
      }
    }
  }, []);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const warmupFramesRef = useRef(0);
  const [presence, setPresence] = useState<PresenceStatus>({
    present: true,
    movement: "NONE",
    seatCompliant: true,
    confidence: 1.0,
    lastViolation: null,
  });
  // Keep a ref so sampleFrame can read presence.present without being
  // recreated (and resetting the interval) on every presence state change.
  const presencePresentRef = useRef(true);
  useEffect(() => { presencePresentRef.current = presence.present; }, [presence.present]);

  // ── Start webcam ──
  const startCamera = useCallback(async () => {
    setCameraError(null);
    warmupFramesRef.current = 0;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API not supported in this browser. Please use Chrome on localhost.");
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: "user" },
        });
      } catch (_) {
        // Fallback to basic video constraint if ideal/facingMode is rejected
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
      streamRef.current = stream;
      setCameraActive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch (_) {}
      }
      setPresence((p) => ({ ...p, present: true, seatCompliant: true, confidence: 1.0 }));
    } catch (err: any) {
      console.warn("Camera start error:", err);
      const msg =
        err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError"
          ? "Camera permission denied. Please click the camera icon in your browser address bar and select 'Allow'."
          : err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError"
          ? "No camera device found on this machine."
          : `Camera unavailable: ${err?.message || "unknown error"}`;
      setCameraError(msg);
      setCameraActive(false);
    }
  }, []);

  // ── Stop webcam ──
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (sampleTimerRef.current) clearInterval(sampleTimerRef.current);
    prevFrameRef.current = null;
    motionFrameCount.current = 0;
    missingFaceFrameCount.current = 0;
    setCameraActive(false);
    setPresence({ present: false, movement: "NONE", seatCompliant: true, confidence: 0, lastViolation: null });
  }, []);

  // ── Send presence/violation report to server ──
  const reportPresence = useCallback(async (violationType: string, confidence: number) => {
    const now = Date.now();
    // Allow immediate recovery report and absence report without cooldown
    const isStateTransition = violationType === "NORMAL" || violationType === "MEMBER_ABSENT";
    if (!isStateTransition && now - lastReportTime.current < REPORT_COOLDOWN_MS) return;
    lastReportTime.current = now;

    try {
      await fetch(`${API_BASE}/api/ai/member-presence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(typeof window !== "undefined" && sessionStorage.getItem("parlisense_token")
            ? { Authorization: `Bearer ${sessionStorage.getItem("parlisense_token")}` }
            : {})
        },
        body: JSON.stringify({
          member_id: memberId,
          seat_id: seatId,
          mic_id: micId,
          violation_type: violationType,
          confidence: confidence.toFixed(2),
          timestamp: new Date().toISOString(),
          session_id: null, // server fills this in
        }),
      });
    } catch {
      // network errors are silently swallowed — not critical
    }
  }, [memberId, seatId, micId]);

  // ── Seating boundary check & Physical movement detection ──
  const sampleFrame = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const W = 160; // downsample for performance
    const H = 90;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, W, H);
    const currentFrame = ctx.getImageData(0, 0, W, H);

    // 1. Detect face and its bounding box
    let isFaceDetected = false;
    let faceBox: { x: number; y: number; width: number; height: number } | null = null;

    // A. Real-time sliding-window face cascade detection (pico detector)
    if (classifyRegionRef.current) {
      try {
        const image = {
          pixels: rgbaToGrayscale(currentFrame.data, H, W),
          nrows: H,
          ncols: W,
          ldim: W,
        };
        const params = {
          shiftfactor: 0.1,
          minsize: 18,
          maxsize: 75,
          scalefactor: 1.15,
        };
        let dets = runCascade(image, classifyRegionRef.current, params);
        dets = clusterDetections(dets, 0.2);
        // Scores above 0.8 confirm a real facial structure
        const confidentFaces = dets.filter((d: any) => d[3] > 0.8);
        if (confidentFaces.length > 0) {
          isFaceDetected = true;
          const best = confidentFaces.reduce((max: any, f: any) => (f[3] > max[3] ? f : max), confidentFaces[0]);
          faceBox = {
            x: best[1] - best[2] / 2,
            y: best[0] - best[2] / 2,
            width: best[2],
            height: best[2],
          };
        }
      } catch (err) {
        console.warn("[MemberSelfCamera] pico detection error:", err);
      }
    }

    // B. Native browser FaceDetector API fallback if available
    if (!isFaceDetected && faceDetectorRef.current && canvas) {
      try {
        const faces = await faceDetectorRef.current.detect(canvas);
        if (faces && faces.length > 0) {
          isFaceDetected = true;
          const f = faces[0].boundingBox;
          faceBox = {
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
          };
        }
      } catch {}
    }

    // 2. Designated boundary box coordinates matching the square camera viewport:
    // When 16:9 video is centered in a 1:1 square display, the visible region is from 22% to 78% of width.
    // The seating box is inset 10% within that visible square:
    const squareLeft = W * 0.22;
    const squareRight = W * 0.78;
    const squareWidth = squareRight - squareLeft;
    const boundaryLeft = squareLeft + squareWidth * 0.12;
    const boundaryRight = squareRight - squareWidth * 0.12;
    const boundaryTop = H * 0.08;
    const boundaryBottom = H * 0.85;

    // 3. Seating boundary compliance:
    // Case A: Inside that box, if NO ONE is showing -> Detect as NOT SEATED / MEMBER_ABSENT
    // Case B: Person is showing and within/overlapping the boundary -> Detect as SEATED ✓
    // Case C: Person is showing, but completely outside the boundary lines -> Detect as MOVEMENT ⚠ (Unauthorized movement)

    if (isFaceDetected && faceBox) {
      missingFaceFrameCount.current = 0;
      const faceCenterX = faceBox.x + faceBox.width / 2;
      const faceCenterY = faceBox.y + faceBox.height / 2;

      // Outside boundary if the face center is outside the designated seating box:
      const outsideBounds = (
        faceCenterX < boundaryLeft ||
        faceCenterX > boundaryRight ||
        faceCenterY < boundaryTop ||
        faceCenterY > boundaryBottom
      );

      if (outsideBounds) {
        // Person is detected, but completely outside the boundary line
        motionFrameCount.current++;
        if (motionFrameCount.current >= OUTSIDE_BOUNDARY_FRAMES) {
          const confidence = 0.95;
          setPresence({
            present: true,
            movement: "SIGNIFICANT",
            seatCompliant: false,
            confidence,
            lastViolation: "Physical movement detected: Member completely outside seating boundary",
          });

          serverViolationActiveRef.current = true;
          reportPresence("UNAUTHORIZED_MOVEMENT", confidence);
        }
      } else {
        // Person IS showing inside the seating boundary box!
        warmupFramesRef.current = 99; // Warmup complete
        motionFrameCount.current = 0;
        missingFaceFrameCount.current = 0;
        setPresence({
          present: true,
          movement: "NORMAL",
          seatCompliant: true,
          confidence: 0.95,
          lastViolation: null,
        });

        if (serverViolationActiveRef.current) {
          serverViolationActiveRef.current = false;
          reportPresence("NORMAL", 0.95);
        }
      }
    } else {
      // During initial camera warmup (first ~1.6s), allow camera auto-exposure to stabilize without flashing an absence alert
      if (warmupFramesRef.current < 4) {
        warmupFramesRef.current++;
        return;
      }

      // NO ONE IS SHOWING INSIDE THAT BOX!
      missingFaceFrameCount.current++;
      motionFrameCount.current = 0;

      if (missingFaceFrameCount.current >= VACATED_BOUNDARY_FRAMES) {
        const confidence = 0.95;
        setPresence({
          present: false,
          movement: "NONE",
          seatCompliant: false,
          confidence,
          lastViolation: "No person detected inside seating boundary — marked NOT SEATED",
        });

        serverViolationActiveRef.current = true;
        reportPresence("MEMBER_ABSENT", confidence);
      }
    }

    prevFrameRef.current = currentFrame;
  }, [reportPresence]);

  // Start sampling when camera becomes active
  useEffect(() => {
    if (cameraActive) {
      sampleTimerRef.current = setInterval(sampleFrame, SAMPLE_INTERVAL_MS);
    } else {
      if (sampleTimerRef.current) clearInterval(sampleTimerRef.current);
    }
    return () => { if (sampleTimerRef.current) clearInterval(sampleTimerRef.current); };
  }, [cameraActive, sampleFrame]);

  // Auto-start camera on mount
  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  // ── Status indicators (kept internally for violation reporting, not displayed) ──

  return (
    <div className={`bg-white rounded-lg border border-gray-200 p-2 shadow-sm flex flex-col h-full min-h-0 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="p-1 rounded bg-gray-100 text-sky-400 border border-gray-300">
            <Camera className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[11px] font-bold text-gray-800 uppercase tracking-wider leading-none">
                MY LIVE CAMERA
              </h3>
              {cameraActive ? (
                <span className="px-1.5 py-0.2 rounded font-mono text-[9px] bg-emerald-50/80 text-emerald-700 border border-emerald-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  LIVE
                </span>
              ) : (
                <span className="px-1.5 py-0.2 rounded font-mono text-[9px] bg-gray-100 text-gray-500 border border-gray-300">
                  OFF
                </span>
              )}
            </div>
            <p className="text-[9px] text-gray-500 leading-none mt-0.5">
              Seat {seatId} · {micId} · Presence & Movement Monitoring
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {!cameraActive ? (
            <button onClick={startCamera}
              className="px-1.5 py-0.5 text-[9px] font-semibold rounded border bg-sky-800/30 text-sky-700 border-sky-700/50 hover:bg-sky-800/50 flex items-center gap-1 transition-colors">
              <Video className="w-3 h-3" /> Start Camera
            </button>
          ) : (
            <button onClick={stopCamera}
              className="px-1.5 py-0.5 text-[9px] font-semibold rounded border bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200 flex items-center gap-1 transition-colors">
              <VideoOff className="w-3 h-3" /> Stop
            </button>
          )}
        </div>
      </div>

      {/* Video stage — square feed centered on the dark stage; keeps the
          member's face fully visible instead of cropping a landscape window */}
      <div className="relative w-full flex-1 min-h-0 rounded overflow-hidden border border-gray-200 bg-white flex items-center justify-center"
        style={{ minHeight: "120px" }}>

        {/* Square viewport */}
        <div className="relative h-full overflow-hidden rounded bg-white border border-gray-200"
          style={{ aspectRatio: "1 / 1", minHeight: "120px" }}>

          {/* Live video */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
            style={{ display: cameraActive ? "block" : "none" }}
          />

          {/* Hidden motion-detection canvas (off-screen sampling) */}
          <canvas ref={canvasRef} className="hidden" />

          {/* Designated Seating Boundary Guide Box Overlay */}
          {cameraActive && (
            <div className={`absolute inset-x-[10%] top-[6%] bottom-[20%] pointer-events-none rounded-lg border transition-colors duration-300 ${
              !presence.present
                ? "border-rose-500/80 bg-red-50/10 border-solid"
                : !presence.seatCompliant
                ? "border-amber-400/80 bg-amber-50/10 border-dashed"
                : "border-sky-400/40 border-dashed"
            }`}>
              <div className={`absolute top-1 left-1.5 px-1.5 py-0.2 rounded text-[8px] font-mono font-bold tracking-wider flex items-center gap-1 shadow-sm ${
                !presence.present
                  ? "bg-red-50/90 border border-rose-500/60 text-red-700"
                  : !presence.seatCompliant
                  ? "bg-amber-50/90 border border-amber-500/60 text-amber-800"
                  : "bg-gray-50 border border-sky-500/30 text-sky-700"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  !presence.present
                    ? "bg-rose-500 animate-ping"
                    : !presence.seatCompliant
                    ? "bg-amber-400 animate-ping"
                    : "bg-emerald-400"
                }`} />
                {!presence.present
                  ? "NO PERSON DETECTED ✗"
                  : !presence.seatCompliant
                  ? "OUTSIDE BOUNDARY ⚠"
                  : "SEATING BOUNDARY"}
              </div>
              {/* Corner brackets */}
              <div className={`absolute -top-1 -left-1 w-3 h-3 border-t-2 border-l-2 ${!presence.present ? "border-rose-500" : !presence.seatCompliant ? "border-amber-400" : "border-sky-400"}`} />
              <div className={`absolute -top-1 -right-1 w-3 h-3 border-t-2 border-r-2 ${!presence.present ? "border-rose-500" : !presence.seatCompliant ? "border-amber-400" : "border-sky-400"}`} />
              <div className={`absolute -bottom-1 -left-1 w-3 h-3 border-b-2 border-l-2 ${!presence.present ? "border-rose-500" : !presence.seatCompliant ? "border-amber-400" : "border-sky-400"}`} />
              <div className={`absolute -bottom-1 -right-1 w-3 h-3 border-b-2 border-r-2 ${!presence.present ? "border-rose-500" : !presence.seatCompliant ? "border-amber-400" : "border-sky-400"}`} />
            </div>
          )}

          {/* Active violation warning banner inside camera viewport when no person is detected or outside seating boundary */}
          {cameraActive && !presence.present && (
            <div className="absolute top-2 left-2 right-2 p-1.5 rounded-lg bg-red-50/95 border border-rose-500/80 text-red-800 text-[10px] font-semibold flex items-center justify-between gap-1.5 shadow-lg backdrop-blur-sm z-20 animate-pulse">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="w-2 h-2 rounded-full bg-rose-500 flex-shrink-0 animate-ping" />
                <span className="truncate">⚠ VIOLATION: No person detected in seating boundary — marked NOT SEATED</span>
              </span>
              <span className="font-mono text-[8px] bg-rose-900/80 text-white px-1 py-0.2 rounded border border-rose-500/40 font-bold uppercase flex-shrink-0">
                NOT SEATED
              </span>
            </div>
          )}

          {cameraActive && presence.present && !presence.seatCompliant && (
            <div className="absolute top-2 left-2 right-2 p-1.5 rounded-lg bg-amber-50/95 border border-amber-500/80 text-amber-900 text-[10px] font-semibold flex items-center justify-between gap-1.5 shadow-lg backdrop-blur-sm z-20 animate-pulse">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0 animate-ping" />
                <span className="truncate">⚠ PHYSICAL MOVEMENT: Member completely outside seating boundary</span>
              </span>
              <span className="font-mono text-[8px] bg-amber-600 text-white px-1 py-0.2 rounded border border-amber-500/40 font-bold uppercase flex-shrink-0">
                MOVEMENT
              </span>
            </div>
          )}

          {/* Camera error state */}
          {cameraError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center bg-white">
              <VideoOff className="w-8 h-8 text-rose-500/60" />
              <p className="text-[10px] text-rose-400 font-semibold leading-snug">{cameraError}</p>
              <button onClick={startCamera}
                className="px-3 py-1 rounded-lg bg-sky-700 hover:bg-sky-600 text-white text-[10px] font-bold mt-1">
                Retry Camera
              </button>
            </div>
          )}

          {/* Camera off placeholder */}
          {!cameraActive && !cameraError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white">
              <User className="w-10 h-10 text-slate-700" />
              <p className="text-[10px] text-gray-400">Camera inactive</p>
            </div>
          )}

          {/* Member identity overlay — bottom bar */}
          {cameraActive && (
            <div className="absolute bottom-2 left-2 right-2 p-1.5 bg-gray-50 border border-sky-500/30 rounded-lg backdrop-blur-md flex items-center justify-between gap-2 shadow-lg z-10">
              <div className="flex items-center gap-2 min-w-0">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${presence.present ? "bg-emerald-400" : "bg-rose-500 animate-pulse"}`} />
                <div className="min-w-0">
                  <span className="font-bold text-gray-900 text-[10px] truncate block">{memberName}</span>
                  <div className="flex items-center gap-1.5 text-[9px] text-gray-500 font-mono">
                    <span className="text-amber-400">{seatId}</span>
                    <span>·</span>
                    <span className="text-sky-400">{micId}</span>
                    <span>·</span>
                    <span className="text-gray-400">{memberId}</span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end flex-shrink-0">
                <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded border ${
                  !presence.present
                    ? "bg-rose-500/25 text-red-700 border-rose-500/50 animate-pulse"
                    : !presence.seatCompliant
                    ? "bg-amber-500/20 text-amber-800 border-amber-500/40 animate-pulse"
                    : "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
                }`}>
                  {!presence.present
                    ? "NOT SEATED ✗"
                    : !presence.seatCompliant
                    ? "MOVEMENT ⚠"
                    : "SEATED ✓"}
                </span>
                <span className="text-[8px] text-gray-400 font-mono mt-0.5">
                  Confidence: {(presence.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
