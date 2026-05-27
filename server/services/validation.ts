const actionTypes = new Set(['send_text', 'send_image', 'send_text_image', 'no_response']);

export function assertObject(value: unknown, label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function validateMoodOutput(value: unknown, eventId: string): Record<string, any> {
  assertObject(value, 'mood output');
  if (value.event_id !== eventId) value.event_id = eventId;
  assertObject(value.current_user_mood, 'current_user_mood');
  assertObject(value.new_signal_tone, 'new_signal_tone');
  assertObject(value.current_topic, 'current_topic');
  assertObject(value.risk_flags, 'risk_flags');
  return value;
}

export function validateCharacterOutput(value: unknown, eventId: string): Record<string, any> {
  assertObject(value, 'character output');
  if (value.event_id !== eventId) value.event_id = eventId;
  assertObject(value.action, 'action');
  assertObject(value.silence_timer, 'silence_timer');
  assertObject(value.selected_hypothesis, 'selected_hypothesis');
  assertObject(value.safety_check, 'safety_check');

  if (!actionTypes.has(value.action.type)) {
    throw new Error(`Unsupported character action type: ${value.action.type}`);
  }
  if (typeof value.silence_timer.pause_seconds !== 'number' || !Number.isFinite(value.silence_timer.pause_seconds)) {
    throw new Error('silence_timer.pause_seconds must be numeric');
  }
  if (['send_image', 'send_text_image'].includes(value.action.type)) {
    assertObject(value.action.media, 'action.media');
    if (value.action.media.ok !== true) {
      throw new Error('Image action requires successful action.media from generate_personapulse_image');
    }
    const bucket = value.action.media.storage_bucket ?? value.action.media.bucket;
    const path = value.action.media.storage_path ?? value.action.media.path;
    if (typeof bucket !== 'string' || !bucket.trim() || typeof path !== 'string' || !path.trim()) {
      throw new Error('Image action.media requires storage_bucket and storage_path');
    }
  }
  if (value.safety_check.within_character !== true || value.safety_check.no_policy_violations !== true) {
    throw new Error('Character output failed safety_check');
  }
  return value;
}
