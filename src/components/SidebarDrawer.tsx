import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { DialogSession } from '../types';
import { MessageSquare, Plus, Trash2, ChevronLeft, ChevronRight, Hash, Clock } from 'lucide-react';

interface SidebarDrawerProps {
  isOpen: boolean;
  onToggle: () => void;
  sessions: DialogSession[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onAddSession: (title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  themeColor: string; // Dynamic character theme color
}

export default function SidebarDrawer({
  isOpen,
  onToggle,
  sessions,
  activeSessionId,
  onSelectSession,
  onAddSession,
  onDeleteSession,
  themeColor,
}: SidebarDrawerProps) {
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newSessionTitle.trim()) {
      onAddSession(newSessionTitle.trim());
      setNewSessionTitle('');
      setIsCreating(false);
    }
  };

  return (
    <div className="relative z-20 flex h-full">
      {/* Drawer Body Container - Animates horizontally */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id="sidebar-drawer-content"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 280, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 25 }}
            className="flex h-full flex-col border-r border-[#1c2226] bg-[#0D1114]/95 backdrop-blur-xl relative overflow-hidden"
          >
            {/* Glowing vertical trim indicating theme active colors */}
            <div 
              className="absolute right-0 top-0 bottom-0 w-[2px] opacity-70"
              style={{ backgroundColor: '#ECFF19', boxShadow: '0 0 10px #ECFF19' }}
            />

            {/* Sidebar Header */}
            <div className="p-4 border-b border-[#1c2226]/60 flex flex-col gap-3 shrink-0">
              <div className="flex items-center justify-between">
                <span className="font-orbitron text-xs font-black tracking-wider text-[#ECFF19]">
                  DIALOG CHRONICLES
                </span>
                <button
                  type="button"
                  onClick={onToggle}
                  className="flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded border border-zinc-800 bg-zinc-900/30 text-[#ECFF19] hover:bg-[#ECFF19]/15 hover:border-[#ECFF19]/40 cursor-pointer transition-colors"
                  title="Collapse Sidebar"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>CLOSE</span>
                </button>
              </div>

              {/* TIMELINE CREATION BUTTON */}
              <div className="mt-1">
                {isCreating ? (
                  <form onSubmit={handleSubmit} className="space-y-2">
                    <input
                      type="text"
                      required
                      maxLength={30}
                      value={newSessionTitle}
                      onChange={(e) => setNewSessionTitle(e.target.value)}
                      placeholder="Timeline naming..."
                      className="w-full text-xs font-mono bg-zinc-900/60 border border-zinc-800 rounded-lg p-2 text-slate-100 placeholder-zinc-500 focus:outline-none focus:border-[#ECFF19]/60"
                      autoFocus
                    />
                    <div className="flex gap-2 text-[10px] font-mono justify-end">
                      <button
                        type="button"
                        onClick={() => setIsCreating(false)}
                        className="px-2 py-1 select-none text-zinc-500 hover:text-zinc-350 cursor-pointer"
                      >
                        CANCEL
                      </button>
                      <button
                        type="submit"
                        className="px-3 py-1 bg-zinc-900 hover:bg-[#ECFF19] hover:text-black border border-zinc-800 text-white rounded cursor-pointer transition-colors"
                        style={{ borderColor: '#ECFF19' }}
                      >
                        CREATE
                      </button>
                    </div>
                  </form>
                ) : (
                  <motion.button
                    whileHover={{ scale: 1.02, borderColor: '#ECFF19', color: '#ffffff' }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setIsCreating(true)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl py-2 px-4 border border-dashed border-zinc-800 text-xs font-mono font-bold tracking-wider transition-all cursor-pointer text-zinc-400 bg-zinc-950/20 hover:bg-[#ECFF19]/10"
                  >
                    <Plus className="w-3.5 h-3.5 text-[#ECFF19]" />
                    <span>NEW DIALOG PROTOCOL</span>
                  </motion.button>
                )}
              </div>
            </div>

            {/* Timelines List */}
            <div className="flex-1 overflow-y-auto px-2 py-3 space-y-2 no-scrollbar">
              <AnimatePresence>
                {sessions.map((session) => {
                  const isActive = session.id === activeSessionId;
                  return (
                    <motion.div
                      key={session.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      whileHover={{ scale: 1.01 }}
                      onClick={() => onSelectSession(session.id)}
                      className={`relative flex items-center justify-between rounded-xl p-3 cursor-pointer border group transition-all select-none ${
                        isActive
                          ? 'bg-zinc-900/40 border-zinc-800/80 shadow-[0_0_12px_rgba(236,255,25,0.05)]'
                          : 'bg-transparent border-transparent hover:bg-zinc-900/15 hover:border-zinc-900/60'
                      }`}
                    >
                      {/* Active Session Indicator Glow Background */}
                      {isActive && (
                        <div 
                          className="absolute left-1 top-3 bottom-3 w-1 rounded-sm bg-[#ECFF19]"
                        />
                      )}

                      <div className="flex flex-col gap-1 flex-1 min-w-0 pr-2">
                        <div className="flex items-center gap-1.5">
                          <Hash className="w-3 h-3 opacity-40 shrink-0" style={{ color: isActive ? '#ECFF19' : undefined }} />
                          <span 
                            className={`text-xs font-mono font-semibold truncate tracking-wide transition-colors ${
                              isActive ? 'text-[#ECFF19]' : 'text-slate-400 group-hover:text-slate-200'
                            }`}
                          >
                            {session.title}
                          </span>
                        </div>
                        <span className="text-[10px] text-zinc-500 font-mono truncate pl-4">
                          {session.lastMessage || 'Blank transmission grid'}
                        </span>
                      </div>

                      {/* Right metadata and Actions */}
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[8px] font-mono text-slate-500 flex items-center gap-0.5">
                          <Clock className="w-2.5 h-2.5" />
                          {session.timestamp}
                        </span>

                        {/* Delete command button (Only delete secondary threads, keep at least 1) */}
                        {sessions.length > 1 && (
                          <motion.button
                            whileHover={{ scale: 1.1, color: '#f87171' }}
                            whileTap={{ scale: 0.9 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteSession(session.id);
                            }}
                            className="p-1 text-slate-600 rounded opacity-0 group-hover:opacity-100 transition-opacity ml-1.5"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </motion.button>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Slide Handle Trigger Button */}
      <div className="flex items-center justify-center h-full relative z-10">
        <motion.button
          id="drawer-toggle-button"
          whileHover={{ scale: 1.1, x: isOpen ? -3 : 3 }}
          whileTap={{ scale: 0.9 }}
          onClick={onToggle}
          className="absolute -left-3 h-24 w-6 flex items-center justify-center rounded-r-lg border border-l-0 border-zinc-850 bg-[#0D1114] text-zinc-400 hover:text-[#ECFF19] hover:border-[#ECFF19]/40 cursor-pointer shadow-lg outline-none"
        >
          {isOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </motion.button>
      </div>
    </div>
  );
}
