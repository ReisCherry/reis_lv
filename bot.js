/**
 * bot.js — Islands.games Full Auto-Bot v3
 * Run: node bot.js --help  to see all options
 */

const WebSocket = require('ws');
const nacl      = require('tweetnacl');
const bs58      = require('bs58');
const fs        = require('fs');
const path      = require('path');
const { Keypair } = require('@solana/web3.js');
const bip39       = require('bip39');
const { derivePath } = require('ed25519-hd-key');

// ─────────────────────────────────────────────
// HELP SCREEN
// ─────────────────────────────────────────────
const HELP = `
╔═══════════════════════════════════════════════════════════════╗
║           🏝️  ISLANDS BOT v3 — COMMAND USAGE                  ║
╚═══════════════════════════════════════════════════════════════╝

  node bot.js [options]

──────────────────────────────────────────────────────────────
  FOCUS / FARMING MODE
──────────────────────────────────────────────────────────────
  --focus <mode>        What to farm (default: tree)
  --skip <mobs>         Comma-separated list of mobs to ignore (e.g. shaman,pigrider)

  Modes:
    tree                 Mine trees only (wood)
    gold                 Mine gold nodes only (requires Level 10!)
    diamond              Mine diamonds only (requires Level 60!)
    monster              Kill monsters (mob)
    boss                 Kill boss monsters only
    tree+gold            Farm trees AND gold (gold needs Lv10)
    tree+monster         Farm trees AND kill monsters
    tree+gold+diamond    Farm all resources
    all                  Everything: tree+gold+diamond+monster+boss

  Examples:
    node bot.js --focus tree
    node bot.js --focus tree+gold
    node bot.js --focus monster --skip pigrider,shaman
    node bot.js --focus all

──────────────────────────────────────────────────────────────
  SKILL ALLOCATION
──────────────────────────────────────────────────────────────
  --skill <mode>        Skill mode: priority | percent | single
                        (default: priority)

  Priority mode — fill first stat, then second:
    --skill priority --prio vit,str,agi
    node bot.js --skill priority --prio vit,str,agi

  Percent mode — distribute by percentage (must total 100):
    --skill percent --vit 60 --str 30 --agi 10
    node bot.js --skill percent --vit 50 --str 50 --agi 0

  Single mode — dump ALL points into one stat instantly:
    --skill single --stat vit
    node bot.js --skill single --stat str

──────────────────────────────────────────────────────────────
  PLAYER SETTINGS
──────────────────────────────────────────────────────────────
  --name <name>         Bot player name  (default: IslandsBot)
  --color <color>       Player color     (default: Blue)
                        Colors: Blue Red Green Yellow Purple Orange

──────────────────────────────────────────────────────────────
  PERFORMANCE
──────────────────────────────────────────────────────────────
  --speed <ms>          Attack interval in ms (default: 500)
                        Lower = faster attacks (min ~200)
  --chase <px>          Max chase distance for mobs (default: 400)
                        WARNING: Values below 300 can trigger anti-cheat!
  --fast                Enable speedhack for instant movement

──────────────────────────────────────────────────────────────
  EXAMPLES
──────────────────────────────────────────────────────────────
  # Tree farming, fast attacks, priority skill (vit first)
  node bot.js --focus tree --speed 300 --skill priority --prio vit,str,agi

  # All resources, percent skill split
  node bot.js --focus all --skill percent --vit 60 --str 30 --agi 10

  # Boss hunting, dump all skill into STR
  node bot.js --focus boss --skill single --stat str --speed 250

  # Custom name and color
  node bot.js --focus tree+gold --name MyBot --color Red

──────────────────────────────────────────────────────────────
  WALLET
──────────────────────────────────────────────────────────────
  Edit wallet.json and put your phrase or private key:
  { "wallet": "word1 word2 ... word12" }
  { "wallet": "base58privatekey..." }

══════════════════════════════════════════════════════════════
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

// ─────────────────────────────────────────────
// CONFIG & CLI PARSER
// ─────────────────────────────────────────────
const CFG_PATH    = path.join(__dirname, 'bot-config.json');
const WALLET_PATH = path.join(__dirname, 'wallet.json');
const SESSION_PATH= path.join(__dirname, 'session.json');
const ENV_PATH = '/root/.agent/credentials/solanaagent.env';

// Load from solanaagent.env if available
if (fs.existsSync(ENV_PATH)) {
  const envContent = fs.readFileSync(ENV_PATH, 'utf8');
  const match = envContent.match(/PRIVATE_KEY=(.+)/);
  if (match && match[1].trim()) {
    fs.writeFileSync(WALLET_PATH, JSON.stringify({ wallet: match[1].trim() }));
    console.log('✅ Loaded wallet from solanaagent.env');
  }
}

if (!fs.existsSync(WALLET_PATH)) {
  console.error('\n❌ wallet.json not found and no credentials in solanaagent.env!');
  console.error('   Add your private key to /root/.agent/credentials/solanaagent.env\n');
  process.exit(1);
}

const cfg = fs.existsSync(CFG_PATH)
  ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
  : {};

// Helper: get CLI arg value
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasArg(flag) { return process.argv.includes(flag); }

// ── Focus ──
const focusArg = arg('--focus', cfg.focus || 'tree');
const skipArg = arg('--skip', '');
const skipMobs = skipArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function parseFocus(f) {
  if (f === 'leveling') return { leveling: true };
  if (f === 'all') return { tree: true, gold: true, diamond: true, monster: true, boss: true };
  const parts = f.split('+');
  return {
    tree:    parts.includes('tree'),
    gold:    parts.includes('gold'),
    diamond: parts.includes('diamond'),
    monster: parts.includes('monster'),
    boss:    parts.includes('boss'),
  };
}
const MODES = parseFocus(focusArg);

// ── Skill ──
const SKILL_MODE = arg('--skill', cfg.autoSkill?.mode || 'priority').toLowerCase();
const SKILL_PRIO = arg('--prio',  (cfg.autoSkill?.priority || ['vit','str','agi']).join(',')).split(',');
const SKILL_STAT = arg('--stat',  cfg.autoSkill?.single?.stat || 'vit').toLowerCase();
const SKILL_VIT  = parseInt(arg('--vit', cfg.autoSkill?.percent?.vit  ?? 60));
const SKILL_STR  = parseInt(arg('--str', cfg.autoSkill?.percent?.str  ?? 30));
const SKILL_AGI  = parseInt(arg('--agi', cfg.autoSkill?.percent?.agi  ?? 10));

// ── Player ──
let BOT_NAME  = arg('--name', null);
if (!BOT_NAME && cfg.player?.name && cfg.player?.name !== 'IslandsBot') {
  BOT_NAME = cfg.player.name;
}
const BOT_COLOR = arg('--color', cfg.player?.color || 'Blue');

// ── Performance ──
const ATK_INTERVAL = parseInt(arg('--speed', cfg.settings?.attackIntervalMs || 500));
const ST_INTERVAL  = 100;
const MAX_CHASE    = parseInt(arg('--chase', cfg.settings?.maxMobChaseDist  || 400));
const FAST_MODE    = hasArg('--fast');
const MOVE_STEP    = FAST_MODE ? 500 : 80;
// BOSS_TYPES no longer needed — server now sends mob.boss = true on boss mobs directly
// Level requirements added in update:
const GOLD_LEVEL_REQ    = 10;  // Gold mining unlocked at level 10
const DIAMOND_LEVEL_REQ = 60;  // Diamond mining unlocked at level 60

const BASE_URL = 'https://islands.games';
const SIGN_MSG = 'islands: verify wallet ownership';
const GAME_WS  = 'wss://game-production-87db.up.railway.app/';
const TILE     = 64;

// ─────────────────────────────────────────────
// WALLET — auto-detect phrase or base58 key
// ─────────────────────────────────────────────
function loadKeypair() {
  const wData = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));

  // Support both simple { "wallet": "..." } and legacy { "secretKeyBase58": "..." }
  const input = (wData.wallet || wData.secretKeyBase58 || '').trim();

  if (!input) {
    console.error('\n❌ wallet.json is empty!');
    console.error('   Add your phrase or private key:\n');
    console.error('   { "wallet": "word1 word2 ... word12" }');
    console.error('   { "wallet": "base58privatekey..." }\n');
    process.exit(1);
  }

  const words = input.split(/\s+/);

  // 12 or 24 word mnemonic
  if (words.length === 12 || words.length === 24) {
    if (!bip39.validateMnemonic(input)) {
      console.error('\n❌ Invalid mnemonic phrase — check your words.\n');
      process.exit(1);
    }
    const seed    = bip39.mnemonicToSeedSync(input);
    const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    return Keypair.fromSeed(derived);
  }

  // base58 private key
  try {
    const raw = bs58.decode(input);
    if (raw.length !== 64) throw new Error('Expected 64-byte key');
    return Keypair.fromSecretKey(raw);
  } catch (e) {
    console.error('\n❌ Invalid wallet value in wallet.json');
    console.error('   Must be a 12/24-word phrase or base58 private key.\n');
    process.exit(1);
  }
}

const keypair = loadKeypair();
const WALLET  = keypair.publicKey.toBase58();

function signAuthMessage() {
  const msgBytes = new TextEncoder().encode(SIGN_MSG);
  const sig      = nacl.sign.detached(msgBytes, keypair.secretKey);
  return bs58.encode(Buffer.from(sig));
}

// ─────────────────────────────────────────────
// HTTP AUTH
// ─────────────────────────────────────────────
async function doLogin() {
  const sig = signAuthMessage();

  log('🔐', `Signing auth message...`);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${BASE_URL}/api/auth/connect`, {
      method:  'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Origin': BASE_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({ walletAddress: WALLET, walletType: 'phantom', signature: sig, message: SIGN_MSG }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    if (!res.ok || !data.sessionToken) {
      throw new Error(`Login failed: ${data.error || JSON.stringify(data)}`);
    }

    log('✅', `Login OK  — isNew: ${data.isNew}  char: ${data.char}`);
    fs.writeFileSync(SESSION_PATH, JSON.stringify({ walletAddress: WALLET, sessionToken: data.sessionToken, ...data }, null, 2));
    return data.sessionToken;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ─────────────────────────────────────────────
// DASHBOARD / DISPLAY
// ─────────────────────────────────────────────
let lastRender = 0;
const RENDER_INTERVAL = 500; // ms between full redraws

function hpBar(pct, width = 20) {
  if (isNaN(pct) || typeof pct !== 'number') pct = 1;
  if (pct < 0) pct = 0;
  if (pct > 1) pct = 1;
  const filled = Math.round(pct * width);
  const bar    = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color  = pct > 0.6 ? '\x1b[32m' : pct > 0.3 ? '\x1b[33m' : '\x1b[31m';
  const val = pct * 100;
  const pctStr = (val > 0 && val < 100) ? val.toFixed(4) : val.toFixed(0);
  return `${color}[${bar}]\x1b[0m ${pctStr}%`;
}

function xpBar(xpVal, cur, next, width = 20) {
  const req = next - cur;
  const progress = xpVal - cur;
  const pct = req > 0 ? Math.max(0, Math.min(1, progress / req)) : 0;
  const filled = Math.round(pct * width);
  return `\x1b[34m[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]\x1b[0m ${progress}/${req}`;
}

function modeStr() {
  return Object.entries(MODES)
    .filter(([, v]) => v)
    .map(([k]) => k.toUpperCase())
    .join(' + ');
}

function renderDashboard(state) {
  const now = Date.now();
  if (now - lastRender < RENDER_INTERVAL) return;
  lastRender = now;

  const p   = state.player;
  const inv = state.inv;
  const xp  = state.xp;
  const w   = state.world;
  const sess= state.session;

  // Clear screen
  process.stdout.write('\x1b[2J\x1b[H');

  const line = (s = '') => console.log(s);
  const sep  = (c = '─', n = 62) => console.log(c.repeat(n));

  sep('═');
  console.log(`  🏝️  ISLANDS BOT v3   │  Wallet: ${WALLET.slice(0,8)}...${WALLET.slice(-6)}`);
  sep('═');

  // ── Player ──
  line(`  👤 Player: \x1b[1m${BOT_NAME}\x1b[0m   ID: ${p.id || '—'}   Level: \x1b[33m${xp.level}\x1b[0m`);
  line(`  ❤️  HP  ${hpBar(p.hpPct)}`);
  line(`  ⭐ XP  ${xpBar(xp.xp, xp.cur, xp.next)}   Total: ${xp.xp}`);
  line(`  ⚡ Skills  STR:\x1b[31m${xp.str}\x1b[0m  VIT:\x1b[32m${xp.vit}\x1b[0m  AGI:\x1b[36m${xp.agi}\x1b[0m  Free:\x1b[33m${xp.free}\x1b[0m  Speed:${xp.speedMult}x`);
  line(`  📍 Pos: (${p.x}, ${p.y})   Facing: ${p.facing > 0 ? '→' : '←'}   Boat: ${p.boat ? '⛵' : '🚶'}`);

  sep();

  // ── Inventory ──
  line(`  🎒 INVENTORY`);
  line(`     🌲 Wood:    \x1b[32m${inv.wood.toString().padStart(6)}\x1b[0m   (+${sess.wood} this session)`);
  line(`     💰 Gold:    \x1b[33m${inv.gold.toString().padStart(6)}\x1b[0m   (+${sess.gold} this session)`);
  line(`     🥩 Meat:    \x1b[31m${inv.meat.toString().padStart(6)}\x1b[0m   (+${sess.meat} this session)`);
  line(`     💎 Diamond: \x1b[96m${(inv.diamond || 0).toString().padStart(6)}\x1b[0m`);
  if (inv.usdc > 0) line(`     💵 USDC:    \x1b[32m${inv.usdc.toFixed(2).padStart(6)}\x1b[0m`);

  sep();

  // ── World ──
  line(`  🌍 WORLD STATE`);
  const aliveMobs  = w.mobs.filter(m => m.state !== 'dead');
  const bossMobs   = aliveMobs.filter(m => m.boss === true);
  const fullTrees  = w.trees.filter(t => t.hpPct === undefined || t.hpPct >= 1);
  const goldAvail  = w.golds.filter(g => g.pct < 1);
  const dmdAvail   = w.diamonds?.filter(d => d.pct < 1) || [];

  line(`     ⚔️  Mobs alive:   ${aliveMobs.length}   (Bosses: \x1b[31m${bossMobs.length}\x1b[0m)`);
  line(`     🌲 Trees (full): ${fullTrees.length} / ${w.trees.length}`);
  line(`     ⛏️  Gold nodes:   ${goldAvail.length} available`);
  line(`     💎 Diamond:      ${dmdAvail.length} available`);
  line(`     👥 Players:      ${w.players.length}`);

  // Current target
  if (state.currentTarget) {
    const t = state.currentTarget;
    let distVal = '?';
    if (t.wx !== undefined && t.wy !== undefined) {
      distVal = distTo(t.wx, t.wy).toFixed(0);
    } else if (t.dist !== undefined) {
      distVal = t.dist.toFixed(0);
    }
    
    let liveHpPct = t.hpPct ?? 1;
    const ttype = (t.type || '').toLowerCase();
    if (t._near) {
      const key = `${ttype.startsWith('gold') ? 'gold' : ttype.startsWith('diamond') ? 'diamond' : ttype === 'tree' ? 'tree' : 'mob'}:`;
      if (key.startsWith('gold:')) {
        const node = state.world.golds.find(g => g.x === t._near.x && g.y === t._near.y);
        if (node) liveHpPct = 1 - node.pct;
      } else if (key.startsWith('diamond:')) {
        const node = state.world.diamonds.find(d => d.x === t._near.x && d.y === t._near.y);
        if (node) liveHpPct = 1 - node.pct;
      } else if (key.startsWith('tree:')) {
        const hit = state.world.treeHits.find(h => h.x === t._near.x && h.y === t._near.y);
        liveHpPct = hit ? 1 - hit.pct : 1;
      } else if (key.startsWith('mob:')) {
        const mob = state.world.mobs.find(m => m.id === t._near.id);
        if (mob) liveHpPct = mob.hpPct ?? 1;
      }
    }
    
    line('');
    let hpStr = `HP: ${hpBar(liveHpPct, 12)}`;
    line(`  🎯 TARGET: \x1b[33m${t.type || t.kind || '?'}\x1b[0m  ${hpStr}  dist: ${distVal}`);
  }

  sep();

  // ── Stats ──
  line(`  📊 SESSION STATS`);
  line(`     Kills:   ${sess.kills}   Attacks: ${sess.attacks}   Skill-ups: ${sess.skillUps}`);
  line(`     Mode:    \x1b[1m\x1b[36m${state.mode.toUpperCase()}\x1b[0m   Focus: \x1b[33m${modeStr()}\x1b[0m`);
  line(`     Uptime:  ${formatTime(Date.now() - state.startTime)}`);

  if (state.equipment && Object.keys(state.equipment).length) {
    sep();
    line(`  🛡️  EQUIPMENT`);
    for (const [slot, itemId] of Object.entries(state.equipment)) {
      if (itemId) {
        const itemObj = typeof itemId === 'string'
          ? (state.inventoryItems || []).find(i => i.id === itemId) || { id: itemId }
          : itemId;
        line(`     ${slot.padEnd(8)}: ${itemObj.name || itemObj.id || '?'} (Lv${itemObj.level || 1})`);
      }
    }
  }

  sep('═');
  line(`  \x1b[90mPress Ctrl+C to stop\x1b[0m`);
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function log(icon, msg) {
  // Print below dashboard area when possible
  const ts = new Date().toLocaleTimeString();
  process.stdout.write(`\x1b[0m${icon}  [${ts}] ${msg}\n`);
}

function sendAttack() {
  const isMoving = Date.now() < state.movingUntil;
  let bd = state.player.bd || 'left';
  const payload = {
    t: 'state', x: Math.round(state.player.x), y: Math.round(state.player.y),
    moving: isMoving, facing: state.player.facing > 0 ? 1 : -1,
    boat: state.player.boat, bd: bd,
    vcx: Math.round(state.player.x), vcy: Math.round(state.player.y), vr: 830,
  };
  log('DEBUG', `WS_OUT: ${JSON.stringify(payload)}`);
  send(payload);

  log('DEBUG', `WS_OUT: {"t":"attack"}`);
  send({ t: 'attack' });
  state.session.attacks++;
  state.attacksOnCurrentTarget++;
  state.attacksSinceLastProgress++;
}

// ─────────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────────
const state = {
  ws:        null,
  connected: false,
  authed:    false,
  mode:      Object.keys(MODES).find(k => MODES[k]) || 'tree',
  modeIdx:   0,
  modeList:  Object.keys(MODES).filter(k => MODES[k]),
  startTime: Date.now(),

  player: { id: null, x: 16000, y: 16000, facing: 1, boat: false, hpPct: 1, bd: 'right', vcx: 16000, vcy: 16000, vr: 3275 },
  inv:    { wood: 0, gold: 0, meat: 0, diamond: 0, usdc: 0 },
  xp:     { level: 1, xp: 0, cur: 0, next: 100, str: 0, vit: 0, agi: 0, free: 0, speedMult: 1 },
  world:  { mobs: [], trees: [], golds: [], diamonds: [], players: [], treeHits: [], farMobs: [] },
  equipment: {},
  inventoryItems: [], // items with id/slot/name for auto-equip

  currentTarget: null,
  movingUntil:   0,       // timestamp until which we consider ourselves "in motion"
  lockMobId:     null,
  lockResource:  null,    // { type: 'tree'|'gold'|'diamond', x, y, wx, wy }
  currentTargetKey: null, // string key of current target
  attacksOnCurrentTarget: 0,
  attacksSinceLastProgress: 0,
  lastTargetProgressValue: 0,
  lastLootTotal: 0,
  gotLoot:       false,
  failedResources: new Map(),
  cooldownResources: new Map(),
  failedMobs:      new Map(),

  session: { wood: 0, gold: 0, meat: 0, kills: 0, attacks: 0, skillUps: 0 },
  _killsBaseline: null,   // lifetime kill count at session start (to compute delta)

  reconnects:    0,
  maxReconnects: cfg.settings?.maxReconnects || 10,
  _pingTimer:    null,
  _stateTimer:   null,
  _atkTimer:     null,
  _dashTimer:    null,
  _running:      false,
  worldReceived: false,
  playerPosInitialized: false,
  initialDispersionDone: false,
  dispersionTarget: null,
  lastBreakTime: Date.now(),
  nextBreakDuration: 0,
  isResting: false,
  lastPositionCheckTime: Date.now(),
  lastPositionCheckCoords: { x: 16000, y: 16000 },
  forcedWanderTarget: null,
};

// ─────────────────────────────────────────────
// WS SEND
// ─────────────────────────────────────────────
function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function sendState() {
  if (state.player.hpPct <= 0) return;
  // CRITICAL FIX: As per the manual browser dumps, when attacking (not moving), 
  // vcx and vcy must equal the player's exact X and Y coordinates. 
  // They should NOT equal the target node's coordinates.
  const isMoving = Date.now() < state.movingUntil;

  // Auto-detect boat status based on tile data
  // In Islands, land tiles are explicitly sent in chunks. Water is the default background.
  const tx = Math.floor(state.player.x / 64);
  const ty = Math.floor(state.player.y / 64);
  const cx = Math.max(0, Math.min(9, Math.floor(state.player.x / 3200)));
  const cy = Math.max(0, Math.min(9, Math.floor(state.player.y / 3200)));
  const chunkKey = `${cx},${cy}`;

  // ── Boat detection ──
  // Check strictly based on the exact tile the player is currently standing on.
  if (chunks.loaded.has(chunkKey)) {
    if (chunks.landTiles && chunks.landTiles.has(`${tx},${ty}`)) {
      state.player.boat = false; // On land
    } else {
      state.player.boat = true;  // On water
    }
  } else {
    state.player.boat = false; // Default to land if chunk isn't loaded yet
  }



  let vcx = Math.round(state.player.x);
  let vcy = Math.round(state.player.y);
  const vr = 830; // Matches user's client
  
  const payload = {
    t: 'state', x: Math.round(state.player.x), y: Math.round(state.player.y),
    moving: isMoving, facing: state.player.facing > 0 ? 1 : -1,
    boat: state.player.boat, bd: state.player.bd,
    vcx, vcy, vr,
  };
  
  const payloadStr = JSON.stringify(payload);
  if (state._lastStatePayload === payloadStr && Date.now() - (state._lastStateTime || 0) < 5000) {
    return; // Heartbeat every 5s if unchanged
  }
  
  state._lastStatePayload = payloadStr;
  state._lastStateTime = Date.now();
  
  state.player.vcx = vcx;
  state.player.vcy = vcy;
  state.player.vr = vr;
  send(payload);
}


function allocSkill(stat) {
  send({ t: 'allocate', stat });
  state.session.skillUps++;
  state.xp.free--;
  log('🎯', `Skill UP → ${stat.toUpperCase()} (free left: ${state.xp.free})`);
}

// ─────────────────────────────────────────────
const GEMINI_API_KEY = 'AQ.Ab8RN6L2QaZyWgUPNXiXvqnqtF_qqhgFt1EgTEQNQ9BkCnZpig';
const OPENAI_API_KEY = 'sk-nry-9xfIhZ9Bsiquia0cF9Ie4YwNtxRSlm7Ev3mVsI4XloI';

function findBase64Image(obj) {
  if (typeof obj === 'string') {
    if (obj.startsWith('data:image/') && obj.includes('base64,')) {
      return obj.split('base64,')[1];
    }
    if (obj.length > 100 && /^[a-zA-Z0-9\+/]*={0,2}$/.test(obj)) {
      return obj;
    }
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.keys(obj)) {
      const found = findBase64Image(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

function findUrl(obj) {
  if (typeof obj === 'string') {
    if (obj.startsWith('http://') || obj.startsWith('https://')) {
      return obj;
    }
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.keys(obj)) {
      const found = findUrl(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// CAPTCHA SOLVERS
// ─────────────────────────────────────────────

// Generic timeout-guarded fetch (aborts after ms milliseconds)
async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Download image from URL and return base64 string (10s timeout)
async function downloadImageBase64(imageUrl) {
  try {
    const imgRes = await fetchWithTimeout(imageUrl, {}, 10000);
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    return buffer.toString('base64');
  } catch (err) {
    log('⚠️', `Image download failed: ${err.message}`);
    return null;
  }
}

// Shared prompt builder for both AI services
function buildCaptchaPrompt(msg) {
  const question = msg.prompt || msg.q || msg.question || msg.text || msg.msg || '';
  const options  = msg.options || msg.answers || [];
  return `You are solving a CAPTCHA for the game islands.games.
Packet received from game server:
${JSON.stringify(msg, null, 2)}

RULES:
- Question/prompt: "${question}"
- Available options: ${JSON.stringify(options)}
- You MUST select one answer from the options list above.
- Output ONLY the exact option string. No explanations, no markdown, no extra words.
- If it is a visual captcha (image), identify what is shown and pick the best matching option.`;
}

// Extract and validate the AI answer against the options list
function matchAnswerToOptions(rawAnswer, options) {
  if (!rawAnswer) return null;
  const cleaned = rawAnswer.replace(/[`"'\n\r]/g, '').trim();
  if (!options || options.length === 0) return cleaned;

  // 1. Exact match
  const exact = options.find(o => o === cleaned);
  if (exact) return exact;

  // 2. Case-insensitive exact match
  const ci = options.find(o => o.toLowerCase() === cleaned.toLowerCase());
  if (ci) return ci;

  // 3. Option contains answer or answer contains option (partial)
  const partial = options.find(o =>
    o.toLowerCase().includes(cleaned.toLowerCase()) ||
    cleaned.toLowerCase().includes(o.toLowerCase())
  );
  if (partial) return partial;

  // 4. No match — return null so caller can fallback
  return null;
}

async function askGeminiToSolveCaptcha(msg) {
  if (!GEMINI_API_KEY) return null;

  const base64Img = findBase64Image(msg) || await downloadImageBase64(findUrl(msg));
  const parts = [{ text: buildCaptchaPrompt(msg) }];
  if (base64Img) {
    parts.push({ inlineData: { mimeType: 'image/png', data: base64Img } });
    log('🤖', 'Gemini: image attached.');
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    }, 12000); // 12s hard limit

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty Gemini response');
    log('🤖', `Gemini raw answer: "${text.trim()}"`);
    return text.trim();
  } catch (err) {
    log('❌', `Gemini error: ${err.message}`);
    return null;
  }
}


async function askOpenAiToSolveCaptcha(msg) {
  if (!OPENAI_API_KEY) return null;

  const base64Img = findBase64Image(msg) || await downloadImageBase64(findUrl(msg));
  const content = [{ type: 'text', text: buildCaptchaPrompt(msg) }];
  if (base64Img) {
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64Img}` } });
    log('🤖', 'OpenAI: image attached.');
  }

  try {
    const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content }], max_tokens: 50 })
    }, 12000); // 12s hard limit

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty OpenAI response');
    log('🤖', `OpenAI raw answer: "${text.trim()}"`);
    return text.trim();
  } catch (err) {
    log('❌', `OpenAI error: ${err.message}`);
    return null;
  }
}


function solveMathQuestion(q) {
  if (!q) return null;
  const cleanQ = q.replace(/[^0-9\+\-\*\/\s]/g, '').trim();
  const match = cleanQ.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
  if (!match) return null;

  const num1 = parseInt(match[1], 10);
  const op = match[2];
  const num2 = parseInt(match[3], 10);

  let result;
  switch (op) {
    case '+': result = num1 + num2; break;
    case '-': result = num1 - num2; break;
    case '*': result = num1 * num2; break;
    case '/': result = num2 !== 0 ? num1 / num2 : null; break;
    default: return null;
  }
  return result;
}

async function handleCaptchaOrMath(msg) {
  log('🚨', 'CAPTCHA/MATH DETECTED!');
  const question = msg.prompt || msg.q || msg.question || msg.text || msg.msg || '';
  const options  = msg.options || msg.answers || [];
  console.log('\n==================================================');
  console.log('🚨 WARNING: CAPTCHA detected!');
  console.log(`   Question : ${question || '(visual)'}`);
  console.log(`   Options  : ${options.length > 0 ? options.join(', ') : 'None'}`);
  console.log('   ⚡ Bot will auto-solve — do NOT close the terminal!');
  console.log('==================================================\n');

  // PAUSE attack loop only — WebSocket stays ALIVE
  clearInterval(state._stateTimer);
  clearTimeout(state._atkTimeout);
  state._stateTimer = null;
  state._atkTimeout = null;
  state.lockResource = null;
  state.lockMobId = null;

  for (let i = 0; i < 5; i++) setTimeout(() => process.stdout.write('\x07'), i * 300);

  const DEADLINE_MS   = 25000; // Disconnect after 25s if unsolved to simulate human logout
  const startTime     = Date.now();
  let   answered      = false; // Prevent double-send

  // Live countdown so user sees pressure
  const countdown = setInterval(() => {
    const left = Math.max(0, Math.ceil((DEADLINE_MS - (Date.now() - startTime)) / 1000));
    process.stdout.write(`\r⏱️  Captcha: ${left}s remaining...   `);
    if (left <= 0) clearInterval(countdown);
  }, 1000);

  // Resume bot timers (no chunk reload)
  async function resumeBot() {
    clearInterval(countdown);
    process.stdout.write('\n');
    log('✅', 'Bot resumed after captcha.');
    state._stateTimer = setInterval(sendState, ST_INTERVAL);
    await sleep(1000);
    runAttackLoop();
  }

  // The single send path — guarded so only one answer ever goes out
  async function finalAnswer(raw) {
    if (answered) return;
    answered = true;
    clearInterval(countdown);

    // Validate/fuzzy-match against server options
    const best = matchAnswerToOptions(raw, options) || (options.length > 0 ? options[0] : raw);
    
    // Human-like delay: at least 1.5s, but never push past the deadline
    const elapsed = Date.now() - startTime;
    const safeDelay = Math.min(1500 + Math.random() * 1500, Math.max(0, DEADLINE_MS - elapsed - 3000));
    if (safeDelay > 0) await sleep(safeDelay);

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      const payload = { t: msg.t, answer: best, ans: best };
      if (msg.id) payload.id = msg.id;
      process.stdout.write('\n');
      log('📩', `Captcha answer → "${best}" (sent at ${Math.round((Date.now() - startTime) / 1000)}s)`);
      send(payload);
      await sleep(2000);
      await resumeBot();
    } else {
      log('❌', 'WebSocket closed — bot will reconnect and continue.');
      clearInterval(countdown);
    }
  }

  // Emergency: gracefully disconnect instead of auto-picking
  const emergencyTimer = setTimeout(() => {
    if (answered) return;
    answered = true;
    log('🚨', `25 seconds passed! Disconnecting cleanly to mimic human logout.`);
    
    // Disable default auto-reconnect temporarily so it doesn't instantly reconnect
    state._running = false; 
    
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    
    log('🛑', `Bot stopped to prevent ban. Please run the script lagi secara manual.`);
    setTimeout(() => process.exit(0), 1000);

  }, DEADLINE_MS);

  // ── STEP 1: Local math solver (instant, no network) ──
  const isMath = msg.type === 'math' || msg.t === 'math';
  if (isMath) {
    const result = solveMathQuestion(question);
    if (result !== null) {
      const opt = options.find(o => parseInt(o.replace(/[^0-9\-]/g, ''), 10) === result);
      const mathAnswer = opt !== undefined ? opt : String(result);
      log('🧮', `Math solved instantly: ${question} = ${mathAnswer}`);
      clearTimeout(emergencyTimer);
      await finalAnswer(mathAnswer);
      return;
    }
  }

  // ── STEP 2: Race Gemini vs OpenAI in parallel (first valid wins) ──
  log('🤖', 'Racing Gemini & OpenAI in parallel...');
  try {
    const winner = await Promise.any([
      askGeminiToSolveCaptcha(msg).then(r => { if (!r) throw new Error('null'); return r; }),
      askOpenAiToSolveCaptcha(msg).then(r => { if (!r) throw new Error('null'); return r; }),
    ]);
    if (!answered) {
      clearTimeout(emergencyTimer);
      await finalAnswer(winner);
    }
    return;
  } catch {
    log('⚠️', 'Both AIs failed.');
  }

  // ── STEP 3: Manual terminal input (with countdown pressure) ──
  if (!answered) {
    process.stdout.write('\n');
    log('⚠️', 'All AI solvers failed! Type the answer NOW (you have limited time):');
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('✍️  Answer: ', async (ans) => {
      rl.close();
      clearTimeout(emergencyTimer);
      if (!answered) await finalAnswer(ans.trim());
    });
  }
}


// ─────────────────────────────────────────────
// WS MESSAGE HANDLER
// ─────────────────────────────────────────────
function handleMsg(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.t) {
    case 'captcha':
    case 'math':
      handleCaptchaOrMath(msg);
      break;

    case 'welcome':
      state.player.id   = msg.id;
      state.authed      = true;
      state.reconnects  = 0; // reset on successful auth
      log('✅', `Authenticated! Player ID: ${msg.id}`);
      startIntervals();
      break;

    case 'hp':
      state.player.hpPct = msg.pct ?? msg.hp ?? 1;
      break;

    case 'inv':
      log('DEBUG', `INV packet: ${JSON.stringify(msg)}`);
      state.inv = {
        wood:    msg.wood    ?? state.inv.wood,
        gold:    msg.gold    ?? state.inv.gold,
        meat:    msg.meat    ?? state.inv.meat,
        diamond: msg.diamond ?? state.inv.diamond,
        usdc:    msg.usdc    ?? state.inv.usdc,
      };
      break;

    case 'xp': {
      const prevFree = state.xp.free;
      const prevLv   = state.xp.level;
      state.xp = {
        level: msg.level ?? state.xp.level, xp: msg.xp ?? state.xp.xp, cur: msg.cur ?? state.xp.cur, next: msg.next ?? state.xp.next,
        str: msg.str ?? state.xp.str, vit: msg.vit ?? state.xp.vit, agi: msg.agi ?? state.xp.agi,
        free: msg.free ?? state.xp.free, speedMult: msg.speedMult ?? state.xp.speedMult,
      };
      if (msg.level > prevLv) log('⬆️', `LEVEL UP! → ${msg.level}`);
      if (msg.free > 0 && msg.free !== prevFree && cfg.autoSkill?.enabled !== false) {
        setTimeout(() => autoAllocSkills(), 600);
      }
      break;
    }

    case 'stats': {
      const totalKills = msg.mobKills || 0;
      // First stats packet: record the lifetime baseline so session starts at 0
      if (state._killsBaseline === null) {
        state._killsBaseline = totalKills;
        log('📊', `Kill baseline: ${totalKills} lifetime kills (session starts at 0)`);
      }
      const sessionKills = totalKills - state._killsBaseline;
      if (sessionKills > state.session.kills) {
        const delta = sessionKills - state.session.kills;
        state.session.kills = sessionKills;
        log('💀', `Mob killed! Session: +${delta}  Total this run: ${sessionKills}`);
        if ((state.mode === 'monster' || state.mode === 'boss') && !state.gotLoot) {
          state.gotLoot = true;
          if (state.modeList.length > 1) advanceMode();
        }
      }
      break;
    }

    case 'nodeLocked':
      // Server sends this when player level is too low to mine node
      // { t:'nodeLocked', kind:'gold'|'diamond', need: <levelRequired> }
      log('🔒', `Node locked! ${msg.kind} requires Level ${msg.need}. Current: Lv${state.xp.level}`);
      // Skip this node type and advance mode
      if (msg.kind === 'gold' && state.mode === 'gold') {
        log('⚠️', 'Skipping gold — need Level 10. Advancing mode.');
        advanceMode();
      } else if (msg.kind === 'diamond' && state.mode === 'diamond') {
        log('⚠️', 'Skipping diamond — need Level 60. Advancing mode.');
        advanceMode();
      }
      break;

    case 'farmobs':
      // New packet: far mob overview { t:'farmobs', mobs: [[x,y,type], ...] }
      // Update far mobs so boss mode can see bosses beyond normal view range
      if (Array.isArray(msg.mobs)) {
        state.world.farMobs = msg.mobs.map(m => ({ x: m[0], y: m[1], type: m[2] }));
      }
      break;

    case 'loot':
      onLoot(msg.item, msg.qty);
      break;

    case 'world':
      state.worldReceived = true;
      if (msg.mobs) {
              // Parse mob arrays using game's mc() function format:
              // [id, x, y, facing, hpPct, state, type, boss, name?]
              state.world.mobs = msg.mobs.map(m => {
                if (Array.isArray(m)) {
                  return {
                    id: m[0],
                    x: m[1],
                    y: m[2],
                    facing: m[3],
                    hp: m[4],
                    hpPct: m[4] / 100.0,
                    state: m[5],
                    type: m[6],
                    boss: !!m[7],
                    name: m[7] ? m[8] : void 0
                  };
                }
                return m;
              });
            }
            if (msg.trees)    state.world.trees    = msg.trees.map(t => Array.isArray(t) ? { x: t[0], y: t[1] } : t);
            if (msg.golds) {
              state.world.golds = msg.golds.map(g => Array.isArray(g) ? { x: g[0], y: g[1], pct: (g[2] !== undefined && g[2] !== null) ? g[2] / 1000 : 1.0 } : g);
            }
            if (msg.diamonds) {
              state.world.diamonds = msg.diamonds.map(d => Array.isArray(d) ? { x: d[0], y: d[1], pct: (d[2] !== undefined && d[2] !== null) ? d[2] / 1000 : 1.0 } : d);
            }
            if (msg.treeHits) state.world.treeHits = msg.treeHits.map(h => Array.isArray(h) ? { x: h[0], y: h[1], pct: h[2] / 1000 } : h);
      if (msg.players) {
        state.world.players = msg.players.map(p => {
          if (Array.isArray(p)) {
            return {
              id: p[0],
              x: p[1],
              y: p[2],
              facing: p[3],
              hp: p[4],
              hpPct: p[5],
              boat: !!p[6],
              level: p[7],
              name: p[12]
            };
          }
          return p;
        });

        // Anti-ban detection for specific user
        const dangerousPlayer = state.world.players.find(p => p.name === 'LawyerCat');
        if (dangerousPlayer) {
          log('🚨', `DANGER! ${dangerousPlayer.name} detected! Disconnecting immediately to avoid ban!`);
          process.exit(0);
        }

        if (state.player.id) {
          const me = state.world.players.find(p => p.id === state.player.id);
          if (me) {
            if (state.playerPosInitialized) {
              if (!state._serverPosHistory) state._serverPosHistory = [];
              state._serverPosHistory.push({ x: me.x, y: me.y, time: Date.now() });
              if (state._serverPosHistory.length > 10) state._serverPosHistory.shift();
            }
            if (!state.playerPosInitialized && me.x > 1000 && me.y > 1000) {
              state.player.x = Math.round(me.x);
              state.player.y = Math.round(me.y);
              state.playerPosInitialized = true;
              log('📍', `Initialized player position from server: (${state.player.x}, ${state.player.y})`);
            } else if (state.playerPosInitialized && Date.now() > state.movingUntil + 500) {
              // When not moving, correct any drift from server's authoritative position
              state.player.x = Math.round(me.x);
              state.player.y = Math.round(me.y);
            }
          }
        }
      }
      if (msg.treeHits) state.world.treeHits = msg.treeHits;
      break;

    case 'equipment':
      // Server: { t:'equipment', equipment: [...items], equipped: {slot: item} }
      log('🐛', `DEBUG equipment: ${JSON.stringify(msg)}`);
      if (Array.isArray(msg.equipment)) state.inventoryItems = msg.equipment;
      if (msg.equipped && typeof msg.equipped === 'object') state.equipment = msg.equipped;
      break;

    case 'items':
      // Server: { t:'items', items: {id: item, ...} }
      for (const [key, item] of Object.entries(msg.items || {})) {
        log('DEBUG', `Item spawned: ${JSON.stringify(item)}`);
      }
      if (msg.items && typeof msg.items === 'object') {
        const newItems = Object.values(msg.items);
        if (newItems.length > 0) {
          // Append new items instead of overwriting the equipment array
          state.inventoryItems = [...(state.inventoryItems || []), ...newItems];
        }
      }
      break;

    case 'spawn':
    case 'respawn':
      state.player.x = msg.x;
      state.player.y = msg.y;
      state.player.vcx = msg.x;
      state.player.vcy = msg.y;
      state.player.hpPct = 1; // Reset HP to 100% on spawn/respawn
      state.playerPosInitialized = true;
      log('📍', `Spawned/Respawned at position: (${msg.x}, ${msg.y})`);
      ensureNearbyChunks(); // trigger pre-loading chunks
      break;

    case 'kicked':
      log('⛔', `Kicked: ${msg.reason}`);
      // Track kick reason for smarter reconnect
      state._lastKickReason = msg.reason;
      break;

    // Log islands packets to see if gold HP updates come through here
    case 'islandsDelta': case 'islandsFull':
        log('DEBUG', `${msg.t}: ${JSON.stringify(msg)}`);
        break;
    case 'boosts': case 'buffs':
    case 'market': case 'myUnits':
    case 'marketList': case 'pdens': case 'quests':
      break;

    case 'died':
      if (state.player.hpPct !== 0) {
        state.player.hpPct = 0; // Set HP to 0 when dead
        log('💀', 'Player died! Waiting to revive...');
      }
      break;
    case 'error':
      log('❌', `Server error: ${msg.message || msg.reason || JSON.stringify(msg)}`);
      break;

    default:
      // log('?', `Unknown msg: ${msg.t}`);
      break;
  }
}

function onLoot(item, qty) {
  switch (item) {
    case 'wood':    state.session.wood += qty; log('🌲', `Wood  +${qty}  (session: +${state.session.wood})`); break;
    case 'gold':    state.session.gold += qty; log('⛏️', `Gold  +${qty}  (session: +${state.session.gold})`); break;
    case 'meat':    state.session.meat += qty; log('🥩', `Meat  +${qty}  (session: +${state.session.meat})`); break;
    case 'diamond': log('💎', `Diamond +${qty}!`); break;
    default:        log('🎁', `Loot: ${item} x${qty}`); break;
  }
  if ((state.mode === 'tree' && item === 'wood') ||
      (state.mode === 'gold' && item === 'gold') ||
      (state.mode === 'diamond' && item === 'diamond')) {
    
    // For gold/diamond: NEVER release lock immediately on loot.
    // The server may send loot packets slightly before the node fully disappears.
    // We wait 2 seconds and then check if the node is truly gone (pct === 0).
    if (state.lockResource && (state.lockResource.type === 'gold' || state.lockResource.type === 'diamond')) {
      const lx = state.lockResource.x, ly = state.lockResource.y;
      const ltype = state.lockResource.type;
      setTimeout(() => {
        // Only release if the node is actually depleted now (2 seconds later)
        const activeList = ltype === 'gold' ? state.world.golds : state.world.diamonds;
        const activeNode = activeList.find(g => g.x === lx && g.y === ly);
        const isGone = !activeNode || (activeNode.pct !== undefined && activeNode.pct === 0);
        if (isGone && state.lockResource && state.lockResource.x === lx && state.lockResource.y === ly) {
          log('⛏️', `Node [${lx},${ly}] confirmed fully destroyed. Releasing lock and finding next target.`);
          state.lockResource = null;
          state.lockMobId = null;
          state.gotLoot = true;
          if (state.modeList.length > 1) advanceMode();
        }
      }, 2000);
      return; // Don't release lock right now - let the setTimeout handle it
    }

    // For tree: release immediately
    state.lockResource = null;
    state.lockMobId = null;
    state.gotLoot = true;
    if (state.modeList.length > 1) advanceMode();
  }
}

// ─────────────────────────────────────────────
// SKILL AUTO-ALLOC  (mode: priority | percent | single)
// ─────────────────────────────────────────────

// Tracks total allocated this session for percent mode
const skillAllocated = { vit: 0, str: 0, agi: 0 };

function autoAllocSkills() {
  if (cfg.autoSkill?.enabled === false) return;
  if (state.xp.free <= 0) return;

  // ── SINGLE ──
  if (SKILL_MODE === 'single') {
    const stat = SKILL_STAT;
    if (!['vit','str','agi'].includes(stat)) { log('⚠️', `Bad --stat: ${stat}`); return; }
    while (state.xp.free > 0) allocSkill(stat);
    return;
  }

  // ── PERCENT ──
  if (SKILL_MODE === 'percent') {
    const pct   = { vit: SKILL_VIT, str: SKILL_STR, agi: SKILL_AGI };
    const total = SKILL_VIT + SKILL_STR + SKILL_AGI;
    if (total === 0) { log('⚠️', '--vit/--str/--agi all 0'); return; }
    const norm = { vit: pct.vit/total, str: pct.str/total, agi: pct.agi/total };
    
    while (state.xp.free > 0) {
      const totalAlloc = skillAllocated.vit + skillAllocated.str + skillAllocated.agi + 1;
      const deficit = {};
      for (const s of ['vit','str','agi']) {
        deficit[s] = norm[s] - (skillAllocated[s] / Math.max(totalAlloc, 1));
      }
      const pick = Object.entries(deficit).sort((a,b) => b[1]-a[1])[0][0];
      allocSkill(pick); 
      skillAllocated[pick]++;
      log('📊', `PERCENT → ${pick.toUpperCase()}  (V:${SKILL_VIT}% S:${SKILL_STR}% A:${SKILL_AGI}%)`);
    }
    return;
  }

  // ── PRIORITY (default) ──
  while (state.xp.free > 0) {
    let allocated = false;
    for (const stat of SKILL_PRIO) {
      if (state.xp.free > 0) { 
        allocSkill(stat); 
        allocated = true;
        break; 
      }
    }
    if (!allocated) break; // safeguard
  }
}

let lastHealTime = 0;
function checkHeal() {
  const hpPct = state.player.hpPct ?? 1;
  const meatCount = state.inv.meat ?? 0;
  // Sistem regen daging membutuhkan 5 meat.
  if (hpPct <= 0.80 && meatCount >= 5 && Date.now() - lastHealTime > 2000) {
    log('🍖', `Auto-healing (mengonsumsi 5 Daging)! HP: ${(hpPct*100).toFixed(0)}% | Sisa Meat: ${meatCount}`);
    send({ t: 'heal' });
    lastHealTime = Date.now();
  } else if (hpPct <= 0.80 && meatCount > 0 && meatCount < 5 && Date.now() - (state._lastNoMeatLog || 0) > 10000) {
    log('⚠️', `HP rendah (${(hpPct*100).toFixed(0)}%), tapi Daging kurang dari 5 (Punya: ${meatCount}). Regen gagal!`);
    state._lastNoMeatLog = Date.now();
  }
}

let lastReviveTime = 0;
function checkRevive() {
  const hpPct = state.player.hpPct ?? 1;
  if (hpPct <= 0 && Date.now() - lastReviveTime > 5000) {
    log('💀', `Player is dead (HP: 0%). Sending revive packet...`);
    send({ t: 'revive' });
    lastReviveTime = Date.now();
    
    // Auto-skip the mob type that killed us!
    if (state.lockMobId && state.world.mobs) {
      const killer = state.world.mobs.find(m => m.id === state.lockMobId);
      if (killer && killer.type) {
        const kType = killer.type.toLowerCase();
        log('🛡️', `Auto-skipping future '${killer.type}' encounters because it killed you!`);
        if (!skipMobs.includes(kType)) {
          skipMobs.push(kType);
        }
      }
    }
    state.lockMobId = null;
  }
}

let lastEquipTime = 0;

function getItemScore(item) {
  if (!item) return -1;
  let score = (item.level || 0) * 1000;
  score += (item.str || 0) * 10;
  score += (item.agi || 0) * 10;
  score += (item.vit || 0) * 10;
  const rarities = { "common": 0, "uncommon": 1, "rare": 2, "epic": 3, "legendary": 4 };
  if (item.rarity) score += (rarities[item.rarity.toLowerCase()] || 0) * 100;
  return score;
}

function checkEquip() {
  const items = state.inventoryItems || [];
  if (items.length === 0) return;

  // Determine what weapon/tool we need for this mode
  const wantSlot = (state.mode === 'gold' || state.mode === 'diamond') ? 'tool' : 'weapon';

  // Group items by slot and find the best one (highest score)
  const bestBySlot = {};
  for (const item of items) {
    if (!item || !item.slot) continue;
    
    // For tool/weapon, we only care about the one matching wantSlot
    if ((item.slot === 'tool' || item.slot === 'weapon') && item.slot !== wantSlot) continue;

    const currentBest = bestBySlot[item.slot];
    if (!currentBest || getItemScore(item) > getItemScore(currentBest)) {
      bestBySlot[item.slot] = item;
    }
  }

  for (const slot in bestBySlot) {
    const bestItem = bestBySlot[slot];
    const equippedId = state.equipment && state.equipment[slot];
    
    const isEquipped = equippedId === bestItem.id;
    if (isEquipped) continue;

    const currentlyEquippedItem = items.find(i => i.id === equippedId);

    const currentScore = getItemScore(currentlyEquippedItem);
    const bestScore = getItemScore(bestItem);

    // Equip if the slot is empty OR the new item has a higher score
    if (slot === wantSlot || bestScore > currentScore) {
      if (Date.now() - lastEquipTime > 3000) {
        send({ t: 'equipItem', id: bestItem.id });
        log('🎒', `Auto-Equip: ${bestItem.name || bestItem.id} (${slot}) [Score: ${bestScore}]`);
        lastEquipTime = Date.now();
        return; // Equip one item per check to avoid spamming
      }
    }
  }
}

function skillPlanStr() {
  if (SKILL_MODE === 'single')  return `SINGLE → ${SKILL_STAT.toUpperCase()}`;
  if (SKILL_MODE === 'percent') return `PERCENT  VIT:${SKILL_VIT}%  STR:${SKILL_STR}%  AGI:${SKILL_AGI}%`;
  return `PRIORITY  ${SKILL_PRIO.join(' > ').toUpperCase()}`;
}

// ─────────────────────────────────────────────
// HELPER GEOMETRY
// ─────────────────────────────────────────────
function dist(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

function distTo(x, y) {
  return dist(state.player.x, state.player.y, x, y);
}

const VIEWPORT_RANGE = 350; // pixels

function isResourceDepleted(type, rx, ry, wx, wy) {
  if (!state.worldReceived) {
    return false; // haven't received world state yet, assume not depleted
  }
  const d = distTo(wx, wy);
  if (d > VIEWPORT_RANGE) {
    return false; // too far to see, assume not depleted
  }
  if (type === 'tree') {
    return !state.world.trees.some(t => t.x === rx && t.y === ry);
  }
  
  const key = `${type}:${rx},${ry}`;
  if (state.failedResources.has(key)) {
    return true;
  }

  if (type === 'gold' || type === 'diamond') {
    // If we have already started attacking this specific node, it must be in the active world list.
    // If it is no longer in the active list, it has been mined/depleted (even by someone else).
    if (state.lockResource && state.lockResource.type === type && state.lockResource.x === rx && state.lockResource.y === ry && state.attacksOnCurrentTarget >= 2) {
      const activeList = type === 'gold' ? state.world.golds : state.world.diamonds;
      const exists = activeList.some(g => g.x === rx && g.y === ry);
      if (!exists) {
        state._missingActiveTicks = (state._missingActiveTicks || 0) + 1;
        if (state._missingActiveTicks >= 30) {
          state._missingActiveTicks = 0;
          return true;
        }
      } else {
        state._missingActiveTicks = 0;
      }
    }
  }
  return false;
}

function getTargetProgress(key, near) {
  if (!key || !near) return 0;
  if (key.startsWith('tree:')) {
    const hit = state.world.treeHits.find(h => h.x === near.x && h.y === near.y);
    return hit ? hit.pct : 0;
  }
  if (key.startsWith('gold:')) {
    const node = state.world.golds.find(g => g.x === near.x && g.y === near.y);
    return node ? node.pct : 0;
  }
  if (key.startsWith('diamond:')) {
    const node = state.world.diamonds.find(d => d.x === near.x && d.y === near.y);
    return node ? node.pct : 0;
  }
  if (key.startsWith('mob:')) {
    const mob = state.world.mobs.find(m => m.id === near.id);
    return mob ? (mob.hpPct ?? 1.0) : 1.0;
  }
  return 0;
}

function checkRealign(key, near) {
  const currentLoot = state.session.wood + state.session.gold + state.session.meat + state.session.kills;
  const progress = getTargetProgress(key, near);

  if (!state.lastProgressTime) {
    state.lastProgressTime = Date.now();
  }

  if (key !== state.currentTargetKey) {
    state.currentTargetKey = key;
    state.attacksOnCurrentTarget = 0;
    state.attacksSinceLastProgress = 0;
    state.lastTargetProgressValue = progress;
    state.lastLootTotal = currentLoot;
    state.lastProgressTime = Date.now();
    return false;
  }

  let progressMade = false;
  if (currentLoot > state.lastLootTotal) {
    progressMade = true;
  } else if (key.startsWith('mob:') || key.startsWith('gold:') || key.startsWith('diamond:')) {
    // HP / Pct goes DOWN as we hit them
    if (progress < state.lastTargetProgressValue) progressMade = true;
  } else {
    // For trees, hit percentage goes UP
    if (progress > state.lastTargetProgressValue) progressMade = true;
  }

  if (progressMade) {
    state.attacksSinceLastProgress = 0;
    state.lastTargetProgressValue = progress;
    state.lastLootTotal = currentLoot;
    state.lastProgressTime = Date.now();
    state.currentTargetStrikes = 0;
    return false;
  }

  let timeoutMs = 5000;
  let minAttacks = 15;
  if (key.startsWith('mob:')) {
    timeoutMs = 10000;
    minAttacks = 20;
  } else if (key.startsWith('gold:') || key.startsWith('diamond:')) {
    timeoutMs = 600000; // 10 minutes for high HP nodes
    minAttacks = 1000;
  }

  // Only declare a miss if we have been trying without any progress
  if (Date.now() - state.lastProgressTime > timeoutMs && state.attacksSinceLastProgress >= minAttacks) {
    state.attacksSinceLastProgress = 0;
    state.attacksOnCurrentTarget = 0;
    state.lastProgressTime = Date.now();
    state.playerPosInitialized = false; // Actually resync position with server
    return true;
  }
  return false;
}

function moveToward(tx, ty, defaultStep = 80, stopDist = 0) {
  const now = Date.now();

  // 1. Detour target override (to bypass fences/obstacles)
  if (state._detourTarget && now < state._detourTarget.expireTime) {
    tx = state._detourTarget.tx;
    ty = state._detourTarget.ty;
  }

  const dx = tx - state.player.x;
  const dy = ty - state.player.y;
  const d  = Math.hypot(dx, dy);

  if (d <= stopDist + 5) {
    // Already at target — clear any pending moving state
    state.movingUntil = 0;
    if (state._detourTarget) {
      state._detourTarget = null;
    }
    return;
  }

  if (FAST_MODE) {
    // Teleport to exactly stopDist away
    state.player.x = Math.round(state.player.x + (dx / d) * (d - stopDist));
    state.player.y = Math.round(state.player.y + (dy / d) * (d - stopDist));
    state.movingUntil = 0; // teleport is instant — no movement delay
    faceTarget(tx);
    sendState();
    return;
  }

  // Human-like speed variation
  const step = defaultStep * (0.8 + Math.random() * 0.4);
  const moveDist = Math.min(step, d - stopDist);
  if (moveDist <= 0) { state.movingUntil = 0; return; }

  // Add some jitter to x and y if far away for human-like movement
  let jitterX = 0;
  let jitterY = 0;
  if (d > stopDist + 50) {
    jitterX = (Math.random() - 0.5) * 15;
    jitterY = (Math.random() - 0.5) * 15;
  }

  const nextX = Math.round(state.player.x + (dx / d) * moveDist + jitterX);
  const nextY = Math.round(state.player.y + (dy / d) * moveDist + jitterY);

  // 2. Stuck detection logic based on server position history
  if (moveDist > 5 && !state._detourTarget && state._serverPosHistory && state._serverPosHistory.length >= 3) {
    const oldest = state._serverPosHistory[0];
    const newest = state._serverPosHistory[state._serverPosHistory.length - 1];
    if (now - oldest.time > 400) {
      const serverMoved = Math.hypot(newest.x - oldest.x, newest.y - oldest.y);
      if (serverMoved < 10) {
        state._stuckTicks = (state._stuckTicks || 0) + 1;
        if (state._stuckTicks >= 2) {
          // Snap client coordinates back to server coordinates once to fix client-drift
          state.player.x = newest.x;
          state.player.y = newest.y;

          // Choose detour angle perpendicular to direct path (+/- 90 degrees)
          const angle = Math.atan2(dy, dx);
          const detourAngle = angle + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
          const detourX = Math.round(state.player.x + Math.cos(detourAngle) * 150);
          const detourY = Math.round(state.player.y + Math.sin(detourAngle) * 150);

          log('🔀', `Stuck detected! Taking detour to (${detourX}, ${detourY}) to bypass obstacle.`);
          
          if (state.lockResource) {
            const key = `${state.lockResource.type}:${state.lockResource.x},${state.lockResource.y}`;
            state._stuckTargetCounts = state._stuckTargetCounts || new Map();
            const attempts = (state._stuckTargetCounts.get(key) || 0) + 1;
            state._stuckTargetCounts.set(key, attempts);
        
            if (attempts >= 5) {
              log('🚫', `Terlalu sering nyangkut (5x detour) saat menuju ${key}. Blacklist area ini 3 menit!`);
              if (!state.cooldownResources) state.cooldownResources = new Map();
              state.cooldownResources.set(key, Date.now() + 180000);
              state.lockResource = null;
              state._detourTarget = null;
              state._stuckTicks = 0;
              return;
            }
          }

          state._detourTarget = { tx: detourX, ty: detourY, expireTime: now + 1200 };
          state._stuckTicks = 0;

          // Override move step to walk toward detour point
          const newDx = detourX - state.player.x;
          const newDy = detourY - state.player.y;
          const newD = Math.hypot(newDx, newDy);
          if (newD > 0) {
            state.player.x      = Math.round(state.player.x + (newDx / newD) * Math.min(step, newD));
            state.player.y      = Math.round(state.player.y + (newDy / newD) * Math.min(step, newD));
            state.player.facing = newDx > 0 ? 1 : -1;
            state.player.bd     = newDx > 0 ? 'right' : 'left';
            state.movingUntil   = now + ST_INTERVAL + 30;
            state._lastMovePos  = { x: state.player.x, y: state.player.y, time: now };
            return;
          }
        }
      } else {
        state._stuckTicks = 0;
      }
    }
  }

  state.player.x      = nextX;
  state.player.y      = nextY;
  state.player.facing = dx > 0 ? 1 : -1;
  state.player.bd     = dx > 0 ? 'right' : 'left';
  state.movingUntil   = now + ST_INTERVAL + 30;
  state._lastMovePos  = { x: state.player.x, y: state.player.y, time: now };
}

function faceTarget(tx) {
  const dx = tx - state.player.x;
  if (dx === 0) return;
  const newFacing = dx > 0 ? 1 : -1;
  const newBd     = dx > 0 ? 'right' : 'left';
  if (state.player.facing !== newFacing) {
    state.player.facing = newFacing;
    state.player.bd     = newBd;
  }
}

function wander(radius = 200) {
  const a        = Math.random() * Math.PI * 2;
  state.player.x = Math.round(state.player.x + Math.cos(a) * radius);
  state.player.y = Math.round(state.player.y + Math.sin(a) * radius);
  sendState();
  // Don't block isMoving — just reposition so next attack tick fires normally
}

function toWorldCenter(v) {
  return v > 1000 ? v : v * TILE + 32;
}

const chunks = {
  loaded: new Set(),
  trees: [],
  golds: [],
  diamonds: [],
  landTiles: new Set(),
};

const chunkFailTimes = {};

async function loadChunk(cx, cy) {
  const key = `${cx},${cy}`;
  if (chunks.loaded.has(key)) return;

  const lastFail = chunkFailTimes[key] || 0;
  if (Date.now() - lastFail < 15000) return;

  chunks.loaded.add(key);

  const url = `${BASE_URL}/api/world/chunk?cx=${cx}&cy=${cy}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 seconds fetch timeout
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.t) {
      let treeCount = 0;
      let goldCount = 0;
      let dmdCount = 0;
      for (const t of data.t) {
        const x = t[0];
        const y = t[1];
        const tileData = t[2] || {};
        
        // Every tile explicitly defined in chunk data is considered land/solid
        chunks.landTiles.add(`${x},${y}`);
        
        const objects = tileData.o || {};
        for (const [tier, obj] of Object.entries(objects)) {
          if (obj) {
            const cleanObj = obj.split('|')[0];
            if (cleanObj.startsWith('tree:')) {
              chunks.trees.push({ x, y, wx: x * 64 + 32, wy: y * 64 + 32 });
              treeCount++;
            } else if (cleanObj.startsWith('gold')) {
              chunks.golds.push({ x, y, wx: x * 64 + 32, wy: y * 64 + 32 });
              goldCount++;
            } else if (cleanObj.startsWith('diamond')) {
              chunks.diamonds.push({ x, y, wx: x * 64 + 32, wy: y * 64 + 32 });
              dmdCount++;
            }
          }
        }
      }
      log('🌍', `Loaded map chunk (${cx}, ${cy}) — Found ${treeCount} trees, ${goldCount} gold, ${dmdCount} diamonds`);
    }
  } catch (err) {
    log('⚠️', `Failed to load map chunk (${cx}, ${cy}): ${err.message}`);
    chunks.loaded.delete(key);
    chunkFailTimes[key] = Date.now();
  }
}

async function ensureNearbyChunks() {
  const cx = Math.max(0, Math.min(9, Math.floor(state.player.x / 3200)));
  const cy = Math.max(0, Math.min(9, Math.floor(state.player.y / 3200)));
  
  const promises = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ccx = cx + dx;
      const ccy = cy + dy;
      if (ccx >= 0 && ccx <= 9 && ccy >= 0 && ccy <= 9) {
        promises.push(loadChunk(ccx, ccy));
      }
    }
  }
  await Promise.all(promises);
}

// ─────────────────────────────────────────────
// FARMING MODES
// ─────────────────────────────────────────────
function isResourceSafe(wx, wy, safetyRadius = 350) {
  if (!state.world.mobs) return true;
  for (const m of state.world.mobs) {
    if (m.state === 'dead') continue;
    if (!m.type) continue;
    const mType = m.type.toLowerCase();
    
    // Only avoid dangerous giants: Minotaur and Bear
    if (!mType.includes('minotaur') && !mType.includes('bear')) {
      continue;
    }
    
    if (dist(wx, wy, m.x, m.y) < safetyRadius) {
      return false;
    }
  }
  return true;
}

function isHumanPlayer(p) {
  if (state.player.id && p.id && p.id.toString() === state.player.id.toString()) return false;
  if (p.name && BOT_NAME && p.name.toLowerCase() === BOT_NAME.toLowerCase()) return false;
  const nameLower = (p.name || '').toLowerCase();
  if (
    nameLower.includes('guardian') || 
    nameLower.includes('guard') || 
    nameLower.includes('prajurit') || 
    nameLower.includes('soldier') || 
    nameLower.includes('royal') || 
    nameLower.includes('knight') || 
    nameLower.includes('warden') || 
    nameLower.includes('npc') || 
    nameLower.includes('guide') || 
    nameLower.includes('monk') || 
    nameLower.includes('merchant') || 
    nameLower.includes('banker')
  ) {
    return false;
  }
  return true;
}

// Returns true if any OTHER real player (not self, not NPCs) is within checkRange pixels of the given node.
// Bot separation is handled automatically via nameHash dispersion in findBestResource —
// no whitelist of friendly names needed.
function isAnotherPlayerMining(gx, gy, checkRange = 90) {
  const wx = gx * 64 + 32;
  const wy = gy * 64 + 32;
  if (!state.world.players || state.world.players.length === 0) return false;
  return state.world.players.some(p => {
    if (!isHumanPlayer(p)) return false;
    const d = Math.hypot(p.x - wx, p.y - wy);
    return d < checkRange;
  });
}


function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

function findBestResource(type) {
  const now = Date.now();
  const nameHash = hashCode(WALLET + (BOT_NAME || ''));

  // Check if we are overlapping with another player/bot (within 100px)
  const isNempel = state.world.players.some(p => p.id !== state.player.id && Math.hypot(p.x - state.player.x, p.y - state.player.y) < 100);
  const maxJitter = isNempel ? 500 : 50;

  if (type === 'tree') {
    const candidateList = chunks.trees.filter(item => {
      const key = `tree:${item.x},${item.y}`;
      if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) {
        return false;
      }
      if (!isResourceSafe(item.wx, item.wy)) return false;
      return !state.world.trees.some(t => t.x === item.x && t.y === item.y);
    });

    if (candidateList.length > 0) {
      let best = null;
      let bestScore = Infinity;
      for (const item of candidateList) {
        const d = distTo(item.wx, item.wy);
        const nodeHash = hashCode(`tree:${item.x},${item.y}`);
        const preferenceJitter = ((nameHash ^ nodeHash) % 10) * (maxJitter / 10);
        const score = d + preferenceJitter;
        if (score < bestScore) {
          bestScore = score;
          best = { x: item.x, y: item.y, wx: item.wx, wy: item.wy, type };
        }
      }
      return best;
    }
    return null;
  }

  if (type === 'gold' || type === 'diamond') {
    const list = type === 'gold' ? chunks.golds : chunks.diamonds;
    const activeList = type === 'gold' ? state.world.golds : state.world.diamonds;

    const candidates = list.filter(item => {
      const key = `${type}:${item.x},${item.y}`;
      if (state.failedResources.has(key) && now - state.failedResources.get(key) < 60000) {
        return false;
      }

      // Avoid targeting nodes close to the last disturbed location (within 300px)
      if (type === 'gold' && state._lastDisturbedPos && now - state._lastDisturbedPos.time < 180000) {
        const distToDisturbed = Math.hypot(item.wx - state._lastDisturbedPos.x, item.wy - state._lastDisturbedPos.y);
        if (distToDisturbed < 300) {
          return false;
        }
      }

      // Check if node is active in the server's active list
      const activeNode = activeList.find(g => g.x === item.x && g.y === item.y);
      const isCurrentlyActive = activeNode && (activeNode.pct === undefined || activeNode.pct > 0);

      // Only check cooldownResources if it's not currently active on the server
      if (!isCurrentlyActive && state.cooldownResources && state.cooldownResources.has(key) && now < state.cooldownResources.get(key)) {
        return false;
      }
      
      // Avoid targeting nodes within 200px of another player to keep bots separated
      // Viewport check (conservative 250px): if node is close, it must be active on the server (explicit pct === 0 means cooldown)
      const d = distTo(item.wx, item.wy);

      // Avoid targeting nodes within 75px of another player to keep bots separated (prevents island-jumping)
      // EXCEPT if the node is very close to us (we are already standing next to it)
      const isVeryClose = d < 120;
      if (!isVeryClose && isAnotherPlayerMining(item.x, item.y, 75)) {
        return false;
      }
      if (!isResourceSafe(item.wx, item.wy, 120)) {
        return false;
      }
      // Viewport check (320px): if a node is within view range, it MUST be active on the server.
      // If it's missing or has pct === 0, it's on cooldown. Blacklist it for 5 minutes.
      if (d <= 320) {
        const isExistsAndActive = activeNode && (activeNode.pct === undefined || activeNode.pct > 0);
        if (!isExistsAndActive) {
          if (!state.cooldownResources) state.cooldownResources = new Map();
          state.cooldownResources.set(key, now + 60000); // 1 minute cooldown
          return false;
        }
      }

      return true;
    });

    if (candidates.length === 0) return null;

    // Search the entire map without local boundary constraints so bots can travel to any side (west, east, north, south)
    const finalCandidates = candidates;

    let best = null;
    let bestScore = Infinity;
    for (const item of finalCandidates) {
      const d = distTo(item.wx, item.wy);
      const distToSpawn = Math.hypot(item.wx - 16000, item.wy - 16000);
      const spawnPenalty = distToSpawn < 600 ? 1000 : 0;

      // Heavy penalty for very far nodes to strongly prefer nearby gold first
      // Within 400px: no distance penalty (mine sequentially)
      // 400-1200px: moderate penalty
      // Beyond 1200px: heavy penalty (cross-map travel only when local is depleted)
      let distancePenalty = 0;
      if (d > 1200) distancePenalty = (d - 1200) * 2.5; // Very heavy for cross-map
      else if (d > 400) distancePenalty = (d - 400) * 0.8;

      // Dispersion penalty to distribute bots to different gold nodes
      // If the node is close (within 400px), do NOT apply dispersion so we mine it sequentially (closest first)
      const nodeHash = hashCode(`${type}:${item.x},${item.y}`);
      const botIdentity = state.player.id ? state.player.id.toString() : (WALLET + (BOT_NAME || ''));
      const uniqueHash = hashCode(botIdentity);
      const localDispersion = d <= 400 ? 0 : ((uniqueHash ^ nodeHash) % 6) * 300; // 0 to 1800px penalty

      let farDispersion = 0;
      if (d > 1200) {
        const sectorX = Math.floor(item.x / 15);
        const sectorY = Math.floor(item.y / 15);
        const sectorHash = hashCode(`sector:${sectorX},${sectorY}`);
        const botIdentity = state.player.id ? state.player.id.toString() : (WALLET + (BOT_NAME || ''));
        const uniqueHash = hashCode(botIdentity);
        const sectorPreference = (uniqueHash ^ sectorHash) % 5;
        farDispersion = sectorPreference * 3000;
      }

      const score = d + spawnPenalty + distancePenalty + localDispersion + farDispersion;

      if (score < bestScore) {
        bestScore = score;
        best = { x: item.x, y: item.y, wx: item.wx, wy: item.wy, type };
      }
    }
    return best;
  }

  return null;
}

function doTree() {
  // Ensure chunks loaded before searching
  if (chunks.trees.length === 0 && !state._chunksLoading) {
    state._chunksLoading = true;
    ensureNearbyChunks().then(() => { state._chunksLoading = false; });
    return;
  }
  
  // DON'T check isResourceDepleted for trees - server sends trees:[] in world packets
  // Trees only come from chunk API, so world.trees is always empty.
  // Instead, rely on checkRealign() which detects if attacks aren't registering

  // Disabled running away from monsters: bot will defend itself if attacked instead.

  if (!state.lockResource || state.lockResource.type !== 'tree') {
    state.lockResource = findBestResource('tree');
    if (!state.lockResource) {
      if (MODES.monster) {
        doMonster(false);
      } else {
        if (Math.random() < 0.3) wander(200);
      }
      return;
    }
  }

  const near = state.lockResource;
  const d = distTo(near.wx, near.wy);
  const key = `tree:${near.x},${near.y}`;
  const realign = checkRealign(key, near);

  const hit = state.world.treeHits.find(h => h.x === near.x && h.y === near.y);
  const hpPct = hit ? 1 - hit.pct : 1;
  state.currentTarget = { type: 'Tree', hpPct, wx: near.wx, wy: near.wy, _near: near };

  if (!state._walkStartTime) state._walkStartTime = Date.now();
  if (Date.now() - state._walkStartTime > 10000 && d > 45) {
    log('⚠️', `Cannot reach ${key} setelah 10 detik (nyangkut pagar?). Blacklisting.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    state._walkStartTime = 0;
    return;
  }

  if (realign) {
    log('⚠️', `Attacks on ${key} not registering. Blacklisting and releasing lock.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    state._walkStartTime = 0;
    return;
  } else if (d > 45) {
    moveToward(near.wx, near.wy, 70, 35);
  } else {
    state._walkStartTime = 0;
    state.movingUntil = 0;
    faceTarget(near.wx);
    sendAttack(near.wx, near.wy);
  }
}

function getBestFarmingOffset(rx, ry) {
  // Search up to 2 tiles away in all 4 directions for land to stand on
  const offsets = [
    { tx: rx - 1, ty: ry,     dx: -69, dy: 7  },  // Left
    { tx: rx + 1, ty: ry,     dx: 69,  dy: 7  },  // Right
    { tx: rx,     ty: ry - 1, dx: 0,   dy: -69 }, // Top
    { tx: rx,     ty: ry + 1, dx: 0,   dy: 69  }, // Bottom
    { tx: rx - 1, ty: ry - 1, dx: -69, dy: -37 }, // Top-Left diagonal
    { tx: rx + 1, ty: ry - 1, dx: 69,  dy: -37 }, // Top-Right diagonal
    { tx: rx - 1, ty: ry + 1, dx: -69, dy: 37  }, // Bottom-Left diagonal
    { tx: rx + 1, ty: ry + 1, dx: 69,  dy: 37  }, // Bottom-Right diagonal
    { tx: rx - 2, ty: ry,     dx: -133, dy: 7  }, // Far Left
    { tx: rx + 2, ty: ry,     dx: 133,  dy: 7  }, // Far Right
  ];
  
  if (chunks.landTiles && chunks.landTiles.size > 0) {
    for (const off of offsets) {
      const key = `${off.tx},${off.ty}`;
      if (chunks.landTiles.has(key)) {
        return { dx: off.dx, dy: off.dy };
      }
    }
  }
  
  // Default fallback: stand on the right side
  return { dx: 69, dy: 7 };
}

function doGold() {
  if (state.xp.level < GOLD_LEVEL_REQ) {
    if (!state._goldLvlWarned) {
      log('🔒', `Targeting Gold, but requires Level ${GOLD_LEVEL_REQ}. Auto-farming trees to level up!`);
      state._goldLvlWarned = true;
    }
    doTree();
    return;
  }

  if (state.lockResource && state.lockResource.type === 'gold') {
    const activeNode = state.world.golds.find(g => g.x === state.lockResource.x && g.y === state.lockResource.y);
    const key = `gold:${state.lockResource.x},${state.lockResource.y}`;
    if (activeNode && activeNode.pct !== undefined && activeNode.pct === 0) {
      log('ℹ️', `Gold at [${state.lockResource.x}, ${state.lockResource.y}] is on cooldown. Releasing lock.`);
      if (!state.cooldownResources) state.cooldownResources = new Map();
      state.cooldownResources.set(key, Date.now() + 60000); // 1 minute
      state.lockResource = null;
    } else if (isResourceDepleted('gold', state.lockResource.x, state.lockResource.y, state.lockResource.wx, state.lockResource.wy)) {
      log('ℹ️', `Gold at [${state.lockResource.x}, ${state.lockResource.y}] is depleted. Releasing lock.`);
      if (!state.cooldownResources) state.cooldownResources = new Map();
      state.cooldownResources.set(key, Date.now() + 60000); // 1 minute
      state.lockResource = null;
    } else {
      // Player interference: time-based detection (not tick-counting)
      // A player is only considered "interfering" if they CONTINUOUSLY stay for 5+ seconds
      // Only trigger stealing if player is directly touching/mining the same node (60px instead of 85px)
      const isPlayerStealing = isAnotherPlayerMining(state.lockResource.x, state.lockResource.y, 60);


      if (isPlayerStealing) {
        if (!state._playerNearNodeTime) {
          state._playerNearNodeTime = Date.now(); // Start timer on first detection
        }
      } else {
        state._playerNearNodeTime = 0; // Reset timer when they leave
      }

      // Only count as 1 disturbance event after 5 continuous seconds of interference
      const interferenceMs = state._playerNearNodeTime ? Date.now() - state._playerNearNodeTime : 0;
      if (interferenceMs >= 5000) {
        state._playerNearNodeTime = 0; // Reset timer for next event
        const countKey = `gold:${state.lockResource.x},${state.lockResource.y}`;
        state._nodeDisturbances = state._nodeDisturbances || {};
        state._nodeDisturbances[countKey] = (state._nodeDisturbances[countKey] || 0) + 1;

        if (state.attacksOnCurrentTarget > 0) {
          log('⚠️', `Gangguan #${state._nodeDisturbances[countKey]}/3 terdeteksi di emas [${state.lockResource.x},${state.lockResource.y}]`);
          if (state._nodeDisturbances[countKey] >= 3) {
            log('🚫', `Emas [${state.lockResource.x},${state.lockResource.y}] diganggu 3x. Pindah ke area lain 10 menit.`);
            state._lastDisturbedPos = { x: state.lockResource.wx, y: state.lockResource.wy, time: Date.now() };
            if (!state.cooldownResources) state.cooldownResources = new Map();
            state.cooldownResources.set(countKey, Date.now() + 600000);
            state._nodeDisturbances[countKey] = 0;
            state.lockResource = null;
            wander(500);
          }
          // If < 3 disturbances, keep mining — we have priority
        } else {
          // Haven't started mining yet: yield to the other player immediately
          log('ℹ️', `Pemain lain sedang di emas [${state.lockResource.x},${state.lockResource.y}]. Mencari target lain.`);
          state.lockResource = null;
          wander(250);
        }
      }
    }
  }

  // FORCE LOCK RETENTION: If we already have a lock and have hit it, do NOT look for a new resource
  if (state.lockResource && state.lockResource.type === 'gold' && state.attacksOnCurrentTarget > 0) {
    // Keep target lock
  } else if (!state.lockResource || state.lockResource.type !== 'gold') {
    if (Date.now() - (state._lastGoldSearchTime || 0) < 3000) {
      if (state.modeList.includes('tree')) {
        doTree();
      } else {
        if (Math.random() < 0.2) wander(100);
      }
      return;
    }

    state.lockResource = findBestResource('gold');
    if (!state.lockResource) {
      state._lastGoldSearchTime = Date.now();
      if (state.modeList.includes('tree')) {
        if (Date.now() - (state._lastNoGoldLog || 0) > 10000) {
          log('🔍', 'Tidak ada Gold yang aman/tersedia. Mencari area lain sambil menebang pohon...');
          state._lastNoGoldLog = Date.now();
        }
        doTree();
      } else {
        if (Date.now() - (state._lastNoGoldLog || 0) > 10000) {
          log('🔍', 'Tidak ada Gold yang aman/tersedia. Menunggu 3 detik sebelum mencari lagi...');
          state._lastNoGoldLog = Date.now();
        }
        wander(150);
      }
      return;
    }
  }



  const near = state.lockResource;
  const d = distTo(near.wx, near.wy);
  const key = `gold:${near.x},${near.y}`;
  const realign = checkRealign(key, near);

  const stateNode = state.world.golds.find(sg => sg.x === near.x && sg.y === near.y);
  const nodePct = stateNode ? stateNode.pct : 1.0;

  state.currentTarget = { type: 'Gold Node', hpPct: nodePct, wx: near.wx, wy: near.wy, _near: near };

  // Stand to the RIGHT of the gold node, matching manual player behavior:
  // From log: player at (+69px right, +7px below) node center, facing:-1, bd:"left"
  const offset = getBestFarmingOffset(near.x, near.y);
  const standX = near.wx + offset.dx;
  const standY = near.wy + offset.dy;
  
  // If we are already close enough to attack (<= 80px) and on land, we don't need to adjust further!
  const isCloseEnoughAndOnLand = (d <= 80) && (!state.player.boat);
  const dToStand = isCloseEnoughAndOnLand ? 0 : Math.hypot(standX - state.player.x, standY - state.player.y);

  if (!state._walkStartTime) state._walkStartTime = Date.now();
  // Walk timeout scales with distance: allow ~1.5s per 100px, minimum 10s, max 45s
  const walkTimeoutMs = Math.min(45000, Math.max(10000, Math.round(d * 15)));
  if (Date.now() - state._walkStartTime > walkTimeoutMs && dToStand > 30) {
    log('⚠️', `Cannot reach ${key} after ${Math.round(walkTimeoutMs/1000)}s (dist=${Math.round(d)}px). Blacklisting.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    state._walkStartTime = 0;
    return;
  }

  if (realign) {
    log('⚠️', `Attacks on ${key} not registering. Blacklisting and releasing lock.`);
    if (!state.cooldownResources) state.cooldownResources = new Map();
    state.cooldownResources.set(key, Date.now() + 180000); // 3 minutes cooldown
    state.lockResource = null;
    state._walkStartTime = 0;
    return;
  } else if (dToStand > 30) {
    if (Date.now() - (state._lastTargetLog || 0) > 2000) {
       log('🎯', `WALKING TO: Gold [${near.x},${near.y}] | stand=(${standX},${standY}) | dist=${Math.round(dToStand)}px | pct=${nodePct}`);
       state._lastTargetLog = Date.now();
    }
    moveToward(standX, standY, 70, 0);
  } else {
    state._walkStartTime = 0;
    state.movingUntil = 0;

    // Dynamically face the node based on which side of the node we are standing on (always stay on land)
    const facing = near.wx > state.player.x ? 1 : -1;
    const bd = near.wx > state.player.x ? 'right' : 'left';
    state.player.facing = facing;
    state.player.bd = bd;

    state._lastAttackTime = Date.now();

    // Log pct every 5 attacks
    if (state.attacksOnCurrentTarget % 5 === 0) {
      log('⛏️', `Gold [${near.x},${near.y}] pct=${nodePct} | atk#${state.attacksOnCurrentTarget} | player=(${Math.round(state.player.x)},${Math.round(state.player.y)}) | stand=(${standX},${standY})`);
    }

    // Gold nodes: pct counts down from ~1000 to 0, then gold drops.
    // Limit ditingkatkan jadi 5000 untuk akun baru dengan damage kecil
    if (state.attacksOnCurrentTarget > 5000) {
      log('⚠️', `Node [${near.x},${near.y}] took 5000 hits with no drop. Blacklisting.`);
      state.failedResources.set(key, Date.now());
      state.lockResource = null;
      return;
    }

    sendAttack();
  }
}

function doDiamond() {
  if (state.xp.level < DIAMOND_LEVEL_REQ) {
    log('🔒', `Diamond requires Level ${DIAMOND_LEVEL_REQ}. You are Level ${state.xp.level}. Skipping.`);
    if (state.modeList.length > 1) advanceMode();
    else doTree();
    return;
  }

  if (state.lockResource && state.lockResource.type === 'diamond') {
    const activeNode = state.world.diamonds.find(d => d.x === state.lockResource.x && d.y === state.lockResource.y);
    const key = `diamond:${state.lockResource.x},${state.lockResource.y}`;
    if (activeNode && activeNode.pct !== undefined && activeNode.pct === 0) {
      log('ℹ️', `Diamond at [${state.lockResource.x}, ${state.lockResource.y}] is on cooldown. Releasing lock.`);
      if (!state.cooldownResources) state.cooldownResources = new Map();
      state.cooldownResources.set(key, Date.now() + 300000); // 5 minutes
      state.lockResource = null;
    } else if (isResourceDepleted('diamond', state.lockResource.x, state.lockResource.y, state.lockResource.wx, state.lockResource.wy)) {
      log('ℹ️', `Diamond at [${state.lockResource.x}, ${state.lockResource.y}] is depleted. Releasing lock.`);
      if (!state.cooldownResources) state.cooldownResources = new Map();
      state.cooldownResources.set(key, Date.now() + 300000); // 5 minutes
      state.lockResource = null;
    } else if (isAnotherPlayerMining(state.lockResource.x, state.lockResource.y) && (state.attacksOnCurrentTarget === 0 || distTo(state.lockResource.wx, state.lockResource.wy) > 100)) {
      log('ℹ️', `Another player is mining diamond at [${state.lockResource.x}, ${state.lockResource.y}]. Releasing lock.`);
      state.lockResource = null;
    }
  }

  if (!state.lockResource || state.lockResource.type !== 'diamond') {
    if (Date.now() - (state._lastDiamondSearchTime || 0) < 3000) {
      doMonster(false);
      return;
    }

    state.lockResource = findBestResource('diamond');
    if (!state.lockResource) {
      state._lastDiamondSearchTime = Date.now();
      doMonster(false);
      return;
    }
  }

  const near = state.lockResource;
  const d = distTo(near.wx, near.wy);
  const key = `diamond:${near.x},${near.y}`;
  const realign = checkRealign(key, near);

  const stateNode = state.world.diamonds.find(sd => sd.x === near.x && sd.y === near.y);
  const hpPct = stateNode ? stateNode.pct : 1.0;

  state.currentTarget = { type: '💎 Diamond', hpPct, wx: near.wx, wy: near.wy, _near: near };

  if (!state._walkStartTime) state._walkStartTime = Date.now();
  if (Date.now() - state._walkStartTime > 10000 && d > 45) {
    log('⚠️', `Cannot reach ${key} setelah 10 detik (nyangkut pagar?). Blacklisting.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    state._walkStartTime = 0;
    return;
  }

  if (realign) {
    log('⚠️', `Attacks on ${key} not registering. Blacklisting and releasing lock.`);
    if (!state.cooldownResources) state.cooldownResources = new Map();
    state.cooldownResources.set(key, Date.now() + 180000); // 3 minutes cooldown
    state.lockResource = null;
    state._walkStartTime = 0;
    return;
  } else if (d > 45) {
    moveToward(near.wx, near.wy, 60, 35);
  } else {
    state._walkStartTime = 0;
    state.movingUntil = 0;
    state.player.facing = near.wx > state.player.x ? 1 : -1;
    sendAttack(near.wx, near.wy);
  }
}

function doMonster(bossOnly = false) {
  const now = Date.now();
  const alive = state.world.mobs.filter(m => {
    if (!m || !m.id) return false;
    if (m.state === 'dead') return false;
    const key = `mob:${m.id}`;
    if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) return false;
    if (!m.type || skipMobs.includes(m.type.toLowerCase())) return false;
    // Cek apakah HP masih ada (jangan batasi m.hp <= 100 karena server bisa mengirim nilai absolut seperti 500)
    return m.hp > 0 || (m.hpPct !== undefined && m.hpPct > 0);
  });

  // ── RETREAT LOGIC (JAGA JARAK) ──
  // Aktifkan mode regen jika HP kritis (< 45%) agar tidak mati konyol saat farming
  if (state.player.hpPct !== undefined) {
    if (state.player.hpPct < 0.45 && !state.isRegenerating) {
      state.isRegenerating = true;
      log('🏃', `HP Kritis (${Math.round(state.player.hpPct*100)}%)! Masuk ke mode JAGA JARAK untuk regen...`);
    } else if (state.player.hpPct >= 0.85 && state.isRegenerating) {
      state.isRegenerating = false;
      log('💖', `HP sudah pulih (${Math.round(state.player.hpPct*100)}%). Lanjut berburu/farming!`);
    }
  }

  // Jika sedang mode regen, jaga jarak dari monster terdekat!
  if (state.isRegenerating) {
    if (alive.length > 0) {
      const nearestThreat = alive.reduce((b, m) => (distTo(m.x, m.y) < distTo(b.x, b.y) ? m : b), alive[0]);
      if (distTo(nearestThreat.x, nearestThreat.y) < 250) {
        // Terus lari menjauh jika monster terlalu dekat (< 250px)
        const angle = Math.atan2(state.player.y - nearestThreat.y, state.player.x - nearestThreat.x);
        const retreatX = Math.round(state.player.x + Math.cos(angle) * 150);
        const retreatY = Math.round(state.player.y + Math.sin(angle) * 150);
        moveToward(retreatX, retreatY, 90, 0);
      } else {
        // Jarak sudah aman, diam saja menunggu HP penuh
        state.movingUntil = 0; 
      }
    } else {
      state.movingUntil = 0;
    }
    state.lockMobId = null;
    state.currentTarget = null;
    return; // Berhenti di sini, JANGAN lanjut mencari musuh
  }

  let pool  = bossOnly
    ? alive.filter(m => m.boss === true && m.hpPct >= (cfg.settings?.bossMinHpPct ?? 1.0))
    : alive.filter(m => !m.boss && m.hpPct > 0);

  if (bossOnly && pool.length === 0) {
    const farBosses = state.world.farMobs.filter(m => m.type && m.type.startsWith('boss'));
    if (farBosses.length > 0) {
      const near = farBosses.reduce((b, m) => distTo(m.x, m.y) < distTo(b.x, b.y) ? m : b, farBosses[0]);
      log('👑', `Far boss detected: ${near.type} at dist ${distTo(near.x, near.y).toFixed(0)}`);
      moveToward(near.x, near.y, 80, 100);
      return;
    }
    // No bosses anywhere -> fall back to regular monsters!
    log('👑', 'No bosses found anywhere. Falling back to regular monsters...');
    pool = alive.filter(m => !m.boss && m.hpPct > 0);
  }

  // Jika bot sedang rotasi di mode monster tapi tidak ada monster dekat (<500px), 
  // dan kita juga fokus tree, mending tebang pohon agar maksimal farming level!
  if (!bossOnly && state.mode === 'monster' && state.modeList.includes('tree') && !state.lockMobId) {
    const nearbyMonsters = pool.filter(m => distTo(m.x, m.y) < 500);
    if (nearbyMonsters.length === 0) {
      doTree(); // Alihkan langsung ke nebang pohon daripada mondar-mandir jauh
      return;
    }
  }

  if (state.lockMobId) {
    const cur = pool.find(m => m.id === state.lockMobId);
    if (cur) {
      const key = `mob:${cur.id}`;
      const realign = checkRealign(key, cur);
      state.currentTarget = { type: cur.type, hpPct: cur.hpPct ?? 1.0, wx: cur.x, wy: cur.y };
      if (realign) {
        state.currentTargetStrikes = (state.currentTargetStrikes || 0) + 1;
        if (state.currentTargetStrikes >= 3) {
          log('⚠️', `Attacks on ${key} failed 3 times. Blacklisting and releasing lock.`);
          state.failedResources.set(`mob:${cur.id}`, Date.now());
          state.lockMobId = null;
          state.currentTarget = null;
          state.currentTargetStrikes = 0;
        } else {
          log('⚠️', `Attacks on ${key} not registering. Resyncing position (Strike ${state.currentTargetStrikes}/3)...`);
        }
        return;
      }
      const d = distTo(cur.x, cur.y);
      if (d > 20) {
        moveToward(cur.x, cur.y, 80, 10);
        // Fix: Allow the bot to swing its weapon while chasing if reasonably close!
        if (d <= 60) {
          faceTarget(cur.x);
          sendAttack(cur.x, cur.y);
        }
      } else {
        state.movingUntil = 0;
        faceTarget(cur.x);
        sendAttack();
      }
      return;
    }
    const worldMob = (state.world.mobs || []).find(m => m.id === state.lockMobId);
    if (worldMob) {
      log('❓', `Dropped target! It is in world.mobs but not in pool! HP: ${worldMob.hpPct}`);
    } else {
      log('❓', `Dropped target! It completely vanished from state.world.mobs!`);
    }
    state.lockMobId = null;
    state.currentTarget = null;
  }

  if (pool.length > 0) {
    const near = pool.reduce((b, m) => distTo(m.x, m.y) < distTo(b.x, b.y) ? m : b, pool[0]);
    state.lockMobId = near.id;
    const key = `mob:${near.id}`;
    const realign = checkRealign(key, near);
    state.currentTarget = { type: near.type, hpPct: near.hpPct ?? 1.0, wx: near.x, wy: near.y };
    log(bossOnly ? '👑' : '⚔️', `Locked: ${near.type}  HP:${((near.hpPct ?? 1.0)*100).toFixed(0)}%  dist:${distTo(near.x, near.y).toFixed(0)}`);
    if (realign) {
      state.currentTargetStrikes = (state.currentTargetStrikes || 0) + 1;
      if (state.currentTargetStrikes >= 3) {
        log('⚠️', `Attacks on ${key} failed 3 times. Blacklisting and releasing lock.`);
        state.failedResources.set(`mob:${near.id}`, Date.now());
        state.lockMobId = null;
        state.currentTarget = null;
        state.currentTargetStrikes = 0;
      } else {
        log('⚠️', `Attacks on ${key} not registering. Resyncing position (Strike ${state.currentTargetStrikes}/3)...`);
      }
      return;
    } else if (distTo(near.x, near.y) > 20) {
      moveToward(near.x, near.y, 80, 10);
    } else {
      state.movingUntil = 0;
      faceTarget(near.x);
      sendAttack();
    }
  } else {
    state.currentTarget = null;
    // Maksimalin penjelajahan map: jika tidak ada monster, roam ke chunk acak (0-9)
    if (!state._roamTarget || distTo(state._roamTarget.x, state._roamTarget.y) < 100) {
       const cx = Math.floor(Math.random() * 10);
       const cy = Math.floor(Math.random() * 10);
       state._roamTarget = { x: cx * 3200 + 1600, y: cy * 3200 + 1600 };
       log('🗺️', `Area sepi. Menjelajah map ke area [${cx}, ${cy}] untuk mencari monster...`);
    }
    moveToward(state._roamTarget.x, state._roamTarget.y, 80, 0);
  }
}

function doLeveling() {
  const now = Date.now();
  // Find active monsters that are not friendly NPCs
  const aliveMobs = state.world.mobs.filter(m => {
    if (!m || !m.id || m.state === 'dead' || m.hp <= 0) return false;
    if (!m.type) return false;
    const key = `mob:${m.id}`;
    if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) return false;
    if (skipMobs.includes(m.type.toLowerCase())) return false;
    
    const mType = m.type.toLowerCase();
    const isFriendly = mType.includes('monk') || mType.includes('guide') || mType.includes('merchant') || mType.includes('banker') || mType.includes('npc') || mType.includes('guardian') || mType.includes('prajurit') || mType.includes('soldier') || mType.includes('royal') || mType.includes('knight') || mType.includes('warden') || mType.includes('guard');
    return !isFriendly;
  });

  if (aliveMobs.length > 0) {
    // If we were chopping a tree, release the tree lock immediately
    if (state.lockResource && state.lockResource.type === 'tree') {
      state.lockResource = null;
    }
    doMonster(false);
  } else {
    // If no monsters are nearby, clear the monster lock and chop trees
    state.lockMobId = null;
    doTree();
  }
}

const MODE_TIMEOUT_MS = 60000;
let modeEnteredAt = Date.now();

function advanceMode() {
  if (state.modeList.length <= 1) return;
  state.modeIdx = (state.modeIdx + 1) % state.modeList.length;
  state.mode = state.modeList[state.modeIdx];
  state.lockResource = null;
  state.lockMobId = null;
  state.currentTarget = null;
  modeEnteredAt = Date.now();
  log('🔄', `Berpindah Mode → ${state.mode.toUpperCase()}`);
}

// ─────────────────────────────────────────────
// ATTACK TICK
// ─────────────────────────────────────────────
function attackTick() {
  if (!state.authed) return;

  // Human Fatigue & Rest System
  const playTimeSinceLastBreak = Date.now() - state.lastBreakTime;
  const restThreshold = 3300000 + Math.random() * 600000; // Rest every 55-65 minutes (approx. 1 hour)

  if (!state.isResting && playTimeSinceLastBreak > restThreshold) {
    state.isResting = true;
    state.nextBreakDuration = 50000 + Math.random() * 20000; // 50-70 seconds
    log('☕', `Taking a break for ${Math.round(state.nextBreakDuration / 1000)}s...`);

    // PAUSE: stop attack loop and state sending only — do NOT kill WebSocket or auth state
    clearInterval(state._stateTimer);
    clearTimeout(state._atkTimeout);
    state._stateTimer = null;
    state._atkTimeout = null;
    state.lockResource = null;
    state.lockMobId = null;

    setTimeout(async () => {
      log('▶️', 'Break finished! Resuming mining...');
      state.isResting = false;
      state.lastBreakTime = Date.now();
      // Resume timers directly without reloading chunks
      state._stateTimer = setInterval(sendState, ST_INTERVAL);
      // Small delay to let WebSocket sync before attacking
      await sleep(1000);
      runAttackLoop();
    }, state.nextBreakDuration);
    return;
  }

  // 1. Handle forced relocation (Anti-Camping / Location Rotation)
  if (state.forcedWanderTarget) {
    const d = distTo(state.forcedWanderTarget.x, state.forcedWanderTarget.y);
    const elapsed = Date.now() - state.forcedWanderTarget.startTime;
    if (d <= 50 || elapsed > 15000) {
      log('🌍', `Forced relocation complete (dist=${Math.round(d)}px, elapsed=${Math.round(elapsed/1000)}s). Finding new targets!`);
      state.forcedWanderTarget = null;
      state.movingUntil = 0;
    } else {
      moveToward(state.forcedWanderTarget.x, state.forcedWanderTarget.y, 80, 0);
      return; // Skip normal farming this tick while relocating
    }
  }

  // 2. Check if we have been camping the same area too long (Leveling Mode Only)
  const timeSinceLastPosCheck = Date.now() - state.lastPositionCheckTime;
  if (timeSinceLastPosCheck > 90000 && state.mode === 'leveling') { // Every 1.5 minutes (only in leveling mode)
    const distanceMoved = dist(state.player.x, state.player.y, state.lastPositionCheckCoords.x, state.lastPositionCheckCoords.y);
    
    // If we moved less than 400 pixels in 1.5 minutes, force walk to a new area
    if (distanceMoved < 400 && state.playerPosInitialized) {
      const angle = Math.random() * Math.PI * 2;
      const wanderDist = 600 + Math.random() * 400; // Walk 600-1000px away
      const targetX = Math.round(state.player.x + Math.cos(angle) * wanderDist);
      const targetY = Math.round(state.player.y + Math.sin(angle) * wanderDist);
      
      log('🌍', `Camping detected (moved only ${Math.round(distanceMoved)}px in 1.5m). Relocating to: (${targetX}, ${targetY})...`);
      state.forcedWanderTarget = {
        x: targetX,
        y: targetY,
        startTime: Date.now()
      };
      state.lockResource = null;
      state.lockMobId = null;
      state.lastPositionCheckCoords = { x: targetX, y: targetY };
      state.lastPositionCheckTime = Date.now();
      return; // Start relocating on next tick
    }
    
    // Update check position
    state.lastPositionCheckCoords = { x: state.player.x, y: state.player.y };
    state.lastPositionCheckTime = Date.now();
  }

  // Remove level-locked resources from rotation, or add fallbacks
  if (state.xp.level < GOLD_LEVEL_REQ && state.modeList.includes('gold')) {
    if (state.modeList.length === 1) {
      log('⚠️', `GOLD requires Level ${GOLD_LEVEL_REQ} (current: Lv${state.xp.level}). Adding TREE as fallback.`);
      state.modeList.push('tree');
    }
    state.modeList = state.modeList.filter(m => m !== 'gold');
    log('🔒', `Removed GOLD from rotation (requires Lv${GOLD_LEVEL_REQ})`);
    if (state.mode === 'gold') advanceMode();
  }
  if (state.xp.level < DIAMOND_LEVEL_REQ && state.modeList.includes('diamond')) {
    if (state.modeList.length === 1) {
      log('⚠️', `DIAMOND requires Level ${DIAMOND_LEVEL_REQ} (current: Lv${state.xp.level}). Adding TREE as fallback.`);
      state.modeList.push('tree');
    }
    state.modeList = state.modeList.filter(m => m !== 'diamond');
    log('🔒', `Removed DIAMOND from rotation (requires Lv${DIAMOND_LEVEL_REQ})`);
    if (state.mode === 'diamond') advanceMode();
  }

  // Restore unlocked modes if player leveled up
  if (MODES.gold && state.xp.level >= GOLD_LEVEL_REQ && !state.modeList.includes('gold')) {
    state.modeList.push('gold');
    log('🔓', `Level ${state.xp.level} reached! Added GOLD back to rotation.`);
    if (!MODES.tree && state.modeList.includes('tree')) {
      state.modeList = state.modeList.filter(m => m !== 'tree');
      if (state.mode === 'tree') advanceMode();
    }
  }
  if (MODES.diamond && state.xp.level >= DIAMOND_LEVEL_REQ && !state.modeList.includes('diamond')) {
    state.modeList.push('diamond');
    log('🔓', `Level ${state.xp.level} reached! Added DIAMOND back to rotation.`);
    if (!MODES.tree && state.modeList.includes('tree')) {
      state.modeList = state.modeList.filter(m => m !== 'tree');
      if (state.mode === 'tree') advanceMode();
    }
  }

  checkRevive();
  if (state.player.hpPct <= 0) return;
  checkHeal();
  checkEquip();

  // Auto defense: if any hostile mob is within 100px of us, fight it back instead of running away!
  if (state.world.mobs && state.player.hpPct > 0) {
    const aggroMob = state.world.mobs.find(m => {
      if (!m || !m.id || m.state === 'dead' || m.hp <= 0) return false;
      if (!m.type) return false;
      const mType = m.type.toLowerCase();
      if (
        mType.includes('monk') || 
        mType.includes('guide') || 
        mType.includes('merchant') || 
        mType.includes('banker') || 
        mType.includes('npc') ||
        mType.includes('guardian') ||
        mType.includes('guard') ||
        mType.includes('prajurit') ||
        mType.includes('soldier') ||
        mType.includes('royal') ||
        mType.includes('knight') ||
        mType.includes('warden')
      ) {
        return false;
      }
      const d = distTo(m.x, m.y);
      // Perlebar jarak agresif jika mode monster aktif agar sambil lewat pohon, ia juga hajar monster!
      const defRange = state.modeList.includes('monster') ? 200 : 55;
      return d < defRange; 
    });

    if (aggroMob) {
      if (state.lockMobId !== aggroMob.id) {
        log('🛡️', `Monster terdeteksi di jarak ${distTo(aggroMob.x, aggroMob.y).toFixed(0)}px! Sambil farming, basmi monster dulu...`);
        state.lockMobId = aggroMob.id;
        state.lockResource = null; // Pause mining
        state.currentTargetStrikes = 0;
      }
      doMonster(false);
      return; // Skip normal resource tick to focus on defending
    }
  }

  // Load nearby chunks if needed
  const curCx = Math.max(0, Math.min(9, Math.floor(state.player.x / 3200)));
  const curCur = Math.max(0, Math.min(9, Math.floor(state.player.y / 3200)));
  if (!chunks.loaded.has(`${curCx},${curCur}`)) {
    ensureNearbyChunks();
  }

  // Time-based mode rotation: if stuck in one mode too long, force advance
  if (state.modeList.length > 1 && Date.now() - modeEnteredAt > MODE_TIMEOUT_MS) {
    if (state.lockResource) {
      // Actively mining or traveling to resource -> reset timer to keep working
      modeEnteredAt = Date.now();
    } else {
      log('⏰', `Mode timeout (60s) — rotating from ${state.mode.toUpperCase()}`);
      advanceMode();
    }
  }

  // Handle initial dispersion to different compass directions
  if (state.playerPosInitialized && !state.initialDispersionDone) {
    if (!state.dispersionTarget) {
      const botIdentity = state.player.id ? state.player.id.toString() : (WALLET + (BOT_NAME || ''));
      const uniqueHash = hashCode(botIdentity);
      const angle = (uniqueHash % 8) * (Math.PI / 4);
      const dispersionDistance = 300 + (uniqueHash % 5) * 50;
      state.dispersionTarget = {
        x: Math.round(state.player.x + Math.cos(angle) * dispersionDistance),
        y: Math.round(state.player.y + Math.sin(angle) * dispersionDistance),
        startTime: Date.now()
      };
      log('🚀', `Initial dispersion active! Walking to: (${state.dispersionTarget.x}, ${state.dispersionTarget.y}) | Angle: ${Math.round(angle * 180 / Math.PI)}° | Dist: ${dispersionDistance}px`);
    }

    const d = distTo(state.dispersionTarget.x, state.dispersionTarget.y);
    const elapsed = Date.now() - state.dispersionTarget.startTime;

    if (d <= 20 || elapsed > 8000) {
      log('🚀', `Initial dispersion complete (dist=${Math.round(d)}px, elapsed=${Math.round(elapsed/1000)}s). Starting farming/hunting loop!`);
      state.initialDispersionDone = true;
      state.movingUntil = 0;
    } else {
      moveToward(state.dispersionTarget.x, state.dispersionTarget.y, 80, 0);
      return; // Skip normal farming/hunting this tick
    }
  }

  // Don't farm if we just moved — wait for server to sync position
  if (Date.now() < state.movingUntil) return;
  switch (state.mode) {
    case 'leveling': doLeveling();       break;
    case 'tree':    doTree();           break;
    case 'gold':    doGold();           break;
    case 'diamond': doDiamond();        break;
    case 'monster': doMonster(false);   break;
    case 'boss':    doMonster(true);    break;
    default:        doTree();           break;
  }
}

// ─────────────────────────────────────────────
// INTERVALS
// ─────────────────────────────────────────────
async function preloadAllChunks() {
  log('🌍', 'Pre-loading all map chunks for efficient navigation...');
  for (let cy = 0; cy <= 9; cy++) {
    for (let cx = 0; cx <= 9; cx++) {
      if (!state._running) return;
      await loadChunk(cx, cy);
      await sleep(20);
    }
  }
  log('🌍', `Map fully loaded! Total gold nodes registered: ${chunks.golds.length}`);
}

function runAttackLoop() {
  if (!state._running || !state.authed) return;
  attackTick();
  // Add human-like micro-delays (jitter) to the attack interval
  const jitter = (Math.random() - 0.5) * 60; // +/- 30ms
  const nextInterval = Math.max(200, ATK_INTERVAL + jitter);
  state._atkTimeout = setTimeout(runAttackLoop, nextInterval);
}

async function startIntervals() {
  // Only preload map chunks if they haven't been loaded in memory yet (prevents post-break freezes)
  if (chunks.loaded.size === 0) {
    await preloadAllChunks();
  }
  state._stateTimer = setInterval(sendState,    ST_INTERVAL);
  state._dashTimer  = setInterval(() => renderDashboard(state), 300);
  log('▶️', `Bot running! Focus: ${modeStr()}`);
  runAttackLoop();
}

function stopIntervals() {
  clearInterval(state._stateTimer);
  clearTimeout(state._atkTimeout);
  clearInterval(state._dashTimer);
  clearInterval(state._pingTimer);
  state._stateTimer = state._dashTimer = state._pingTimer = null;
  state._atkTimeout = null;
}

// ─────────────────────────────────────────────
// WS CONNECT
// ─────────────────────────────────────────────
function connect(sessionToken) {
  log('🔌', `Connecting to: ${GAME_WS}`);
  state.ws = new WebSocket(GAME_WS);

  state.ws.on('open', () => {
    state.connected    = true;
    state.reconnects   = 0;
    log('✅', 'WebSocket connected!');

    // Ping keepalive
    state._pingTimer = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) state.ws.ping();
    }, 15000);

    // Hello
    send({
      t:    'hello',
      auth: { walletAddress: WALLET, sessionToken },
      name:  BOT_NAME,
      color: BOT_COLOR,
      fmt: 2
    });
  });

  state.ws.on('message', data => handleMsg(data));
  state.ws.on('pong',    ()   => {});

  state.ws.on('error', err => {
    log('❌', `WS error: ${err.message}`);
  });

  state.ws.on('close', async (code) => {
    log('🔌', `Disconnected (${code})`);
    state.connected = false;
    state.authed    = false;
    stopIntervals();

    if (!state._running) return;

    // If kicked by another session of the same wallet — wait longer before retrying
    const kickReason = state._lastKickReason;
    state._lastKickReason = null;

    if (kickReason === 'another-session') {
      log('⚠️', 'Kicked: another session took over. Waiting 15s before reconnect...');
      await sleep(15000);
    }

    if (state.reconnects >= state.maxReconnects) {
      log('❌', 'Max reconnect attempts reached. Stopping.');
      state._running = false;
      return;
    }

    state.reconnects++;
    // Exponential backoff: 3s, 6s, 12s, 24s... max 60s
    const delay = Math.min(3000 * Math.pow(2, state.reconnects - 1), 60000);
    log('🔄', `Reconnecting (${state.reconnects}/${state.maxReconnects}) in ${(delay/1000).toFixed(0)}s...`);
    await sleep(delay);

    // Retry login up to 3 times (handles rate limit: "Please wait a moment")
    let tok = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        tok = await doLogin();
        break;
      } catch (e) {
        if (e.message.includes('wait') || e.message.includes('TOO_FAST') || e.message.includes('moment')) {
          log('⏳', `Rate limited — waiting 10s (attempt ${attempt}/3)...`);
          await sleep(10000);
        } else {
          log('❌', `Login failed: ${e.message}`);
          break;
        }
      }
    }

    if (tok) {
      connect(tok);
    } else {
      log('❌', 'Could not reconnect after retries.');
    }
  });
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  console.clear();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  🏝️  ISLANDS.GAMES AUTO-BOT v3                   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Wallet   : ${WALLET.slice(0, 16)}...${WALLET.slice(-8)}`);
  console.log(`  Focus    : ${modeStr()}`);
  console.log(`  Modes    : ${state.modeList.join(' → ')}`);
  console.log(`  Skills   : ${skillPlanStr()}`);
  console.log('──────────────────────────────────────────────────');
  if (FAST_MODE) {
    console.log('\x1b[31m⚠️  WARNING: --fast (speedhack) mode is active. This increases the risk of server bans!\x1b[0m');
    console.log('──────────────────────────────────────────────────');
  }
  console.log('');

  // Auto login
  let sessionToken;
  try {
    if (fs.existsSync(SESSION_PATH)) {
      const sessData = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
      if (sessData.sessionToken && sessData.walletAddress === WALLET) {
        console.log('✅ Loaded existing session token (bypassing login fetch)');
        sessionToken = sessData.sessionToken;
      }
    }
    if (!sessionToken) {
      sessionToken = await doLogin();
    }

    if (!BOT_NAME && fs.existsSync(SESSION_PATH)) {
      const sessData = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
      BOT_NAME = sessData.username || 'IslandsBot';
    } else if (!BOT_NAME) {
      BOT_NAME = 'IslandsBot';
    }
  } catch (e) {
    console.error('❌ Login failed:', e.message);
    console.error('   Make sure wallet has 5000+ $ISLAND tokens.');
    process.exit(1);
  }

  state._running = true;

  // Graceful exit
  process.on('SIGINT', () => {
    console.log('\n\n[BOT] Stopping...');
    state._running = false;
    stopIntervals();
    if (state.ws) state.ws.close();

    console.log('\n══════════════ FINAL STATS ══════════════');
    console.log(`  🌲 Wood:    +${state.session.wood}`);
    console.log(`  💰 Gold:    +${state.session.gold}`);
    console.log(`  🥩 Meat:    +${state.session.meat}`);
    console.log(`  💀 Kills:    ${state.session.kills}`);
    console.log(`  ⚔️  Attacks:  ${state.session.attacks}`);
    console.log(`  🎯 Skill-ups: ${state.session.skillUps}`);
    console.log(`  ⏱️  Uptime:   ${formatTime(Date.now() - state.startTime)}`);
    console.log('═════════════════════════════════════════\n');
    process.exit(0);
  });

  connect(sessionToken);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
