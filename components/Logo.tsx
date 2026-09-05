interface LogoProps {
  compact?: boolean;
}

export function Logo({ compact = false }: LogoProps) {
  return (
    <div className="brand" aria-label="ChatSanity">
      <svg
        className="brand__mark"
        viewBox="0 0 48 52"
        role="img"
        aria-label="盾とチャットのロゴ"
      >
        <path
          d="M24 3 43 10v13c0 12.4-7.7 21.4-19 26C12.7 44.4 5 35.4 5 23V10L24 3Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.2"
          strokeLinejoin="round"
        />
        <path
          d="M14 17.5c0-3 2.4-5.5 5.5-5.5h9c3 0 5.5 2.4 5.5 5.5v6c0 3-2.4 5.5-5.5 5.5h-3.2L20 34v-5h-.5c-3 0-5.5-2.4-5.5-5.5v-6Z"
          fill="currentColor"
        />
        <circle cx="20" cy="20.5" r="1.4" fill="white" />
        <circle cx="24" cy="20.5" r="1.4" fill="white" />
        <circle cx="28" cy="20.5" r="1.4" fill="white" />
      </svg>
      {!compact && <span className="brand__name">ChatSanity</span>}
    </div>
  );
}
