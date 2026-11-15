import { cn } from '../lib/cn';

export type DinoMood = 'default' | 'happy' | 'waiting' | 'lost' | 'sleep';
export type DinoBeatTone = 'accent' | 'ok' | 'crit' | 'muted' | 'ink';

const BEAT_TONE: Record<DinoBeatTone, string> = {
  accent: 'rgb(var(--ac))',
  ok: 'rgb(var(--ok))',
  crit: 'rgb(var(--crit))',
  muted: 'rgb(var(--tx3))',
  ink: 'currentColor',
};

const LED_OK = 'rgb(var(--ok))';
const LED_OFF = 'rgb(var(--off))';
const HEIGHT_RATIO = 0.8;
const THIN_STROKE_BELOW = 64;

export interface DinoProps {
  mood?: DinoMood;
  /** Width in px; height is 80% of it. */
  size?: number;
  /** Colour of the heartbeat line (and the mood glyphs). */
  beatTone?: DinoBeatTone;
  /** Accessible name; pass "" when the dino is purely decorative. */
  label?: string;
  className?: string;
}

/** Dino.dc.html: Rex beside a three-unit rack under a heartbeat line. */
export function Dino({ mood = 'default', size = 240, beatTone = 'accent', label, className }: DinoProps) {
  const beat = BEAT_TONE[beatTone];
  const flat = mood === 'lost' || mood === 'sleep';
  const lost = mood === 'lost';
  const eyeDot = mood === 'default' || mood === 'waiting' || mood === 'lost';
  const alt = label ?? `Monitaur dino${mood === 'default' ? '' : ` (${mood})`}`;
  const decorative = alt === '';

  return (
    <span className={cn('inline-flex leading-[0] text-ink', className)}>
      <svg
        width={size}
        height={Math.round(size * HEIGHT_RATIO)}
        viewBox="0 0 120 96"
        fill="none"
        stroke="currentColor"
        strokeWidth={size < THIN_STROKE_BELOW ? 3.2 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : alt}
        aria-hidden={decorative ? true : undefined}
      >
        <path d={flat ? 'M4 14H116' : 'M4 14H38l5-9 6 18 5-12 3 3h59'} stroke={beat} />
        <path d="M2 92.5h116" strokeOpacity={0.3} />
        <rect x="80" y="38" width="32" height="54" rx="3" />
        <path d="M80 56h32M80 74h32M94 47h12M94 65h12M94 83h12" />
        <circle cx="86.5" cy="47" r="1.7" fill={lost ? LED_OFF : LED_OK} stroke="none" />
        <circle cx="86.5" cy="65" r="1.7" fill={lost ? LED_OFF : LED_OK} stroke="none" />
        <circle cx="86.5" cy="83" r="1.7" fill={mood === 'waiting' || lost ? LED_OFF : LED_OK} stroke="none" />
        <path d="M6 70Q20 63 31 55Q37 48 40 41V32Q40 24 48 24H63Q70 24 70 31V35Q70 38 66 38H55Q53 44 51 47Q57 57 53 66" />
        <path d="M6 70Q24 73 38 68Q46 66 52 64" />
        <path d="M51 64l3.5 14-1 12h7" />
        <path d="M38 68l3 12-3 10h7" />
        <path d="M51 50.5l6.5 3-.5 4" />
        <path d="M67 28.5h.01" />
        {eyeDot && (
          <circle
            cx={mood === 'waiting' ? 62.4 : 61}
            cy={mood === 'waiting' ? 29.4 : 30.4}
            r="1.9"
            fill="currentColor"
            stroke="none"
          />
        )}
        {mood === 'happy' && <path d="M58.6 31.2Q61 28.2 63.4 31.2" />}
        {mood === 'sleep' && <path d="M58.6 30.6H63.4" />}
        {!lost && <path d="M59 34.6Q62.5 36.4 66 34.4" />}
        {lost && <path d="M72 9.5q0-4 4-4t4 4q0 2.6-3 3.6-1 .4-1 2v1M76 20.2v.1" stroke={beat} />}
        {mood === 'waiting' && <path d="M88 30h.01M96 30h.01M104 30h.01" stroke={beat} strokeWidth={3} />}
        {mood === 'sleep' && <path d="M73 14h5l-5 5h5M80 6h4l-4 4h4" strokeWidth={1.6} />}
      </svg>
    </span>
  );
}
