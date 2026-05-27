import { MessageRow, TimelineEventRow } from '../domain';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

export function buildMetricSnapshot(input: {
  event: TimelineEventRow;
  messages: MessageRow[];
  mood: Record<string, any> | null;
}) {
  const latestUserMessage = [...input.messages].reverse().find((message) => message.sender_type === 'user');
  const latestCharacterMessage = [...input.messages].reverse().find((message) => message.sender_type === 'character');
  const text = latestUserMessage?.text ?? '';
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const questionCount = countMatches(text, /\?/g);
  const exclamationCount = countMatches(text, /!/g);
  const emojiCount = countMatches(text, /\p{Extended_Pictographic}/gu);
  const topicShiftStrength = Number(input.mood?.current_topic?.shift_strength ?? 0);
  const valence = Number(input.mood?.current_user_mood?.valence ?? 0);
  const arousal = Number(input.mood?.current_user_mood?.arousal ?? 0.35);

  const userMessages = input.messages.filter((message) => message.sender_type === 'user');
  const characterMessages = input.messages.filter((message) => message.sender_type === 'character');
  const userToCharacterRatio = characterMessages.length ? userMessages.length / characterMessages.length : userMessages.length;

  const lengthScore = clamp01(wordCount / 45);
  const questionScore = clamp01(questionCount / 2);
  const emotionalPunctuationScore = clamp01((exclamationCount + emojiCount) / 4);
  const topicMomentumScore = clamp01(1 - topicShiftStrength);
  const engagementScore = clamp01(lengthScore * 0.28 + questionScore * 0.22 + topicMomentumScore * 0.2 + arousal * 0.2 + clamp01(userToCharacterRatio / 2) * 0.1);
  const interestScore = clamp01(questionScore * 0.35 + lengthScore * 0.25 + topicMomentumScore * 0.3 + Math.max(valence, 0) * 0.1);
  const boredomRisk = clamp01(1 - engagementScore + (input.event.event_type === 'silence_timeout' ? 0.25 : 0));
  const frustrationRisk = clamp01(Math.max(-valence, 0) * 0.65 + Number(input.mood?.new_signal_tone?.label === 'challenging') * 0.15);

  return {
    schema_version: '1.0',
    event_id: input.event.id,
    features: {
      event_type: input.event.event_type,
      user_message_length_chars: text.length,
      user_message_length_words: wordCount,
      question_count: questionCount,
      exclamation_count: exclamationCount,
      emoji_count: emojiCount,
      topic_shift_strength: topicShiftStrength,
      user_to_character_message_ratio: userToCharacterRatio,
      latest_user_message_at: latestUserMessage?.created_at ?? null,
      latest_character_message_at: latestCharacterMessage?.created_at ?? null,
    },
    metrics_event: {
      engagement_score: engagementScore,
      interest_score: interestScore,
      emotional_activation_score: clamp01(arousal * 0.7 + emotionalPunctuationScore * 0.3),
      boredom_risk: boredomRisk,
      frustration_risk: frustrationRisk,
      trust_resonance_score: clamp01(Math.max(valence, 0) * 0.4 + topicMomentumScore * 0.4 + engagementScore * 0.2),
      topic_momentum_score: topicMomentumScore,
      response_quality_proxy: engagementScore,
      return_propensity_score: clamp01(engagementScore * 0.55 + interestScore * 0.35 + (1 - frustrationRisk) * 0.1),
    },
    metrics_rolling: {
      rolling_10_messages: {
        engagement_score: engagementScore,
        boredom_risk: boredomRisk,
      },
      rolling_1h: {
        engagement_score: engagementScore,
        boredom_risk: boredomRisk,
      },
      rolling_24h: {
        engagement_score: engagementScore,
        boredom_risk: boredomRisk,
      },
      conversation_lifetime: {
        engagement_score: engagementScore,
        boredom_risk: boredomRisk,
      },
      character_user_lifetime: {
        engagement_score: engagementScore,
        boredom_risk: boredomRisk,
      },
    },
    quality_summary: {
      overall_dialog_quality: clamp01(engagementScore * 0.45 + interestScore * 0.35 + (1 - boredomRisk) * 0.2),
      most_important_positive_signal: questionCount > 0 ? 'user asked a question' : 'topic continuity',
      most_important_negative_signal: boredomRisk > 0.6 ? 'boredom risk is elevated' : 'none significant',
      confidence: input.mood ? 0.78 : 0.58,
    },
  };
}

export function buildMetricDelta(current: any, previous: any | null, eventId: string, previousEventId: string | null) {
  const keys = ['engagement_score', 'interest_score', 'emotional_activation_score', 'boredom_risk', 'frustration_risk', 'return_propensity_score'];
  const deltas: Record<string, unknown> = {};
  for (const key of keys) {
    const before = Number(previous?.metrics_event?.[key] ?? current.metrics_event[key]);
    const after = Number(current.metrics_event[key]);
    const absolute = Number((after - before).toFixed(4));
    deltas[key] = {
      absolute,
      direction: absolute > 0.02 ? 'up' : absolute < -0.02 ? 'down' : 'stable',
      significance: Math.abs(absolute) > 0.12 ? 'high' : Math.abs(absolute) > 0.05 ? 'medium' : 'low',
    };
  }

  const engagementDelta = (deltas.engagement_score as any).absolute;
  return {
    schema_version: '1.0',
    event_id: eventId,
    previous_event_id: previousEventId,
    deltas,
    direction_summary: {
      overall: engagementDelta > 0.03 ? 'improved' : engagementDelta < -0.03 ? 'degraded' : 'stable',
      short_explanation: previous ? 'Compared current event metrics against the previous event snapshot.' : 'No previous snapshot exists yet.',
    },
    likely_drivers: [],
    attribution_confidence: previous ? 0.55 : 0.2,
  };
}
