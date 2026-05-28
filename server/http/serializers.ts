import { CharacterRow, ConversationMetricSnapshotRow, ConversationRow, MessageRow } from '../domain';
import { StorageService } from '../services/storage';

type MetricDirection = 'up' | 'down' | 'stable';
type MetricImpact = 'better' | 'worse' | 'stable';

const DISPLAY_METRICS = [
  { key: 'overall_dialog_quality', label: 'Overall quality', source: 'quality_summary', risk: false },
  { key: 'engagement_score', label: 'Engagement', source: 'metrics_event', risk: false },
  { key: 'interest_score', label: 'Interest', source: 'metrics_event', risk: false },
  { key: 'trust_resonance_score', label: 'Trust resonance', source: 'metrics_event', risk: false },
  { key: 'boredom_risk', label: 'Boredom risk', source: 'metrics_event', risk: true },
  { key: 'frustration_risk', label: 'Frustration risk', source: 'metrics_event', risk: true },
] as const;

function toPercent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(Math.max(0, Math.min(1, numeric)) * 100);
}

function toDeltaPercent(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 1000) / 10;
}

function normalizeDirection(value: unknown): MetricDirection {
  return value === 'up' || value === 'down' || value === 'stable' ? value : 'stable';
}

function impactForDirection(direction: MetricDirection, risk: boolean): MetricImpact {
  if (direction === 'stable') return 'stable';
  if (risk) return direction === 'down' ? 'better' : 'worse';
  return direction === 'up' ? 'better' : 'worse';
}

function overallDirection(delta: Record<string, any> | null): MetricDirection {
  const overall = delta?.direction_summary?.overall;
  if (overall === 'improved') return 'up';
  if (overall === 'degraded') return 'down';
  return 'stable';
}

export function serializeCharacter(row: CharacterRow) {
  const theme = row.theme ?? {};
  return {
    id: row.slug,
    name: row.name,
    codename: row.codename,
    avatar: row.avatar_storage_path ?? '',
    avatarAssetKey: row.avatar_storage_path ?? '',
    avatarObjectPosition: typeof theme.avatarObjectPosition === 'string' ? theme.avatarObjectPosition : undefined,
    shortDesc: row.short_desc,
    longDesc: row.long_desc,
    role: row.role,
    themeColor: String(theme.themeColor ?? '#ECFF19'),
    secondaryColor: String(theme.secondaryColor ?? '#ECFF19'),
    glowColor: String(theme.glowColor ?? ''),
    borderColor: String(theme.borderColor ?? ''),
    status: row.status,
    traits: row.traits,
    specials: row.specials,
    suggestedPrompts: row.suggested_prompts,
  };
}

export function serializeConversation(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    lastMessage: row.last_message_preview ?? '',
    timestamp: row.last_message_at ?? row.created_at,
  };
}

export async function serializeMessage(row: MessageRow, storage: StorageService) {
  const media = [];
  for (const item of row.media ?? []) {
    media.push({
      id: item.id,
      type: item.media_type,
      url: await storage.createSignedUrl(item),
      altText: item.alt_text ?? '',
      width: item.width,
      height: item.height,
    });
  }

  return {
    id: row.id,
    sender: row.sender_type,
    text: row.text ?? '',
    timestamp: row.created_at,
    mood: row.display_emotion ?? undefined,
    clientMessageId: row.client_message_id ?? undefined,
    media,
  };
}

export function serializeConversationMetrics(row: ConversationMetricSnapshotRow | null) {
  if (!row) return null;

  const snapshot = row.snapshot ?? {};
  const delta = row.delta ?? null;
  const metricsEvent = snapshot.metrics_event ?? {};
  const qualitySummary = snapshot.quality_summary ?? {};

  const metrics = DISPLAY_METRICS.map((metric) => {
    const valueSource = metric.source === 'quality_summary' ? qualitySummary : metricsEvent;
    const deltaItem = delta?.deltas?.[metric.key] ?? null;
    const direction = metric.key === 'overall_dialog_quality'
      ? overallDirection(delta)
      : normalizeDirection(deltaItem?.direction);

    return {
      key: metric.key,
      label: metric.label,
      value: toPercent(valueSource?.[metric.key]),
      delta: toDeltaPercent(deltaItem?.absolute),
      direction,
      impact: impactForDirection(direction, metric.risk),
    };
  });

  return {
    eventId: row.event_id,
    generatedAt: row.created_at,
    overallDialogQuality: toPercent(qualitySummary.overall_dialog_quality),
    metrics,
  };
}
