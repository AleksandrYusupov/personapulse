import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Character, Message } from '../types';
import { Send, Zap, ChevronRight, Sparkles, Smile, ArrowDown } from 'lucide-react';

interface ChatWindowProps {
  character: Character;
  messages: Message[];
  onSendMessage: (text: string) => void;
  onRetryMessage: (message: Message) => void;
  isTyping: boolean;
  currentMood: string;
}

export default function ChatWindow({
  character,
  messages,
  onSendMessage,
  onRetryMessage,
  isTyping,
  currentMood,
}: ChatWindowProps) {
  const [inputText, setInputText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollDownBtn, setShowScrollDownBtn] = useState(false);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      onSendMessage(inputText.trim());
      setInputText('');
    }
  };

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // Show scroll down button if user scrolled up significantly
    const isScrolledUp = scrollHeight - scrollTop - clientHeight > 300;
    setShowScrollDownBtn(isScrolledUp);
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  };

  // Scroll to bottom when message arrives or typing changes
  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const quickEmojis = ['⚡', '🔮', '⚙️', '🎵', '🔥', '💀', '🤖', '👑'];

  return (
    <div className="flex flex-col h-full bg-[#0D1114]/40 relative">
      {/* Dynamic Ambient Blur glow based on character's theme color */}
      <div 
        className="absolute -right-40 -bottom-40 h-80 w-80 rounded-full opacity-5 pointer-events-none blur-3xl transition-colors duration-1000"
        style={{ backgroundColor: '#ECFF19' }}
      />

      {/* Messages Feed */}
      <div 
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-6 scroll-smooth no-scrollbar"
      >
        <div className="flex flex-col justify-end min-h-full space-y-5">
          <AnimatePresence initial={false}>
            {messages.map((msg, idx) => {
              const isUser = msg.sender === 'user';
              return (
                <motion.div
                  key={msg.clientMessageId ?? msg.id ?? idx}
                  initial={{ opacity: 0, y: 12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                  className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`flex flex-col max-w-[85%] sm:max-w-[75%] gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
                    
                    {/* Bubble sender tags */}
                    <div className="flex items-center gap-2 text-[9px] font-mono text-zinc-500 tracking-wider">
                      {!isUser && (
                        <span className="font-bold uppercase text-[#ECFF19]">
                          {character.name}
                        </span>
                      )}
                      <span>{msg.timestamp}</span>
                      {!isUser && msg.mood && (
                        <span 
                          className="rounded px-1.5 py-0.5 text-[8px] font-black border border-[#ECFF19]/25 text-[#ECFF19] bg-[#ECFF19]/5"
                        >
                          {msg.mood.toUpperCase()}
                        </span>
                      )}
                    </div>

                    {/* Bubble Body */}
                    <div 
                      className={`rounded-2xl px-5 py-3.5 leading-relaxed text-sm shadow-md border relative group selection:bg-[#ECFF19]/20 select-text ${
                        isUser
                          ? 'bg-zinc-900/60 text-slate-100 border-zinc-800/85 rounded-tr-none'
                          : 'bg-zinc-950/40 text-slate-200 border-[#ECFF19]/15 rounded-tl-none'
                      }`}
                      style={{ 
                        boxShadow: !isUser ? '0 4px 12px rgba(0,0,0,0.4), 0 0 10px rgba(236,255,25,0.03)' : undefined
                      }}
                    >
                      {msg.media && msg.media.length > 0 && (
                        <div className="mb-3 grid gap-2">
                          {msg.media.map((media) => (
                            <img
                              key={media.id}
                              src={media.url}
                              alt={media.altText}
                              className="max-h-80 w-full rounded-xl border border-zinc-800 object-cover"
                              referrerPolicy="no-referrer"
                            />
                          ))}
                        </div>
                      )}
                      {msg.text && (
                        <p className="whitespace-pre-wrap select-text font-sans font-normal text-zinc-200">{msg.text}</p>
                      )}
                      {isUser && msg.sendStatus && (
                        <div className="mt-2 flex items-center justify-end gap-2 text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-500">
                          {msg.sendStatus === 'sending' ? (
                            <span className="text-[#ECFF19]/70">SENDING</span>
                          ) : (
                            <>
                              <span className="text-red-300">FAILED</span>
                              <button
                                type="button"
                                onClick={() => onRetryMessage(msg)}
                                className="rounded border border-red-400/30 px-2 py-1 text-red-200 hover:border-red-300 hover:text-white"
                              >
                                RETRY
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      
                      {/* Tiny visual tech crosshairs on bubble hover */}
                      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-10 w-2 h-2 border-t border-r border-[#ECFF19] pointer-events-none transition-opacity" />
                      <div className="absolute bottom-1.5 left-1.5 opacity-0 group-hover:opacity-10 w-2 h-2 border-b border-l border-[#ECFF19] pointer-events-none transition-opacity" />
                    </div>
                  </div>
                </motion.div>
              );
            })}

            {/* Live typing indicator driven by backend events */}
            {isTyping && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0 } }}
                className="flex justify-start w-full"
              >
                <div className="flex flex-col items-start gap-1.5 max-w-[70%]">
                  <span className="text-[9px] font-mono text-zinc-500 tracking-wider font-bold">
                    {character.name} is typing...
                  </span>
                  
                  {/* Typing capsule design */}
                  <div 
                    className="rounded-2xl rounded-tl-none px-4 py-3 border border-[#ECFF19]/15 bg-zinc-950/40"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full animate-bounce [animation-delay:-0.3s] bg-[#ECFF19]" />
                      <span className="h-2 w-2 rounded-full animate-bounce [animation-delay:-0.15s] bg-[#ECFF19]" />
                      <span className="h-2 w-2 rounded-full animate-bounce bg-[#ECFF19]" />
                      <span className="text-xs font-mono ml-1.5 text-zinc-500 tracking-widest animate-pulse">
                        INTERFACING
                      </span>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Floating Scroll Down button */}
      <AnimatePresence>
        {showScrollDownBtn && (
          <motion.button
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.9 }}
            onClick={scrollToBottom}
            className="absolute bottom-24 right-6 p-2 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white cursor-pointer shadow-xl z-10 flex items-center justify-center"
          >
            <ArrowDown className="w-5 h-5" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Bottom Input Area and Utilities */}
      <div className="px-6 pb-6 pt-4 border-t border-[#1c2226] bg-[#0D1114]/80 relative z-10 select-none">
        
        {/* Horizontal Scrolling Suggestions Carousel */}
        {character.suggestedPrompts && character.suggestedPrompts.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-3 pt-1 scroll-smooth select-none w-full">
            {character.suggestedPrompts.map((prompt, idx) => (
              <motion.button
                key={idx}
                type="button"
                whileHover={{ scale: 1.01, backgroundColor: 'rgba(236,255,25,0.06)', borderColor: 'rgba(236,255,25,0.35)' }}
                whileTap={{ scale: 0.99 }}
                onClick={() => onSendMessage(prompt)}
                className="whitespace-nowrap flex-shrink-0 text-xs font-mono py-2 px-3.5 rounded-xl border border-zinc-800 bg-zinc-950/20 text-zinc-350 hover:text-[#ECFF19] hover:border-[#ECFF19]/35 transition-all cursor-pointer"
              >
                &gt; &quot;{prompt}&quot;
              </motion.button>
            ))}
          </div>
        )}

        {/* Emoji toolbar/selector container button */}
        <div className="flex items-center justify-between mb-3 text-xs font-mono text-zinc-500">
          <div className="flex items-center gap-2">
            <button 
              type="button"
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="p-1.5 hover:bg-zinc-900/60 border border-transparent hover:border-zinc-800 rounded-lg text-zinc-400 hover:text-[#ECFF19] transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <Smile className="w-4 h-4 text-[#ECFF19]" />
              <span>EMOJI TRANSMITTERS</span>
            </button>
            
            {showEmojiPicker && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-1.5 bg-[#0D1114] border border-zinc-800 rounded-lg px-2.5 py-1 backdrop-blur-md"
              >
                {quickEmojis.map((emo) => (
                  <button
                    key={emo}
                    type="button"
                    onClick={() => {
                      setInputText(prev => prev + emo);
                      setShowEmojiPicker(false);
                    }}
                    className="hover:scale-125 transition-transform p-0.5 cursor-pointer text-sm"
                  >
                    {emo}
                  </button>
                ))}
              </motion.div>
            )}
          </div>
        </div>

        {/* Input Form Box */}
        <form onSubmit={handleSend} className="relative flex items-center gap-3">
          <input
            type="text"
            required
            maxLength={1000}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={`Send protocol request to ${character.name}...`}
            className="w-full text-sm font-sans bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-4 pr-14 text-slate-100 placeholder-zinc-500 focus:outline-none focus:border-[#ECFF19]/60 focus:ring-0 transition-all"
            style={{ 
              caretColor: '#ECFF19'
            }}
          />

          {/* Quick Submit/Send icon Button */}
          <div className="absolute right-2 top-2 bottom-2 aspect-square flex items-center justify-center">
            <motion.button
              type="submit"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              disabled={!inputText.trim()}
              className="h-full aspect-square rounded-xl bg-zinc-950 text-black border border-zinc-800 flex items-center justify-center disabled:opacity-45 disabled:pointer-events-none hover:bg-[#ECFF19]/10 hover:text-white transition-all cursor-pointer shadow-md"
              style={{ 
                backgroundColor: inputText ? '#ECFF19' : undefined,
                borderColor: inputText ? '#ECFF19' : undefined,
                color: inputText ? '#000000' : undefined
              }}
            >
              <Send className="w-4 h-4 font-black" />
            </motion.button>
          </div>
        </form>
      </div>
    </div>
  );
}
