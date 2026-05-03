export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-8 text-center shadow-2xl">
          <div className="w-20 h-20 rounded-full bg-blue-500 flex items-center justify-center mx-auto mb-5 text-4xl shadow-lg shadow-blue-500/30">
            🎵
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">Comp Center Bot</h1>
          <p className="text-blue-300 text-sm mb-6">@CompCenterBot</p>

          <div className="flex items-center justify-center gap-2 mb-8">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
            </span>
            <span className="text-green-400 text-sm font-medium">Online</span>
          </div>

          <div className="grid grid-cols-1 gap-3 text-left mb-8">
            {[
              { icon: "🔍", label: "Inline Audio Search", desc: "Search music directly in any chat" },
              { icon: "🏷️", label: "MP3 Tag Editor", desc: "Tag your files with Normal or Fast mode" },
              { icon: "👑", label: "Premium Access", desc: "130 Stars/year for exclusive content" },
              { icon: "🎼", label: "Early Music Library", desc: "FLAC files for premium subscribers" },
            ].map((f) => (
              <div key={f.label} className="flex items-start gap-3 bg-white/5 rounded-xl p-3">
                <span className="text-xl">{f.icon}</span>
                <div>
                  <div className="text-white text-sm font-medium">{f.label}</div>
                  <div className="text-slate-400 text-xs">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <a
            href="https://t.me/CompCenterBot"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full bg-blue-500 hover:bg-blue-400 transition-colors text-white font-semibold py-3 rounded-xl text-sm"
          >
            Open in Telegram
          </a>
        </div>

        <p className="text-center text-slate-600 text-xs mt-6">
          Comp Center Bot · Powered by Replit
        </p>
      </div>
    </div>
  );
}
