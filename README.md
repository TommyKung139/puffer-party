# 🐡 河豚派對 Krillion Puffer Party

A party word game for 2–8 players. The host's laptop or TV is the big screen. Everyone joins by scanning a QR code and types answers on their phone. Claude fact-checks every answer.

## 玩法 How to play

1. 主持人打開網站，大螢幕會顯示 QR Code 和房號。
2. 每個人用手機掃 QR Code，輸入名字加入（2–8 人）。
3. 遊戲開始後，系統隨機挑一個人先答，之後依序輪流。
4. 每一題都有一個主題，例如「YouTube 點擊量 50 萬以上的音樂」。輪到你時，要在 **5 秒** 內送出一個符合主題的答案。
5. 以下情況都會吃一個 ✕：超時、答錯、跟已經答過的重複，或按「不知道」。
6. **3 個 ✕ 就出局**。每吃一個 ✕，你的河豚就會再脹大一點。
7. 如果一整輪都沒人答得出來，輪回到第一個卡住的人時就換新題目。
8. 最後剩下的那隻河豚獲勝 🏆

小技巧：還沒輪到你的時候，手機上已經可以先把答案打好。

## How it works

```
Phone ──WebRTC (PeerJS)──▶ Host browser (runs the game) ──▶ /api/judge (Vercel) ──▶ Claude
```

- **No game server.** The host's browser runs the game. Phones connect to it directly over WebRTC, using PeerJS's free public broker to find each other. Vercel only serves static files plus two small API routes.
- **Almost-instant verdicts:** while players type (even before their turn), their phone sends drafts to the host. The host pre-checks the drafts of the player on the clock and the next two in line, so when they hit send the verdict is usually already cached and appears instantly. A brand-new answer typed at the last second takes about one round trip, around a second with Haiku.
- **The game never stalls on the AI:**
  1. The server retries when the API is rate-limited, overloaded or erroring, and switches to a fallback model (`claude-sonnet-5-5`) if Haiku keeps failing. Rate limits are per model, so the fallback has its own budget.
  2. The host keeps pre-checks inside your API's per-minute limit, which it reads from the API's response headers, and spaces them out. Real answers always have room.
  3. If an answer still has no verdict after 4.5 seconds, it **counts as a pass**, tagged 「AI 沒回應」 on screen. The host can overrule with **O**. In the lobby you can switch this to "let the host decide" instead.
  4. The lobby runs a real test check on load. It shows the response time, or the exact problem (bad key, no credit, rate limit) before the game starts.
- **AI referee:** `/api/judge` asks Claude whether an answer fits the category. Answers Claude can't verify come back as "unsure": they count as a pass and get a tag on screen.
- **The host can always override:** press **O** during a verdict to overrule it, or **Y**/**N** to judge by hand.
- **Optional AI categories:** `/api/category` generates new categories when the source is set to 「AI 出題」.

## Deploy (GitHub + Vercel)

1. Push this folder to a new GitHub repo.
2. In Vercel, choose **Add New → Project**, then import the repo. Leave the defaults: no build command and no framework.
3. Under **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = your key from <https://console.anthropic.com> (**required for the AI referee**)
   - `ANTHROPIC_FALLBACK_MODEL` (optional): defaults to `claude-sonnet-5-5`. Set it to `none` to disable the fallback.
   - `ANTHROPIC_MODEL` (optional): defaults to `claude-haiku-5-5`, the fastest and cheapest. Set it to `claude-sonnet-5-5` for a slower but more knowledgeable referee.
4. Redeploy so the new variables take effect. Open `https://your-app.vercel.app` on the big screen.

Without an API key, the game still works: it switches to host judging and the built-in category bank.

## Host controls

| Key | Action |
|---|---|
| `Y` / `N` | Pass / fail the current answer by hand |
| `O` | Overrule the verdict on screen |
| `Space` | Pause / resume |
| `S` | Skip to a new category |
| `F` | Fullscreen |
| `M` | Mute |

Settings in the lobby: seconds per turn (3–15), AI or host judging, and category source (built-in bank, AI-generated, or your own list with one category per line).

## Customizing

- **Categories:** edit `js/categories.js`.
- **Strikes, player limits, timings:** see `new Engine({...})` and `DURATION` in `js/host.js`.
- **Referee strictness:** edit the `SYSTEM` prompt in `api/judge.js`.

## Testing alone

- Open `https://your-app.vercel.app/?dev` to start with only 1+ players.
- Open `play.html?room=XXXX` in several browser tabs. Each tab counts as a separate player.
- Run the engine tests with `npm test` (Node 18+, no dependencies).

## Troubleshooting

- **A phone can't connect.** WebRTC sometimes can't get through strict mobile-carrier NATs. The easiest fix is to put everyone on the same Wi-Fi as the host. If that's not possible, add a TURN server in `PEER_OPTIONS` in `js/shared.js`.
- **The host page was refreshed.** The game state is lost and a new room code appears, so phones have to scan again. Don't refresh during a game; the page warns you before it lets you.
- **A phone dropped out mid-game.** It reconnects automatically. If the tab was closed, rejoin with the **same name** to get your seat back.
- **Rate limits:** new accounts start at Tier 1, about 50 requests per minute per model. The game stays inside that, but with 8 fast players fewer answers get pre-checked, so some verdicts take about a second instead of being instant. Buying **US$40 of credit in total** moves you to Tier 2, about 1000 requests per minute, and the problem basically disappears. The lobby shows your current limit.
- **Before game night:** open the lobby and check for 「✅ AI 裁判正常」. If it shows ❌, the message tells you exactly what to fix.
- **Cost:** each check is one short Claude call, a fraction of a US cent on Haiku. Pre-checking adds a few calls per turn. Set a monthly spend limit in the Anthropic console. The API only accepts requests from your own site's origin, but that's light protection, not real security.

## Files

```
index.html        host / big screen
play.html         phone controller
css/style.css
js/engine.js      game rules (pure, unit-tested)
js/host.js        host: clock, networking, AI calls, UI
js/play.js        phone UI + reconnect
js/categories.js  built-in category bank
js/puffer.js      the pufferfish 🐡
js/sfx.js         sound effects (Web Audio)
js/shared.js      PeerJS config + helpers
api/judge.js      POST answer → pass / fail / unsure
api/category.js   POST → 8 fresh categories
tests/            node:test unit tests
```
