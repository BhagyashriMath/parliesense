import { rulesConfig } from "../config";
import fs from "fs";
import path from "path";

type TextModelArtifact = {
  classes: string[];
  vocabulary: string[];
  class_documents: Record<string, number>;
  class_tokens: Record<string, number>;
  token_counts: Record<string, Record<string, number>>;
};

export class AiService {
  private readonly offensiveModel = this.loadTextModel("offensive_model.json");
  private readonly agendaModel = this.loadTextModel("agenda_model.json");

  private loadTextModel(fileName: string): TextModelArtifact | null {
    const modelPaths = [
      path.join(process.cwd(), "ml", "models", fileName),
      path.join(process.cwd(), "..", "ml", "models", fileName)
    ];
    for (const filePath of modelPaths) {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as TextModelArtifact;
      } catch (_) {}
    }
    return null;
  }

  private predictModel(model: TextModelArtifact | null, text: string): Record<string, number> {
    if (!model || !model.classes?.length) return {};
    const tokens = (text || "").toLowerCase().match(/[a-zA-Z']{2,}/g) || [];
    const vocabularySize = Math.max(1, model.vocabulary.length);
    const totalDocuments = Object.values(model.class_documents).reduce((sum, count) => sum + count, 0);
    const scores: Record<string, number> = {};
    for (const label of model.classes) {
      let score = Math.log(((model.class_documents[label] || 0) + 1) / (totalDocuments + model.classes.length));
      const denominator = (model.class_tokens[label] || 0) + vocabularySize;
      for (const token of tokens) {
        score += Math.log(((model.token_counts[label]?.[token] || 0) + 1) / denominator);
      }
      scores[label] = score;
    }
    const maximum = Math.max(...Object.values(scores));
    const probabilities = Object.fromEntries(model.classes.map((label) => [label, Math.exp(scores[label] - maximum)]));
    const normalizer = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
    return Object.fromEntries(Object.entries(probabilities).map(([label, value]) => [label, value / normalizer]));
  }
  /**
   * Analyze speech relevance to the legislative agenda
   */
  analyzeSpeechRelevance(text: string, currentTopic?: string): { score: number; isOffTopic: boolean; matched: string[] } {
    const lower = (text || "").toLowerCase();
    if (!lower.trim()) return { score: 0, isOffTopic: false, matched: [] };

    // Build a topic-aware keyword set.
    // Always include parliamentary/procedural terms, then enrich with words
    // derived from the active bill title so detection adapts at runtime.
    const baseKeywords = new Set([
      "education", "school", "schools", "digital", "ai", "teacher", "budget",
      "broadband", "rural", "stem", "grant", "student", "privacy", "governance",
      "infrastructure", "pedagogy", "curriculum", "solar", "connectivity", "audit", "grants"
    ]);
    const topicWords = currentTopic?.toLowerCase().match(/[a-z]{3,}/g) || [];
    // Replace the default bill-specific base when a different topic is active
    const stopFunctionWords = new Set(["and", "for", "the", "with", "from", "bill", "act", "into", "that"]);
    const hasNewTopic = topicWords.some((w) => !stopFunctionWords.has(w) && !baseKeywords.has(w));
    const keywords = new Set(hasNewTopic ? [] : [...baseKeywords]);
    for (const word of topicWords) {
      if (!stopFunctionWords.has(word)) keywords.add(word);
    }
    // Always keep parliamentary core terms regardless of topic
    for (const coreWord of ["parliament", "committee", "legislation", "amendment", "clause", "section", "member", "minister", "honourable"]) {
      keywords.add(coreWord);
    }

    const matched = [...keywords].filter((keyword) =>
      new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)
    );

    if (
      lower.includes("cricket") ||
      lower.includes("resort") ||
      lower.includes("vacation") ||
      lower.includes("movie") ||
      lower.includes("personal property")
    ) {
      return { score: 0.22, isOffTopic: true, matched: [] };
    }

    const base = (matched.length / 5) * 0.7 + 0.3;
    // Raise minimum floor: short sentences with no keywords should score 0.50
    // so normal conversational phrases don't constantly trip the off-topic rule.
    const score = Math.min(0.98, Math.max(0.50, base));
    const modelProbability = this.predictModel(this.agendaModel, text).on_topic;
    const blendedScore = modelProbability === undefined ? score : (score * 0.8) + (modelProbability * 0.2);
    // Use a lower threshold (0.38) so only genuinely off-topic speech is flagged
    const minThreshold = rulesConfig?.thresholds?.agenda_similarity_min || 0.38;
    return { score: Number(blendedScore.toFixed(2)), isOffTopic: blendedScore < minThreshold, matched };
  }

  /**
   * Classify speaker emotion and acoustic agitation.
   * Uses keyword signals from the transcript text plus dB level as acoustic proxy.
   */
  analyzeEmotion(text: string, noiseDb: number): { label: string; confidence: number; isHeated: boolean } {
    const lower = (text || "").toLowerCase();
    // Angry: extreme language or very loud acoustics
    const angryKeywords = ["shut up", "disgrace", "liar", "fraud", "traitor", "idiot", "stupid", "fool", "moron", "scoundrel", "bloody fool"];
    if (angryKeywords.some((kw) => lower.includes(kw)) || noiseDb > 82) {
      return { label: "Angry", confidence: 0.92, isHeated: true };
    }
    // Heated: strong dissent language or moderately loud acoustics
    const heatedKeywords = ["unacceptable", "outrageous", "shame", "shameful", "protest", "disgraceful", "corrupt", "criminal", "rubbish", "nonsense", "this is wrong", "intolerable", "objection"];
    if (heatedKeywords.some((kw) => lower.includes(kw)) || noiseDb > 74) {
      return { label: "Heated", confidence: 0.88, isHeated: true };
    }
    // Positive: appreciation and commendation
    const positiveKeywords = ["appreciate", "commend", "congratulate", "support", "excellent", "well done", "thank", "grateful", "honour", "agree"];
    if (positiveKeywords.some((kw) => lower.includes(kw))) {
      return { label: "Positive", confidence: 0.91, isHeated: false };
    }
    // Calm: procedural or restrained language
    const calmKeywords = ["respectfully", "clause", "procedure", "pursuant", "order", "schedule", "section", "honourable", "chair", "amendment"];
    if (calmKeywords.some((kw) => lower.includes(kw))) {
      return { label: "Calm", confidence: 0.94, isHeated: false };
    }
    return { label: "Neutral", confidence: 0.86, isHeated: false };
  }

  /**
   * Detect unparliamentary and offensive phrases
   */
  analyzeOffensive(text: string): { isOffensive: boolean; flaggedWords: string[] } {
    const lower = (text || "").toLowerCase();
    const offensiveList = [
      "idiot", "idiotic", "stupid", "moron", "bastard", "corrupt thief", "thief",
      "scoundrel", "liar", "lies", "lie", "shut up", "clown", "traitor", "bloody fool",
      "shameful", "corrupt", "corruption", "cheat", "scam", "fraud", "disgrace",
      "rubbish", "bribe", "criminal", "fool", "nonsense"
    ];
    const flagged = offensiveList.filter((term) => {
      const pattern = term.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      return new RegExp(`\\b${pattern}\\b`, "i").test(lower);
    });
    const modelProbability = this.predictModel(this.offensiveModel, text).offensive || 0;
    return { isOffensive: flagged.length > 0 || modelProbability >= 0.65, flaggedWords: flagged };
  }

  /**
   * Simulate acoustic noise fluctuation.
   * Returns realistic DEMO-mode dB values:
   *  - HIGH_NOISE forced event: 85.6 dB (triggers high-noise alert)
   *  - HEATED forced event: 77.2 dB (triggers heated-debate alert via emotion)
   *  - Baseline: mild jitter around 52 dB to reflect normal chamber ambience
   */
  simulateNoise(forcedEvent: string | null | undefined, currentDb: number): number {
    if (forcedEvent === "HIGH_NOISE") return 85.6;
    if (forcedEvent === "HEATED") return 77.2;
    if (forcedEvent === "OFFENSIVE") return 68.4;
    // Gentle random walk around 52 dB baseline; clamp 48–62 so normal rules don't fire
    const delta = (Math.random() - 0.5) * 4;
    const next = currentDb > 0 ? currentDb + delta : 52;
    return Number(Math.min(62, Math.max(48, next)).toFixed(1));
  }

  /**
   * Simulate computer vision seat occupancy and well-rush displacement
   */
  simulateSeats(forcedEvent: string | null | undefined, currentSeats: Record<string, any>): Record<string, any> {
    const updated = { ...currentSeats };
    for (const seatId of Object.keys(updated)) {
      const s = { ...updated[seatId] };
      if (forcedEvent === "WELL_RUSH" && (seatId === "S06" || seatId === "S006" || seatId === "S02")) {
        s.status = "Moved to Well";
        s.movementStatus = "Well Rush / Displaced";
        s.x = 48;
        s.y = 80;
      } else {
        s.status = "Seated Correctly";
        s.movementStatus = "Normal";
        const idx = parseInt(seatId.replace(/\D/g, "") || "1") - 1;
        const col = idx % 4;
        const row = Math.floor(idx / 4);
        s.x = 18 + col * 22 + (Math.random() * 1.5 - 0.75);
        s.y = 28 + row * 26 + (Math.random() * 1.5 - 0.75);
      }
      updated[seatId] = s;
    }
    return updated;
  }

  /**
   * Generate real-time live synthesis of legislative debate
   */
  generateLiveSummary(currentBill: string, recentTranscripts: Array<Record<string, any>>) {
    const transcripts = recentTranscripts.filter((transcript) =>
      typeof transcript.text === "string" && transcript.text.trim().length > 0
    );
    const speakerNames = Array.from(new Set(transcripts
      .map((transcript) => transcript.speakerName || transcript.name)
      .filter((name): name is string => typeof name === "string" && !name.includes("Pro-Tem"))));
    const stopWords = new Set([
      "about", "after", "again", "against", "also", "among", "because", "before", "being",
      "between", "could", "from", "have", "into", "more", "most", "must", "other", "over",
      "should", "some", "such", "than", "that", "their", "there", "these", "they", "this",
      "those", "through", "under", "very", "what", "when", "where", "which", "while", "with",
      "would", "your", "the", "and", "for", "are", "was", "were", "has", "had", "her", "his",
      "him", "our", "you", "not", "but", "can", "will", "all", "any", "its", "who", "how",
      "then", "them", "been", "said", "speaker", "honourable", "member"
    ]);
    const topicCounts = new Map<string, { occurrences: number; speeches: number }>();
    for (const transcript of transcripts) {
      const words = transcript.text.toLowerCase().match(/[a-z]{4,}/g) || [];
      const speechTopics = new Set<string>();
      for (const word of words) {
        if (stopWords.has(word)) continue;
        const counts = topicCounts.get(word) || { occurrences: 0, speeches: 0 };
        counts.occurrences++;
        speechTopics.add(word);
        topicCounts.set(word, counts);
      }
      for (const topic of speechTopics) {
        const counts = topicCounts.get(topic);
        if (counts) counts.speeches++;
      }
    }
    const keyTopics = [...topicCounts.entries()]
      .sort((a, b) => b[1].occurrences - a[1].occurrences || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([word, counts]) => ({
        title: word.replace(/^./, (first) => first.toUpperCase()),
        description: `Mentioned ${counts.occurrences} time${counts.occurrences === 1 ? "" : "s"} across ${counts.speeches} recent speech${counts.speeches === 1 ? "" : "es"}.`,
        relevance_score: Math.min(100, Math.round((counts.speeches / Math.max(1, transcripts.length)) * 100)),
        speeches_count: counts.speeches
      }));
    const allActionable = transcripts.flatMap((transcript) =>
      transcript.text.split(/(?<=[.!?])\s+/)
        .map((sentence: string) => sentence.trim())
        .filter((sentence: string) => /\b(propose|proposal|recommend|recommendation|suggest|should|establish|create|introduce|implement)\b/i.test(sentence))
        .map((sentence: string) => ({
          sentence,
          member_name: transcript.speakerName || transcript.name || "Unknown speaker",
          party: transcript.party || "—"
        }))
    );
    // Deduplicate by sentence content (some sentences match both idea and suggestion patterns)
    const seenSentences = new Set<string>();
    const actionableStatements = allActionable.filter(({ sentence }) => {
      if (seenSentences.has(sentence)) return false;
      seenSentences.add(sentence);
      return true;
    }).slice(-5);

    const transformativeIdeas = actionableStatements
      .filter(({ sentence }) => /\b(idea|innovative|create|establish|introduce|build)\b/i.test(sentence));
    const policySuggestions = actionableStatements
      .filter(({ sentence }) =>
        /\b(recommend|recommendation|suggest|should|propose|proposal)\b/i.test(sentence) &&
        // Exclude sentences already claimed as transformative ideas
        !transformativeIdeas.some((idea) => idea.sentence === sentence)
      );
    const recentStatements = transcripts.slice(-3).map((transcript) => transcript.text.trim());
    const briefSummary = recentStatements.length
      ? `${transcripts.length} speech${transcripts.length === 1 ? "" : "es"} transcribed on ${currentBill}. Recent contributions: ${recentStatements.join(" ")}`
      : `No speech has been transcribed for ${currentBill} yet.`;

    return {
      session_title: `${currentBill} — Live Session Summary`,
      brief_summary: briefSummary,
      key_topics: keyTopics,
      transformative_ideas: transformativeIdeas
        .map(({ sentence, member_name, party }, index) => ({
          id: `IDEA-${String(index + 1).padStart(2, "0")}`,
          idea: sentence,
          member_name,
          party,
          impact_area: "Extracted from a transcribed speech",
          national_benefit: "Requires human review; no impact claim has been inferred."
        })),
      policy_suggestions: policySuggestions
        .map(({ sentence, member_name }, index) => ({
          id: `SUGG-${String(index + 1).padStart(2, "0")}`,
          suggestion: sentence,
          member_name,
          focus: "Extracted from a transcribed speech",
          development_potential: "Review required"
        })),
      key_keywords: keyTopics.map((topic) => ({
        word: topic.title,
        category: "Transcript topic",
        significance: topic.description
      })),
      speakers: speakerNames,
      last_updated: new Date().toLocaleTimeString()
    };
  }
}

export const aiService = new AiService();
