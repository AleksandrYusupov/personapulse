import React from 'react';
import { motion } from 'motion/react';
import { Character } from '../types';

interface CharacterPanelProps {
  character: Character;
  currentMood?: string;
  onSelectPrompt: (promptText: string) => void;
}

export default function CharacterPanel({ character, currentMood, onSelectPrompt }: CharacterPanelProps) {
  return (
    <div className="flex flex-col h-full bg-[#0D1114]/20 p-6 overflow-y-auto no-scrollbar justify-start items-center pt-10 pb-6 gap-6">
      
      {/* Main Big Close-Up Portrait Card */}
      <motion.div 
        id={`big-portrait-container-${character.id}`}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="relative group rounded-3xl overflow-hidden border border-zinc-800/80 bg-zinc-950 aspect-[3/4] w-full max-w-[280px] sm:max-w-[310px] md:max-w-[330px] lg:max-w-[85%] xl:max-w-[75%] max-h-[50vh] sm:max-h-[54vh] md:max-h-[58vh] xl:max-h-[64vh] shadow-2xl transition-all duration-300 hover:border-[#ECFF19]/40 hover:shadow-[0_0_40px_rgba(236,255,25,0.08)]"
      >
        {/* Glow halo in back */}
        <div 
          className="absolute -inset-10 opacity-10 blur-[60px] rounded-full transition-opacity group-hover:opacity-20 pointer-events-none"
          style={{ backgroundColor: '#ECFF19' }}
        />

        {/* Card Avatar */}
        <img
          src={character.avatar}
          alt={character.name}
          className="w-full h-full object-cover select-none transition-transform duration-500 ease-out group-hover:scale-105"
          referrerPolicy="no-referrer"
        />

        {/* Dark Backdrop Cover Overlay on Hover (Eliminates glitchy border white lines completely by avoiding backdrop-blurs) */}
        <div className="absolute inset-0 bg-[#0D1114]/0 group-hover:bg-[#0D1114]/94 transition-all duration-300 pointer-events-none" />

        {/* Dynamic scanlines texture simulation for a gaming touch */}
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[size:100%_4px] opacity-10" />

        {/* TACTICAL DOSSIER OVERLAY ON HOVER */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col p-5 overflow-y-auto justify-start no-scrollbar pointer-events-none group-hover:pointer-events-auto z-10">
          <h4 className="font-orbitron text-[10px] font-black tracking-widest text-[#ECFF19] mb-3 uppercase border-b border-[#ECFF19]/20 pb-1.5 w-fit">
            TACTICAL DOSSIER
          </h4>
          <p className="text-xs text-zinc-100 leading-relaxed font-sans font-light">
            {character.longDesc}
          </p>

          <div className="mt-auto pt-4 border-t border-zinc-800/30">
            <span className="text-[9px] font-mono text-zinc-400 block tracking-wider uppercase mb-1">COGNITIVE STATUS</span>
            <span className="text-xs font-mono font-bold text-[#ECFF19] uppercase bg-[#ECFF19]/10 px-2 py-0.5 rounded border border-[#ECFF19]/25 inline-block">
              {currentMood || 'STANDBY'}
            </span>
          </div>
        </div>

        {/* DEFAULT CARD BOTTOM INFO (Fades away gracefully on hover, uses solid background to avoid fuzzy border artifact lines) */}
        <div className="absolute bottom-3 left-3 right-3 rounded-xl bg-black/92 border border-zinc-800/85 p-3 h-[68px] flex items-center justify-between pointer-events-auto transition-all duration-300 group-hover:opacity-0 group-hover:pointer-events-none z-10">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {/* Blinking indicator to the left of name */}
            <div className="relative flex items-center justify-center shrink-0 w-3 h-3">
              <span className="absolute inline-flex h-2 w-2 rounded-full bg-[#ECFF19] opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#ECFF19]" />
            </div>
            
            <div className="flex flex-col min-w-0 flex-1 leading-tight">
              <span className="font-orbitron text-sm font-extrabold tracking-wider text-zinc-100 uppercase truncate">
                {character.name}
              </span>
              <span className="text-[10px] font-mono text-zinc-400 truncate uppercase mt-0.5 tracking-wide">
                {character.role}
              </span>
            </div>
          </div>

          <div className="shrink-0 flex flex-col items-end gap-0.5 pl-2">
            <span className="text-[8px] font-mono text-zinc-500 uppercase tracking-widest font-bold">MOOD</span>
            <span className="text-[10px] font-mono font-extrabold text-[#ECFF19]">
              {currentMood || 'STANDBY'}
            </span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
