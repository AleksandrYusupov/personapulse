import React from 'react';
import { motion } from 'motion/react';
import { Character } from '../types';

interface CharacterCardProps {
  key?: string | number;
  character: Character;
  onSelect: (character: Character) => void;
}

export default function CharacterCard({ character, onSelect }: CharacterCardProps) {
  return (
    <motion.div
      id={`char-card-${character.id}`}
      layoutId={`card-container-${character.id}`}
      whileHover={{ y: -8, scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => onSelect(character)}
      className="relative overflow-hidden rounded-2xl border border-zinc-800/40 bg-zinc-950/40 p-5 transition-all cursor-pointer group hover:border-[#ECFF19]/60 hover:shadow-[0_0_25px_rgba(236,255,25,0.12)]"
    >
      {/* Background radial gradient representing theme color bloom */}
      <div 
        className="absolute -right-16 -top-16 h-36 w-36 rounded-full opacity-5 blur-3xl transition-opacity group-hover:opacity-15"
        style={{ backgroundColor: '#ECFF19' }}
      />

      {/* Futuristic corner ornaments */}
      <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 opacity-15 group-hover:opacity-80 transition-opacity border-[#ECFF19]" />
      <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 opacity-15 group-hover:opacity-80 transition-opacity border-[#ECFF19]" />

      {/* Image container with custom 4:5 aspect ratio to fit heights safely */}
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-xl border border-zinc-800/40 bg-zinc-900/50">
        {/* Sleek scanner light overlay on card hover */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/5 to-transparent -translate-y-full group-hover:translate-y-full transition-transform duration-1000 ease-in-out" />
        
        <img
          src={character.avatar}
          alt={character.name}
          className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-104 select-none"
          style={{ objectPosition: character.avatarObjectPosition || 'center' }}
          referrerPolicy="no-referrer"
        />

        {/* Hover overlay button with precise brand colors */}
        <div className="absolute inset-0 bg-black/85 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            whileHover={{ scale: 1.05 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex items-center gap-2 rounded-xl py-3 px-6 text-xs font-mono font-bold tracking-widest uppercase border border-[#ECFF19] text-black bg-[#ECFF19] shadow-lg transition-transform shadow-[#ECFF19]/35"
          >
            Initiate Contact
          </motion.div>
        </div>
      </div>

      {/* Character Core Info */}
      <div className="mt-5 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="font-orbitron text-xl font-extrabold tracking-wider text-slate-100 group-hover:text-[#ECFF19] transition-colors">
            {character.name}
          </h3>
        </div>

        <p className="text-xs font-mono text-zinc-400 h-10 line-clamp-2 leading-relaxed font-light">
          {character.shortDesc}
        </p>

        {/* Skills / Attributes micro bars */}
        <div className="mt-4 space-y-2 border-t border-zinc-900/80 pt-4">
          <div className="flex justify-between items-center text-[10px] font-mono font-bold text-zinc-500 tracking-wider">
            <span>TREATS</span>
            <span className="text-[#ECFF19] font-black">ACTIVE</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {character.traits.slice(0, 4).map((trait, idx) => (
              <div key={idx} className="space-y-1">
                <div className="h-1.5 w-full rounded-full bg-zinc-900 overflow-hidden border border-zinc-850">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${trait.value}%` }}
                    transition={{ duration: 1, delay: idx * 0.1 }}
                    className="h-full rounded-full bg-[#ECFF19]"
                  />
                </div>
                <div className="text-[8px] font-mono text-zinc-500 truncate text-center uppercase tracking-tighter">
                  {trait.label.split(' ')[0]}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
