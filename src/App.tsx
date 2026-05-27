/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CHARACTER_AVATAR_ASSETS } from './data';
import { Character, DialogSession, Message } from './types';
import CharacterCard from './components/CharacterCard';
import SidebarDrawer from './components/SidebarDrawer';
import CharacterPanel from './components/CharacterPanel';
import ChatWindow from './components/ChatWindow';
import {
  ensureBrowserSession,
  isInvalidBrowserSessionError,
  listCharacters,
  listConversations,
  createConversation,
  deleteConversation,
  listMessages,
  sendMessage,
  setActiveDialog,
  heartbeatActiveDialog,
  clearActiveDialog,
  resetBrowserSession,
  streamConversation,
  BrowserSession,
} from './lib/api';

import {
  Search,
  Volume2,
  VolumeX,
  ArrowLeft,
  Cpu,
} from 'lucide-react';

const PENDING_SESSION_PREFIX = 'pending-dialog';

interface PendingQueuedMessage {
  tempId: string;
  clientMessageId: string;
  text: string;
}

function withResolvedAvatar(character: Character): Character {
  const assetKey = character.avatarAssetKey || character.avatar;
  return {
    ...character,
    avatar: CHARACTER_AVATAR_ASSETS[assetKey] || character.avatar,
  };
}

function pendingSessionId(characterId: string): string {
  return `${PENDING_SESSION_PREFIX}:${characterId}`;
}

function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${PENDING_SESSION_PREFIX}:`);
}

function createPendingSession(characterId: string): DialogSession {
  const timestamp = new Date().toISOString();
  return {
    id: pendingSessionId(characterId),
    title: 'New dialog protocol',
    lastMessage: '',
    timestamp,
    messages: [],
    isPending: true,
  };
}

function upsertMessage(messages: Message[], next: Message): Message[] {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) return [...messages, next];
  const copy = [...messages];
  copy[index] = next;
  return copy;
}

function replaceMessage(messages: Message[], targetId: string, next: Message): Message[] {
  let replaced = false;
  const result: Message[] = [];
  for (const message of messages) {
    if (message.id === targetId) {
      if (!result.some((existing) => existing.id === next.id)) {
        result.push(next);
      }
      replaced = true;
      continue;
    }
    if (message.id !== next.id) {
      result.push(message);
    }
  }
  return replaced ? result : upsertMessage(result, next);
}

function appendMissingMessages(messages: Message[], additions: Message[]): Message[] {
  return additions.reduce((result, message) => upsertMessage(result, message), messages);
}

function mergeRemoteMessages(remoteMessages: Message[], localMessages: Message[]): Message[] {
  const pendingLocalMessages = localMessages.filter((message) => message.sendStatus);
  return appendMissingMessages(remoteMessages, pendingLocalMessages);
}

function findLastSendingMessage(messages: Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].sendStatus) return messages[index];
  }
  return undefined;
}

export default function App() {
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [sessionsMap, setSessionsMap] = useState<Record<string, DialogSession[]>>({});
  const [activeSessionIdMap, setActiveSessionIdMap] = useState<Record<string, string>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('ALL');
  const [currentMoodMap, setCurrentMoodMap] = useState<Record<string, string>>({});
  const [typingMap, setTypingMap] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const pendingSendsRef = useRef<Record<string, PendingQueuedMessage[]>>({});

  useEffect(() => {
    let cancelled = false;
    const loadInitialData = async () => {
      let session = await ensureBrowserSession();
      try {
        const loadedCharacters = await listCharacters(session);
        if (cancelled) return;
        setBrowserSession(session);
        setCharacters(loadedCharacters.map(withResolvedAvatar));
        setError(null);
      } catch (error) {
        if (!isInvalidBrowserSessionError(error)) throw error;
        resetBrowserSession();
        session = await ensureBrowserSession(true);
        const loadedCharacters = await listCharacters(session);
        if (cancelled) return;
        setBrowserSession(session);
        setSelectedCharId(null);
        setSessionsMap({});
        setActiveSessionIdMap({});
        setCharacters(loadedCharacters.map(withResolvedAvatar));
        setError(null);
      }
    };

    loadInitialData().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const getAudioContext = () => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioCtx();
    }
    return audioContextRef.current;
  };

  const playCymbalBeep = (freq = 430, type: OscillatorType = 'sine', dur = 0.08, vol = 0.03, force = false) => {
    if (isMuted && !force) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    } catch (_) {
      // Browser audio restrictions are non-fatal.
    }
  };

  const enableSounds = () => {
    setIsMuted(false);
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const playConfirmation = () => playCymbalBeep(760, 'triangle', 0.12, 0.035, true);
      if (ctx.state === 'suspended') {
        void ctx.resume().then(playConfirmation).catch(() => undefined);
      } else {
        playConfirmation();
      }
    } catch (_) {
      // Audio unlock is best-effort and must never block UI.
    }
  };

  const handleToggleSounds = () => {
    if (isMuted) {
      enableSounds();
    } else {
      setIsMuted(true);
    }
  };

  const triggerHoverBeep = () => playCymbalBeep(520, 'sine', 0.04, 0.01);
  const triggerClickBeep = () => playCymbalBeep(680, 'triangle', 0.1, 0.025);
  const triggerSendTone = () => playCymbalBeep(880, 'sine', 0.15, 0.03);
  const triggerReceiveTone = () => playCymbalBeep(440, 'sine', 0.2, 0.04);
  const triggerBackBeep = () => playCymbalBeep(320, 'sawtooth', 0.12, 0.015);
  const triggerMediaOpenTone = () => playCymbalBeep(620, 'triangle', 0.1, 0.025);
  const triggerMediaCloseTone = () => playCymbalBeep(280, 'sine', 0.1, 0.018);

  const activeChar = characters.find(c => c.id === selectedCharId) || null;
  const currentSessions = activeChar ? (sessionsMap[activeChar.id] || []) : [];
  const currentActiveSessionId = activeChar ? activeSessionIdMap[activeChar.id] : '';
  const currentSession = currentSessions.find(s => s.id === currentActiveSessionId) || currentSessions[0] || null;
  const hasSendingUserMessage = currentSession?.messages.some(message => message.sender === 'user' && message.sendStatus === 'sending') ?? false;
  const isCharacterTyping = Boolean(activeChar && typingMap[activeChar.id]) && !hasSendingUserMessage;

  const filteredCharacters = useMemo(() => characters.filter((char) => {
    const query = searchQuery.toLowerCase();
    const matchesSearch =
      char.name.toLowerCase().includes(query) ||
      char.codename.toLowerCase().includes(query) ||
      char.shortDesc.toLowerCase().includes(query) ||
      char.role.toLowerCase().includes(query);

    const matchesFilter =
      activeFilter === 'ALL' ||
      (activeFilter === 'CYBER' && char.id === 'astrid') ||
      (activeFilter === 'SORCERER' && char.id === 'kaelen') ||
      (activeFilter === 'AVIATOR' && char.id === 'lyra');

    return matchesSearch && matchesFilter;
  }), [activeFilter, characters, searchQuery]);

  const markOptimisticMessageFailed = (characterId: string, conversationId: string, tempId: string, clientMessageId: string) => {
    setSessionsMap(prev => ({
      ...prev,
      [characterId]: (prev[characterId] || []).map(conversation =>
        conversation.id === conversationId
          ? {
              ...conversation,
              messages: conversation.messages.map(message =>
                message.id === tempId ? { ...message, sendStatus: 'failed', clientMessageId } : message
              ),
            }
          : conversation
      ),
    }));
  };

  const postUserMessageToConversation = (
    session: BrowserSession,
    characterId: string,
    conversationId: string,
    text: string,
    clientMessageId: string,
    tempId: string,
  ) => sendMessage(session, conversationId, text, clientMessageId)
    .then(({ message, status }) => {
      setSessionsMap(prev => ({
        ...prev,
        [characterId]: (prev[characterId] || []).map(sessionItem =>
          sessionItem.id === conversationId
            ? { ...sessionItem, messages: replaceMessage(sessionItem.messages, tempId, message), lastMessage: message.text, timestamp: message.timestamp }
            : sessionItem
        ),
      }));
      if (status === 'accepted') {
        setTypingMap(prev => ({ ...prev, [characterId]: true }));
      }
    })
    .catch(err => {
      markOptimisticMessageFailed(characterId, conversationId, tempId, clientMessageId);
      setError(err instanceof Error ? err.message : String(err));
    });

  const flushPendingSends = async (session: BrowserSession, characterId: string, conversationId: string) => {
    const queued = pendingSendsRef.current[characterId] ?? [];
    if (queued.length === 0) return;
    delete pendingSendsRef.current[characterId];

    for (const queuedMessage of queued) {
      await postUserMessageToConversation(
        session,
        characterId,
        conversationId,
        queuedMessage.text,
        queuedMessage.clientMessageId,
        queuedMessage.tempId,
      );
    }
  };

  const refreshMessages = async (session: BrowserSession, characterId: string, conversationId: string) => {
    const messages = await listMessages(session, conversationId);
    setSessionsMap(prev => ({
      ...prev,
      [characterId]: (prev[characterId] || []).map(conversation =>
        conversation.id === conversationId ? { ...conversation, messages: mergeRemoteMessages(messages, conversation.messages) } : conversation
      ),
    }));
    const lastCharacterMessage = [...messages].reverse().find(message => message.sender === 'character' && message.mood);
    if (lastCharacterMessage?.mood) {
      setCurrentMoodMap(prev => ({ ...prev, [characterId]: lastCharacterMessage.mood! }));
    }
  };

  const loadConversationsForCharacter = async (characterId: string, session = browserSession) => {
    if (!session) return;
    let conversations = await listConversations(session, characterId);
    if (conversations.length === 0) {
      const created = await createConversation(session, characterId, 'New dialog protocol');
      conversations = [created];
    }
    const primaryConversationId = conversations[0].id;
    const pendingId = pendingSessionId(characterId);
    setSessionsMap(prev => {
      const previous = prev[characterId] || [];
      const pendingSession = previous.find(conversation => conversation.id === pendingId);
      const pendingMessages = pendingSession?.messages ?? [];
      return {
        ...prev,
        [characterId]: conversations.map((conversation, index) => {
          const existing = previous.find(item => item.id === conversation.id);
          const existingMessages = existing?.messages ?? [];
          const messages = index === 0 && pendingMessages.length > 0
            ? appendMissingMessages(existingMessages, pendingMessages)
            : existingMessages;
          const latestPendingMessage = findLastSendingMessage(messages);
          return {
            ...conversation,
            messages,
            lastMessage: latestPendingMessage?.text || conversation.lastMessage,
            timestamp: latestPendingMessage?.timestamp || conversation.timestamp,
          };
        }),
      };
    });
    setActiveSessionIdMap(prev => {
      const current = prev[characterId];
      const canKeepCurrent = Boolean(current && !isPendingSessionId(current) && conversations.some(conversation => conversation.id === current));
      const nextActiveId = canKeepCurrent ? current : primaryConversationId;
      return prev[characterId] === nextActiveId ? prev : { ...prev, [characterId]: nextActiveId };
    });
    await flushPendingSends(session, characterId, primaryConversationId);
    await refreshMessages(session, characterId, primaryConversationId);
  };

  const handleSelectCharacter = (character: Character) => {
    if (!browserSession) return;
    triggerClickBeep();
    setSelectedCharId(character.id);
    setSessionsMap(prev => {
      if ((prev[character.id] || []).length > 0) return prev;
      return { ...prev, [character.id]: [createPendingSession(character.id)] };
    });
    setActiveSessionIdMap(prev => (
      prev[character.id] ? prev : { ...prev, [character.id]: pendingSessionId(character.id) }
    ));
    loadConversationsForCharacter(character.id).catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  const handleAddSession = (title: string) => {
    if (!browserSession || !activeChar) return;
    triggerClickBeep();
    createConversation(browserSession, activeChar.id, title)
      .then((created) => {
        setSessionsMap(prev => ({ ...prev, [activeChar.id]: [created, ...(prev[activeChar.id] || [])] }));
        setActiveSessionIdMap(prev => ({ ...prev, [activeChar.id]: created.id }));
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  const handleDeleteSession = (sessionId: string) => {
    if (!browserSession || !activeChar) return;
    if (isPendingSessionId(sessionId)) return;
    triggerBackBeep();
    deleteConversation(browserSession, sessionId)
      .then(() => loadConversationsForCharacter(activeChar.id, browserSession))
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  const handleSelectSession = (sessionId: string) => {
    if (!browserSession || !activeChar) return;
    triggerClickBeep();
    setActiveSessionIdMap(prev => ({ ...prev, [activeChar.id]: sessionId }));
    if (isPendingSessionId(sessionId)) return;
    refreshMessages(browserSession, activeChar.id, sessionId).catch(err => setError(err instanceof Error ? err.message : String(err)));
  };

  const handleSendMessage = (text: string) => {
    if (!browserSession || !activeChar || !currentSession) return;
    const characterId = activeChar.id;
    const conversationId = currentSession.id;
    const tempId = `local-${crypto.randomUUID()}`;
    const clientMessageId = crypto.randomUUID();
    const optimisticMessage: Message = {
      id: tempId,
      sender: 'user',
      text,
      timestamp: new Date().toISOString(),
      sendStatus: 'sending',
      clientMessageId,
    };

    triggerSendTone();
    setTypingMap(prev => ({ ...prev, [characterId]: false }));
    setSessionsMap(prev => ({
      ...prev,
      [characterId]: (prev[characterId] || []).map(session =>
        session.id === conversationId
          ? { ...session, messages: upsertMessage(session.messages, optimisticMessage), lastMessage: text, timestamp: optimisticMessage.timestamp }
          : session
      ),
    }));

    if (currentSession.isPending) {
      pendingSendsRef.current[characterId] = [
        ...(pendingSendsRef.current[characterId] ?? []),
        { tempId, clientMessageId, text },
      ];
      return;
    }

    void postUserMessageToConversation(browserSession, characterId, conversationId, text, clientMessageId, tempId);
  };

  const handleRetryMessage = (message: Message) => {
    if (!browserSession || !activeChar || !currentSession || message.sender !== 'user') return;
    const characterId = activeChar.id;
    const conversationId = currentSession.id;
    const clientMessageId = message.clientMessageId || crypto.randomUUID();

    triggerSendTone();
    setTypingMap(prev => ({ ...prev, [characterId]: false }));
    setSessionsMap(prev => ({
      ...prev,
      [characterId]: (prev[characterId] || []).map(session =>
        session.id === conversationId
          ? {
              ...session,
              messages: session.messages.map(item =>
                item.id === message.id ? { ...item, sendStatus: 'sending', clientMessageId } : item
              ),
            }
          : session
      ),
    }));

    if (currentSession.isPending) {
      pendingSendsRef.current[characterId] = [
        ...(pendingSendsRef.current[characterId] ?? []).filter(item => item.tempId !== message.id),
        { tempId: message.id, clientMessageId, text: message.text },
      ];
      return;
    }

    void postUserMessageToConversation(browserSession, characterId, conversationId, message.text, clientMessageId, message.id);
  };

  useEffect(() => {
    if (!browserSession || !activeChar || !currentSession || currentSession.isPending) return;
    if ((pendingSendsRef.current[activeChar.id] ?? []).length === 0) return;
    void flushPendingSends(browserSession, activeChar.id, currentSession.id);
  }, [browserSession, activeChar?.id, currentSession?.id, currentSession?.isPending]);

  useEffect(() => {
    if (!browserSession || !activeChar || !currentSession || currentSession.isPending) return;
    const controller = new AbortController();
    let heartbeatInterval: number | undefined;
    let disposed = false;
    const characterId = activeChar.id;
    const conversationId = currentSession.id;

    const stopHeartbeat = () => {
      if (heartbeatInterval !== undefined) {
        window.clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
    };

    const startHeartbeat = () => {
      stopHeartbeat();
      const heartbeat = () => heartbeatActiveDialog(browserSession).catch(() => undefined);
      heartbeat();
      heartbeatInterval = window.setInterval(heartbeat, 15000);
    };

    const activateDialog = () => {
      stopHeartbeat();
      return setActiveDialog(browserSession, characterId, conversationId, document.visibilityState)
        .then(() => {
          if (!disposed && document.visibilityState !== 'hidden') {
            startHeartbeat();
          }
        });
    };

    const deactivateDialog = () => {
      stopHeartbeat();
      return clearActiveDialog(browserSession);
    };

    if (document.visibilityState === 'hidden') {
      void deactivateDialog();
    } else {
      activateDialog().catch(err => setError(err instanceof Error ? err.message : String(err)));
    }

    streamConversation(browserSession, conversationId, (event) => {
      if (event.event === 'agent.typing_started') {
        setTypingMap(prev => ({ ...prev, [characterId]: true }));
        return;
      }
      if (event.event === 'agent.typing_finished') {
        setTypingMap(prev => ({ ...prev, [characterId]: false }));
        return;
      }
      if (event.event === 'stream.error') {
        setTypingMap(prev => ({ ...prev, [characterId]: false }));
        return;
      }
      if (event.event !== 'message.created') return;
      const message = (event.data as { message?: Message }).message;
      if (!message) return;
      setSessionsMap(prev => ({
        ...prev,
        [characterId]: (prev[characterId] || []).map(session =>
          session.id === conversationId
            ? { ...session, messages: upsertMessage(session.messages, message), lastMessage: message.text || session.lastMessage, timestamp: message.timestamp }
            : session
        ),
      }));
      if (message.sender === 'character') {
        triggerReceiveTone();
        if (message.mood) setCurrentMoodMap(prev => ({ ...prev, [characterId]: message.mood! }));
        setTypingMap(prev => ({ ...prev, [characterId]: false }));
      }
    }, controller.signal).catch((err) => {
      if (!controller.signal.aborted) {
        setTypingMap(prev => ({ ...prev, [characterId]: false }));
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        deactivateDialog().catch(() => undefined);
      } else {
        activateDialog().catch(err => setError(err instanceof Error ? err.message : String(err)));
      }
    };

    const onBeforeUnload = () => {
      stopHeartbeat();
      clearActiveDialog(browserSession).catch(() => undefined);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      disposed = true;
      controller.abort();
      stopHeartbeat();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [browserSession, activeChar?.id, currentSession?.id, currentSession?.isPending]);

  return (
    <div className="h-screen max-h-screen overflow-hidden bg-[#0D1114] text-slate-100 grainy-bg flex flex-col antialiased select-none selection:bg-[#ECFF19]/20">
      {error && (
        <div className="fixed left-4 right-4 top-4 z-50 rounded-xl border border-red-500/40 bg-red-950/90 px-4 py-3 text-xs font-mono text-red-100 shadow-xl">
          {error}
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        <AnimatePresence mode="wait">
          {!selectedCharId ? (
            <motion.div
              key="arena-grid"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.3 }}
              className="flex-1 overflow-y-auto no-scrollbar px-8 py-6 md:py-8 flex flex-col gap-6 md:gap-8 w-full max-w-7xl mx-auto"
            >
              <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between border-b border-[#1c2226] pb-6">
                <div className="space-y-2">
                  <h2 className="font-orbitron font-black text-3xl tracking-widest text-[#ECFF19] uppercase">
                    CHARACTER ARENA
                  </h2>
                  <p className="text-sm font-light text-zinc-400 max-w-lg">
                    Establish a cognitive sync portal with advanced entities. Select a character card to initiate dialogue layers.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
                  <div className="relative w-full sm:w-80">
                    <Search className="absolute left-3.5 top-3 w-4 h-4 text-zinc-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search characters or roles..."
                      className="w-full text-xs font-mono bg-zinc-900/60 border border-zinc-805/80 rounded-xl p-3 pl-10 text-slate-250 placeholder-zinc-500 focus:outline-none focus:border-[#ECFF19]/60 transition-colors"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleToggleSounds}
                    onMouseEnter={triggerHoverBeep}
                    className={`flex items-center gap-2 rounded-xl py-3 px-4 border text-[11px] font-mono font-bold tracking-wider transition-all cursor-pointer h-[42px] ${
                      !isMuted
                        ? 'bg-[#ECFF19]/10 border-[#ECFF19] text-[#ECFF19] shadow-[0_0_12px_rgba(236,255,25,0.15)]'
                        : 'bg-zinc-900/40 border-zinc-800 text-zinc-400 hover:text-zinc-305 hover:bg-zinc-900/80 hover:border-zinc-700'
                    }`}
                  >
                    {!isMuted ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                    <span>{!isMuted ? 'SOUNDS: ON' : 'SOUNDS: OFF'}</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2.5">
                {[
                  { id: 'ALL', label: 'ALL FILES' },
                  { id: 'CYBER', label: 'CYBERNETIC SPECIALIST' },
                  { id: 'SORCERER', label: 'VOID SORCERER' },
                  { id: 'AVIATOR', label: 'SKY INVENTOR' },
                ].map((chip) => {
                  const isActive = activeFilter === chip.id;
                  return (
                    <motion.button
                      key={chip.id}
                      onClick={() => {
                        triggerClickBeep();
                        setActiveFilter(chip.id);
                      }}
                      onMouseEnter={triggerHoverBeep}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className={`text-[10px] font-mono font-extrabold tracking-wider border py-2 px-3.5 rounded-xl cursor-pointer transition-all select-none ${
                        isActive
                          ? 'bg-[#ECFF19] text-black border-[#ECFF19] shadow-[0_0_15px_rgba(236,255,25,0.3)]'
                          : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
                      }`}
                    >
                      {chip.label}
                    </motion.button>
                  );
                })}
              </div>

              {filteredCharacters.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-3 gap-6 mb-2 w-full">
                  {filteredCharacters.map((char) => (
                    <CharacterCard key={char.id} character={char} onSelect={handleSelectCharacter} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-16 text-center border border-dashed border-zinc-850 rounded-2xl bg-zinc-950/10 max-w-md mx-auto my-12">
                  <Cpu className="w-10 h-10 text-zinc-700 mb-4 animate-spin [animation-duration:10s]" />
                  <p className="font-orbitron font-bold text-sm text-zinc-400 tracking-wider">
                    NO COMPATIBLE COUPLING FOUND
                  </p>
                  <p className="text-xs text-zinc-650 font-mono mt-2">
                    {browserSession ? 'Adjust security matrix frequency filters or clear query parameters.' : 'Waiting for backend session handshake.'}
                  </p>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="workspace"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex-1 flex flex-row h-full bg-[#0D1114]/20 overflow-hidden"
            >
              <SidebarDrawer
                isOpen={sidebarOpen}
                onToggle={() => {
                  triggerClickBeep();
                  setSidebarOpen(!sidebarOpen);
                }}
                sessions={currentSessions}
                activeSessionId={currentActiveSessionId}
                onSelectSession={handleSelectSession}
                onAddSession={handleAddSession}
                onDeleteSession={handleDeleteSession}
                themeColor="#ECFF19"
              />

              <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                <div className="px-6 py-3.5 border-b border-[#1c2226] flex items-center justify-between bg-[#0D1114]/90 gap-4 shrink-0">
                  <motion.button
                    whileHover={{ scale: 1.05, x: -3 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => {
                      triggerBackBeep();
                      setSelectedCharId(null);
                      if (browserSession) clearActiveDialog(browserSession).catch(() => undefined);
                    }}
                    onMouseEnter={triggerHoverBeep}
                    className="flex items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2 text-xs font-mono font-bold tracking-wider text-zinc-350 hover:text-[#ECFF19] hover:border-[#ECFF19]/40 cursor-pointer hover:bg-zinc-900 transition-colors"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    <span>ARENA SELECTION</span>
                  </motion.button>

                  <button
                    type="button"
                    onClick={handleToggleSounds}
                    onMouseEnter={triggerHoverBeep}
                    className={`flex items-center gap-2 rounded-xl py-2 px-3.5 border text-[11px] font-mono font-bold tracking-wider transition-all cursor-pointer ${
                      !isMuted
                        ? 'bg-[#ECFF19]/10 border-[#ECFF19] text-[#ECFF19] shadow-[0_0_12px_rgba(236,255,25,0.15)]'
                        : 'bg-zinc-900/40 border-zinc-800 text-zinc-400 hover:text-zinc-300 hover:bg-zinc-900/80 hover:border-zinc-700'
                    }`}
                  >
                    {!isMuted ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                    <span>{!isMuted ? 'SOUNDS: ON' : 'SOUNDS: OFF'}</span>
                  </button>
                </div>

                <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1.1fr_1.9fr] overflow-hidden">
                  <div className="hidden lg:block border-r border-[#1c2226] h-full overflow-hidden">
                    {activeChar && (
                      <CharacterPanel
                        character={activeChar}
                        currentMood={currentMoodMap[activeChar.id] || 'Interfacing'}
                        onSelectPrompt={(text) => handleSendMessage(text)}
                      />
                    )}
                  </div>

                  <div className="h-full overflow-hidden flex flex-col pt-[1px]">
                    {activeChar && currentSession ? (
                      <ChatWindow
                        character={activeChar}
                        messages={currentSession.messages}
                        onSendMessage={handleSendMessage}
                        onRetryMessage={handleRetryMessage}
                        onMediaOpen={triggerMediaOpenTone}
                        onMediaClose={triggerMediaCloseTone}
                        isTyping={isCharacterTyping}
                        currentMood={currentMoodMap[activeChar.id] || 'Interfacing'}
                      />
                    ) : (
                      <div className="flex-1 flex items-center justify-center font-mono text-xs text-zinc-500 tracking-wider">
                        ESTABLISHING NEURAL CONVERSATION FREQUENCIES...
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
