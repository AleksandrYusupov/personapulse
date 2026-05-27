export type CharacterId = string;

export type CharacterStatus = 'ONLINE' | 'CALIBRATING' | 'IDLE' | 'OFFLINE';

export interface Trait {
  label: string;
  value: number; // 0 to 100
}

export interface Special {
  label: string;
  value: string;
}

export interface Character {
  id: CharacterId;
  name: string;
  codename: string;
  avatar: string;
  avatarAssetKey?: string;
  avatarObjectPosition?: string;
  shortDesc: string;
  longDesc: string;
  role: string;
  themeColor: string; // e.g. '#ff007f'
  secondaryColor: string; // e.g. '#00f0ff'
  glowColor: string; // shadow glow effect class or style
  borderColor: string;
  status: CharacterStatus;
  traits: Trait[];
  specials: Special[];
  suggestedPrompts: string[];
}

export interface Message {
  id: string;
  sender: 'user' | 'character';
  text: string;
  timestamp: string;
  mood?: string; // e.g. 'Excited', 'Cynical', 'Playful', 'Serious'
  media?: MessageMedia[];
  sendStatus?: 'sending' | 'failed';
  clientMessageId?: string;
}

export interface DialogSession {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: string;
  messages: Message[];
  isPending?: boolean;
}

export interface MessageMedia {
  id: string;
  type: 'image';
  url: string;
  altText: string;
  width?: number | null;
  height?: number | null;
}
