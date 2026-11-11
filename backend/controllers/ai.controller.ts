import { Request, Response } from "express";
import { telemetryService } from "../services/telemetry.service";
import { memberService } from "../services/member.service";
import { alertRepository } from "../repositories/alert.repository";
import { auditRepository } from "../repositories/audit.repository";
import { transcriptRepository } from "../repositories/transcript.repository";
import { aiService } from "../services/ai.service";

export class AiController {
  getStatus(req: Request, res: Response): void {
    res.json({
      status: "HEALTHY",
      active_models: 8,
      subsystems: {
        speech_recognition: "ACTIVE",
        nlp_agenda_analysis: "ACTIVE",
        emotion_detection: "ACTIVE",
        offensive_detection: "ACTIVE",
        computer_vision: "ACTIVE",
        noise_analysis: "ACTIVE",
        rule_engine: "ACTIVE",
        database_storage: "ACTIVE"
      }
    });
  }

  async simulateEvent(req: Request, res: Response): Promise<void> {
    const { event_type } = req.body;
    telemetryService.updateState({ forcedEvent: event_type || null });
    await auditRepository.log("SIMULATION_EVENT_TRIGGERED", { event_type });
    res.json({ status: "SIMULATION_TRIGGERED", event_type });
  }

  async processAudio(req: Request, res: Response): Promise<void> {
    const { db_level, decibel, transcript_snippet, member_id } = req.body;
    const level = typeof db_level === "number" ? db_level : decibel;
    if (typeof level === "number" && level > 0) {
      telemetryService.updateState({
        audioNoiseDb: level,
        liveAudioLevel: Math.round((level / 100) * 100),
        lastRealAudioTime: Date.now()
      });
    }
    let transcript;
    const SYSTEM_ALERT_SUBSTRINGS = [
      "unparliamentary language",
      "maintain decorum",
      "active parliamentary agenda",
      "maintain silence",
      "allocated speaking time",
      "seating boundary",
      "outside boundary",
      "no person detected",
      "not seated",
      "called to order",
      "proceedings are now live",
      "you have the floor",
      "recommended for suspension",
      "has been suspended",
      "emergency exit",
      "recognized you"
    ];
    const isAlertEcho = typeof transcript_snippet === "string" && SYSTEM_ALERT_SUBSTRINGS.some(s => transcript_snippet.toLowerCase().includes(s));

    if (!isAlertEcho && typeof transcript_snippet === "string" && transcript_snippet.trim().length >= 2) {
      const activeSpeakerId = telemetryService.getState().activeSpeakerId;
      const user = req.user;
      const isUserSpeaker = user?.role === "speaker";
      const targetMember = member_id ? await memberService.getById(member_id) : null;
      const isSpeakerMember =
        isUserSpeaker ||
        targetMember?.role?.toLowerCase().includes("speaker") ||
        targetMember?.role?.toLowerCase().includes("presiding") ||
        member_id?.startsWith("SP");

      let speakingMember: any = null;

      if (isSpeakerMember) {
        // Presiding Officer (Speaker) has inherent authority to address the House from the Dais at any time
        speakingMember = targetMember || (await memberService.getAll()).find(m => m.role?.toLowerCase().includes("speaker")) || {
          member_id: member_id || "SP001",
          seat_id: "CHAMBER-DAIS",
          name: user?.name || "Hon. Speaker",
          role: "Speaker"
        };
      } else {
        // Floor Member: resolve speaking member from member_id or activeSpeakerId
        const resolvedId = member_id || activeSpeakerId;
        speakingMember = resolvedId ? await memberService.getById(resolvedId) : null;
        if (!speakingMember) {
          speakingMember = memberService.getCachedAll()[0];
        }
      }

      if (speakingMember) {
        const speechAnalysis = aiService.analyzeSpeechRelevance(
          transcript_snippet,
          telemetryService.getState().currentBill
        );
        const emotionAnalysis = aiService.analyzeEmotion(
          transcript_snippet,
          telemetryService.getState().audioNoiseDb
        );
        transcript = await transcriptRepository.save({
          id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          session_id: telemetryService.getState().sessionId,
          member_id: speakingMember.member_id,
          seat_id: speakingMember.seat_id,
          text: transcript_snippet.trim(),
          confidence: 0.95,
          emotion: emotionAnalysis.label,
          relevance: speechAnalysis.score
        });
        telemetryService.broadcast();
      }
    }
    res.json({ status: "AUDIO_TELEMETRY_RECORDED", transcript });
  }

  async memberPresence(req: Request, res: Response): Promise<void> {
    const { member_id, violation_type, seat_id, confidence } = req.body;
    const member = await memberService.getById(member_id);

    const resolvedSeatId = seat_id || member?.seat_id;

    if (violation_type === "NORMAL" || violation_type === "COMPLIANT") {
      if (resolvedSeatId) {
        telemetryService.updateSeatPresence(resolvedSeatId, true, "Normal");
      }
      try {
        await alertRepository.resolveActiveAlertsForMember(member_id, "RULE_7_UNAUTHORIZED_MOVEMENT");
      } catch (_) {}
      res.json({ status: "PRESENCE_RESTORED", member_id, seat_id: resolvedSeatId });
      return;
    }

    const memberSeatNum = (member?.seat_id?.match(/\d+/) || [""])[0];
    const incomingSeatNum = (seat_id?.match(/\d+/) || [""])[0];
    const isSameSeat = !seat_id || !member?.seat_id || (memberSeatNum && incomingSeatNum && parseInt(memberSeatNum, 10) === parseInt(incomingSeatNum, 10)) || seat_id === member?.seat_id;

    const wrongSeat = Boolean(seat_id && !isSameSeat);
    if ((violation_type || wrongSeat) && member) {
      const effectiveViolation = violation_type === "MEMBER_ABSENT" ? "MEMBER_ABSENT" : (wrongSeat ? "WRONG_SEAT_OCCUPANCY" : violation_type);
      telemetryService.updateSeatPresence(
        resolvedSeatId || member.seat_id,
        effectiveViolation !== "MEMBER_ABSENT",
        effectiveViolation === "MEMBER_ABSENT" ? "Absent" : effectiveViolation === "WRONG_SEAT_OCCUPANCY" ? "Wrong Seat" : "Unauthorized Movement"
      );
      const sessionId = telemetryService.getState().sessionId;
      const { alerts } = await alertRepository.findAll({
        sessionId,
        memberId: member_id,
        status: "ACTIVE"
      });
      const movementAlertAlreadyActive = alerts.some((alert) => alert.rule_id === "RULE_7_UNAUTHORIZED_MOVEMENT");
      if (!movementAlertAlreadyActive) {
        const alertId = `ALT-PRES-${member_id}-${Date.now()}`;
        await alertRepository.save({
          alert_id: alertId,
          session_id: sessionId,
          member_id,
          seat_id: resolvedSeatId || member.seat_id,
          rule_id: "RULE_7_UNAUTHORIZED_MOVEMENT",
          type: effectiveViolation,
          severity: effectiveViolation === "MEMBER_ABSENT" || wrongSeat ? "HIGH" : "MEDIUM",
          alert_level: effectiveViolation === "MEMBER_ABSENT" || wrongSeat ? 3 : 2,
          title: effectiveViolation === "MEMBER_ABSENT"
            ? `Member Absent — No Face Visible — ${member.name}`
            : wrongSeat
              ? `Wrong Seat Occupancy — ${member.name}`
              : `Significant Movement Detected — ${member.name}`,
          description: wrongSeat
            ? `${member.name} was detected at ${seat_id}; assigned seat is ${member.seat_id}.`
            : effectiveViolation === "MEMBER_ABSENT"
              ? `Computer vision camera detected no face visible in assigned seat for ${member.name} (${resolvedSeatId || member.seat_id}). Member marked NOT SEATED.`
              : `Vision detected displacement for ${member.name} (Seat ${resolvedSeatId || member.seat_id}).`,
          member_audio_message: effectiveViolation === "MEMBER_ABSENT"
            ? "No face detected in camera. Please return to your seat and face the camera."
            : "Please remain in your assigned seat position.",
          suspension_recommended: false,
          source_module: "Member Presence Monitor",
          status: "ACTIVE"
        });
        if (effectiveViolation !== "MEMBER_ABSENT") {
          await alertRepository.insertViolation(alertId, member_id, "UNAUTHORIZED_MOVEMENT", 10);
          await memberService.update(member_id, {
            violations_count: (member.violations_count || 0) + 1
          });
        }
      }

      telemetryService.broadcast();
    }

    res.json({ status: "PRESENCE_RECORDED", member_id, violation_type, seat_id: resolvedSeatId });
  }
}

export const aiController = new AiController();
