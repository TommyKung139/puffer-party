# 🐡 河豚派對 Krillion Puffer Party

A party word game for 4–8 players. The host's laptop or TV is the big screen. Everyone joins by scanning a QR code and types answers on their phone. Claude fact-checks every answer.

## 玩法 How to play

1. 主持人打開網站，大螢幕會顯示 QR Code 和房號。
2. 每個人用手機掃 QR Code，輸入名字加入（4–8 人）。
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
- **AI referee:** `/api/judge` asks Claude whether an answer fits the category. Answers Claude can't verify come back as "unsure": they count as a pass and get a tag on screen.
- **The host can always override:** press **O** during a verdict to overrule it, or **Y**/**N** to judge by hand.
- **Optional AI categories:** `/api/category` generates new categories when the source is set to 「AI 出題」.

## Deploy (GitHub + Vercel)

1. Push this folder to a new GitHub repo.
2. In Vercel, choose **Add New → Project**, then import the repo. Leave the defaults: no build command and no framework.
3. Under **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = your key from <https://console.anthropic.com> (**required for the AI referee**)
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
- **"AI 沒回應" messages mid-game:** usually the API's per-minute rate limit on a new account. Pre-checking makes a few extra calls per turn. Adding more credit raises your limit, or set `PRECHECK_AHEAD = 0` in `js/host.js` to only pre-check the current player.
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
