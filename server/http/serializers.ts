import { CharacterRow, ConversationRow, MessageRow } from '../domain';
import { StorageService } from '../services/storage';

export function serializeCharacter(row: CharacterRow) {
  const theme = row.theme ?? {};
  return {
    id: row.slug,
    name: row.name,
    codename: row.codename,
    avatar: row.avatar_storage_path ?? '',
    avatarAssetKey: row.avatar_storage_path ?? '',
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
