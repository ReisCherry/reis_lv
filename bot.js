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
    gold                 Mine gold nodes only (requires Level 25!)
    diamond              Mine diamonds only (requires Level 60!)
    monster              Kill monsters (mob)
    boss                 Kill boss monsters only
    tree+gold            Farm trees AND gold (gold needs Lv25)
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
const skipMobs = ['minotaur', 'bear', 'bearboss', 'minotaurboss'].concat(skipArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

// ── Multi-Bot Coordination ──
const BOT_INDEX = parseInt(arg('--bot-index', '0'));
const BOT_COUNT = parseInt(arg('--bot-count', '1'));


function parseFocus(f) {
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
const GOLD_LEVEL_REQ    = 25;  // Gold mining unlocked at level 25
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
    if (ttype.includes('gold') || ttype.includes('diamond')) {
      hpStr = `HP: [???] (Hidden)`;
    }
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

  // Calculate bd (break direction) based on player position relative to target node.
  // From manual mining: player to the RIGHT of node = bd:"right", facing:-1
  // We compute which cardinal direction is dominant.
  let bd = state.player.bd || 'left'; // Use stored bd if set by doGold/doTree

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
  lastTargetProgressValue: 0,
  lastLootTotal: 0,
  gotLoot:       false,
  failedResources: new Map(),
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
  if (chunks.landTiles && chunks.landTiles.has(`${tx},${ty}`)) {
    state.player.boat = false; // On land, no boat
  } else {
    state.player.boat = true;  // No land tile found, must be on water
  }

  let vcx = Math.round(state.player.x);
  let vcy = Math.round(state.player.y);
  if (state.currentTarget) {
    vcx = Math.round(state.currentTarget.wx || state.player.x);
    vcy = Math.round(state.currentTarget.wy || state.player.y);
  } else if (!isMoving && state.player.vcx !== undefined && state.player.vcy !== undefined) {
    vcx = state.player.vcx;
    vcy = state.player.vcy;
  }
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
// WS MESSAGE HANDLER
// ─────────────────────────────────────────────
function handleCaptchaOrMath(msg) {
  log('🚨', 'CAPTCHA/MATH DETECTED! Stopping bot activity...');
  
  // PAUSE attack loop so we don't send any more actions to server
  clearInterval(state._stateTimer);
  clearTimeout(state._atkTimeout);
  state._stateTimer = null;
  state._atkTimeout = null;
  state.lockResource = null;
  state.lockMobId = null;

  for (let i = 0; i < 5; i++) setTimeout(() => process.stdout.write('\x07'), i * 300);

  log('🚨', `Waiting 25 seconds before safe disconnect...`);
  
  setTimeout(() => {
    log('🚨', `25 seconds passed! Disconnecting cleanly to mimic human logout.`);
    state._running = false; // Disable auto-reconnect
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    log('🛑', `Bot stopped to prevent ban. Please run the script lagi secara manual.`);
    setTimeout(() => process.exit(0), 1000);
  }, 25000);
}

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
        log('⚠️', 'Skipping gold — need Level 25. Advancing mode.');
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
            } else {
              // Bersihkan gold yang berada di viewport jika tidak dikirim oleh server
              state.world.golds = state.world.golds.filter(g => {
                const wx = g.x * 64 + 32;
                const wy = g.y * 64 + 32;
                return distTo(wx, wy) > 300;
              });
            }
            if (msg.diamonds) {
              state.world.diamonds = msg.diamonds.map(d => Array.isArray(d) ? { x: d[0], y: d[1], pct: (d[2] !== undefined && d[2] !== null) ? d[2] / 1000 : 1.0 } : d);
            } else {
              // Bersihkan diamond yang berada di viewport
              state.world.diamonds = state.world.diamonds.filter(d => {
                const wx = d.x * 64 + 32;
                const wy = d.y * 64 + 32;
                return distTo(wx, wy) > 300;
              });
            }
            if (msg.treeHits) state.world.treeHits = msg.treeHits.map(h => Array.isArray(h) ? { x: h[0], y: h[1], pct: h[2] / 1000 } : h);
      if (msg.players) {
        state.world.players = msg.players;
        if (state.player.id) {
          const me = msg.players.find(p => p.id === state.player.id);
          if (me) {
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
    case 'respawn': {
      // Dispatch bots to different starting areas immediately upon spawn/respawn
      const angle = (BOT_INDEX / Math.max(BOT_COUNT, 1)) * Math.PI * 2;
      // Spread them 400px away from the base spawn point in different directions
      const offsetX = Math.round(Math.cos(angle) * 450);
      const offsetY = Math.round(Math.sin(angle) * 450);
      
      state.player.x = msg.x + offsetX;
      state.player.y = msg.y + offsetY;
      state.player.vcx = msg.x + offsetX;
      state.player.vcy = msg.y + offsetY;
      state.player.hpPct = 1; // Reset HP to 100% on spawn/respawn
      state.playerPosInitialized = true;
      log('📍', `Spawned/Respawned! Spread offset applied: (${offsetX}, ${offsetY}). Adjusted position: (${state.player.x}, ${state.player.y})`);
      ensureNearbyChunks(); // trigger pre-loading chunks
      break;
    }

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
      if (!state.gotLoot) {
        state.gotLoot = true;
        // Immediately release lock so next tick finds a fresh target
        state.lockResource = null;
        state.lockMobId = null;
        if (state.modeList.length > 1) advanceMode();
      }
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
  if (hpPct <= 0.80 && meatCount > 0 && Date.now() - lastHealTime > 2000) {
    log('🍖', `Auto-healing! HP: ${(hpPct*100).toFixed(0)}%  Meat: ${meatCount}`);
    // Correct packet from game JS: { t: 'heal' }
    send({ t: 'heal' });
    lastHealTime = Date.now();
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

function isMobCrowded(mob, allMobs, distanceThreshold = 120) {
  let nearbyCount = 0;
  for (const other of allMobs) {
    if (other.id === mob.id) continue;
    if (other.type && (other.type.toLowerCase().includes('monk') || other.type.toLowerCase().includes('guide') || other.type.toLowerCase().includes('merchant') || other.type.toLowerCase().includes('banker') || other.type.toLowerCase().includes('npc'))) {
      continue;
    }
    if (dist(mob.x, mob.y, other.x, other.y) < distanceThreshold) {
      nearbyCount++;
    }
  }
  return nearbyCount >= 1;
}

function getNearbyEligibleMob(maxDist = 350) {
  const now = Date.now();
  const alive = state.world.mobs.filter(m => {
    if (!m || !m.id) return false;
    if (m.state === 'dead') return false;
    const key = `mob:${m.id}`;
    if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) return false;
    if (!m.type || skipMobs.includes(m.type.toLowerCase())) return false;
    return m.hp > 0 && m.hp <= 100;
  });

  const eligible = alive.filter(m => {
    if (state.lockMobId === m.id) return true;
    if (isMobCrowded(m, alive)) return false;
    
    // Multi-bot logic: Avoid mobs that are already being engaged by other players (assuming other bots have names similar to BOT_NAME or players are close to it)
    if (state.world.players && state.world.players.length > 0) {
      const isFought = state.world.players.some(p => {
        if (p.id === state.player.id) return false;
        // If another player is very close to this mob (< 60px), they are likely fighting it
        return dist(p.x, p.y, m.x, m.y) < 60;
      });
      if (isFought) return false;
    }
    
    return distTo(m.x, m.y) <= maxDist;
  });

  if (eligible.length === 0) return null;
  return eligible.reduce((b, m) => distTo(m.x, m.y) < distTo(b.x, b.y) ? m : b, eligible[0]);
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
  if (type === 'gold') {
    return !state.world.golds.some(g => g.x === rx && g.y === ry && (g.pct === undefined || Number.isNaN(g.pct) || g.pct > 0));
  }
  if (type === 'diamond') {
    return !state.world.diamonds.some(d => d.x === rx && d.y === ry && (d.pct === undefined || Number.isNaN(d.pct) || d.pct > 0));
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
    state.lastTargetProgressValue = progress;
    state.lastLootTotal = currentLoot;
    state.lastProgressTime = Date.now();
    return false;
  }

  let progressMade = false;
  if (currentLoot > state.lastLootTotal) {
    progressMade = true;
  } else if (key.startsWith('mob:')) {
    if (progress < state.lastTargetProgressValue) progressMade = true;
  } else {
    if (progress > state.lastTargetProgressValue) progressMade = true;
  }

  if (progressMade) {
    state.attacksOnCurrentTarget = 0;
    state.lastTargetProgressValue = progress;
    state.lastLootTotal = currentLoot;
    state.lastProgressTime = Date.now();
    state.currentTargetStrikes = 0;
    return false;
  }

  let timeoutMs = 3500;
  let minAttacks = 10;
  if (key.startsWith('mob:')) {
    timeoutMs = 10000;
    minAttacks = 20;
  } else if (key.startsWith('gold:') || key.startsWith('diamond:')) {
    timeoutMs = 600000; // 10 minutes for high HP nodes
    minAttacks = 1000;
  }

  // Only declare a miss if we have been trying without any progress
  if (Date.now() - state.lastProgressTime > timeoutMs && state.attacksOnCurrentTarget >= minAttacks) {
    log('⚠️', `Attacks on ${key} not registering (no progress in ${timeoutMs/1000}s). Re-aligning...`);
    state.attacksOnCurrentTarget = 0;
    state.lastProgressTime = Date.now();
    state.playerPosInitialized = false; // Actually resync position with server
    return true;
  }
  return false;
}

function moveToward(tx, ty, defaultStep = 80, stopDist = 0) {
  // If moving toward a resource or target, and another player is already standing very close to it, abort!
  if (state.world.players && state.world.players.length > 0) {
    const tooCloseToTarget = state.world.players.some(p => {
      if (p.id === state.player.id) return false;
      return dist(p.x, p.y, tx, ty) < 120;
    });
    if (tooCloseToTarget) {
      // Release target lock to search for another
      state.lockResource = null;
      state.lockMobId = null;
      state.currentTarget = null;
      state.movingUntil = 0;
      return;
    }
  }

  const dx = tx - state.player.x;
  const dy = ty - state.player.y;
  const d  = Math.hypot(dx, dy);

  if (d <= stopDist + 5) {
    // Already at target — clear any pending moving state
    state.movingUntil = 0;
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
  const step = defaultStep * (0.85 + Math.random() * 0.3);
  const moveDist = Math.min(step, d - stopDist);
  if (moveDist <= 0) { state.movingUntil = 0; return; }

  // Human-like organic movement: introduce slight perpendicular noise to create natural curved walks rather than a straight line
  let perpX = -dy / (d || 1);
  let perpY = dx / (d || 1);
  // Curve frequency increases when further away, fades out near target
  const curveScale = d > 100 ? Math.sin(Date.now() / 400) * 8 : 0;

  // Add some random jitter
  const jitterX = (Math.random() - 0.5) * 6;
  const jitterY = (Math.random() - 0.5) * 6;

  state.player.x      = Math.round(state.player.x + (dx / d) * moveDist + perpX * curveScale + jitterX);
  state.player.y      = Math.round(state.player.y + (dy / d) * moveDist + perpY * curveScale + jitterY);
  state.player.facing = dx > 0 ? 1 : -1;
  state.player.bd     = dx > 0 ? 'right' : 'left';
  // Block next attack tick until after state syncs to server (one step = ~100ms)
  state.movingUntil = Date.now() + ST_INTERVAL + 40;
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
  // Add a bot-specific offset angle to disperse bots when wandering
  const angleOffset = (BOT_INDEX / Math.max(BOT_COUNT, 1)) * Math.PI * 2;
  const a        = Math.random() * Math.PI * 2 + angleOffset;
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
    const res = await fetch(url);
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
    // Abaikan NPC bersahabat
    if (mType.includes('monk') || mType.includes('guide') || mType.includes('merchant') || mType.includes('banker') || mType.includes('npc')) {
      continue;
    }
    if (dist(wx, wy, m.x, m.y) < safetyRadius) {
      return false;
    }
  }
  return true;
}

function isAnotherPlayerMining(gx, gy) {
  const wx = gx * 64 + 32;
  const wy = gy * 64 + 32;
  if (!state.world.players || state.world.players.length === 0) return false;
  return state.world.players.some(p => {
    if (p.id === state.player.id) return false;
    const d = Math.hypot(p.x - wx, p.y - wy);
    return d < 80; // if player is within 80px of gold, assume they are mining it (prevents blocking adjacent nodes)
  });
}

function findBestResource(type) {
  const now = Date.now();
  if (type === 'tree') {
    const candidateList = chunks.trees.filter(item => {
      const key = `tree:${item.x},${item.y}`;
      if (state.failedResources.has(key) && now - state.failedResources.get(key) < 60000) {
        return false;
      }
      if (!isResourceSafe(item.wx, item.wy)) return false;
      
      // Exclude tree if another player is closer than 180px to it
      if (state.world.players && state.world.players.length > 0) {
        const tooClose = state.world.players.some(p => {
          if (p.id === state.player.id) return false;
          return dist(p.x, p.y, item.wx, item.wy) < 180;
        });
        if (tooClose) return false;
      }
      
      return !state.world.trees.some(t => t.x === item.x && t.y === item.y);
    });

    if (candidateList.length > 0) {
      let best = null;
      let bestScore = -Infinity; // We want to maximize density / minimize distance
      
      // Calculate coordinates offset for this specific bot index to spread bots out
      // e.g. angle offset per bot
      const angle = (BOT_INDEX / Math.max(BOT_COUNT, 1)) * Math.PI * 2;
      const prefOffsetX = Math.cos(angle) * 250;
      const prefOffsetY = Math.sin(angle) * 250;
      
      for (const item of candidateList) {
        // Calculate density: how many other active/healthy trees are within 150px of this tree
        let density = 0;
        for (const other of candidateList) {
          if (other.x === item.x && other.y === item.y) continue;
          if (dist(item.wx, item.wy, other.wx, other.wy) < 150) {
            density++;
          }
        }
        
        // Distance with preferred offset check to make bots go to different quadrants/clusters
        const d = dist(state.player.x + prefOffsetX, state.player.y + prefOffsetY, item.wx, item.wy);
        const actualDistToPlayer = distTo(item.wx, item.wy);
        
        // Score calculation:
        // 1. Give high preference to trees that are actually close to the player's current position (actualDistToPlayer)
        // 2. Add density bonus to keep them in clusters.
        // 3. We use: density * 80 - actualDistToPlayer * 2 - d
        // This ensures the bot will clear trees right next to it before walking away to another cluster.
        const score = (density * 80) - (actualDistToPlayer * 2.5) - d;
        if (score > bestScore) {
          bestScore = score;
          best = { x: item.x, y: item.y, wx: item.wx, wy: item.wy, type };
        }
      }
      return best;
    }
    return null;
  }

  // 1. Check server's active list first (gold, diamond)
  let activeList = [];
  if (type === 'gold') {
    // pct=0 means untouched fresh node, pct>0 means already being mined (closer to dropping).
    // Prefer nodes with pct>0 (actively being mined = about to drop).
    // Also accept pct=0 nodes (fresh - need to mine from scratch).
    const allGolds = (state.world.golds || []).filter(g => {
      const key = `gold:${g.x},${g.y}`;
      if (g.pct !== undefined && g.pct === 0) return false; // Abaikan yang cooldown (HP = 0)
      if (isAnotherPlayerMining(g.x, g.y)) return false; // Jangan berebut (jika ada orang lain di dekatnya, abaikan sepenuhnya baik utuh/dicicil)
      if (!isResourceSafe(g.x * 64 + 32, g.y * 64 + 32, 120)) return false; // Kurangi radius aman ke 120px agar tidak menjauh saat monster jauh
      return !(state.failedResources.has(key) && now - state.failedResources.get(key) < 300000);
    });
    activeList = allGolds;
    if (Date.now() - (state._lastActiveListLog || 0) > 5000) {
      log('🐛', `DEBUG: gold intact=${allGolds.length} targeting=${activeList.length}`);
      state._lastActiveListLog = Date.now();
    }
  } else if (type === 'diamond') {
    activeList = (state.world.diamonds || []).filter(d => {
      const key = `diamond:${d.x},${d.y}`;
      if (d.pct !== undefined && d.pct === 0) return false; // Abaikan jika cooldown
      if (!isResourceSafe(d.x * 64 + 32, d.y * 64 + 32, 120)) return false; // Kurangi radius aman ke 120px untuk diamond juga
      if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) return false;
      return true;
    });
  }

  if (activeList.length > 0) {
    // Find the closest active resource
    let best = null;
    let bestDist = Infinity;
    for (const item of activeList) {
      const wx = item.x * 64 + 32;
      const wy = item.y * 64 + 32;
      const d = distTo(wx, wy);
      if (d < bestDist) {
        bestDist = d;
        best = { x: item.x, y: item.y, wx, wy, type };
      }
    }
    if (best) return best;
  }

  // 2. Fall back to static chunk list (gold, diamond)
  let staticList = [];
  if (type === 'gold') {
    staticList = chunks.golds.filter(item => {
      const key = `gold:${item.x},${item.y}`;
      if (!isResourceSafe(item.wx, item.wy, 120)) return false;
      return !(state.failedResources.has(key) && now - state.failedResources.get(key) < 300000);
    });
  } else if (type === 'diamond') {
    staticList = chunks.diamonds.filter(item => {
      const key = `diamond:${item.x},${item.y}`;
      if (!isResourceSafe(item.wx, item.wy, 120)) return false;
      return !(state.failedResources.has(key) && now - state.failedResources.get(key) < 300000);
    });
  }

  // Filter out any static resource that is within viewport range (since if it were active, it would have been in the activeList)
  const candidateList = staticList.filter(item => {
    const d = distTo(item.wx, item.wy);
    return d > VIEWPORT_RANGE;
  });

  if (candidateList.length > 0) {
    let best = null;
    let bestDist = Infinity;
    for (const item of candidateList) {
      const d = distTo(item.wx, item.wy);
      if (d < bestDist) {
        bestDist = d;
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

  if (state.lockResource && state.lockResource.type === 'tree') {
    const near = state.lockResource;
    const hit = state.world.treeHits.find(h => h.x === near.x && h.y === near.y);
    const hpPct = hit ? 1 - hit.pct : 1;
    
    // If the tree hit progress reaches 100% (hpPct <= 0), or isResourceDepleted returns true, release the lock instantly
    if (hpPct <= 0 || isResourceDepleted('tree', near.x, near.y, near.wx, near.wy)) {
      state.lockResource = null;
    } else if (!isResourceSafe(state.lockResource.wx, state.lockResource.wy)) {
      log('⚠️', 'Monster tiba-tiba muncul di dekat Pohon! Membatalkan dan kabur...');
      state.lockResource = null;
    }
  }

  if (!state.lockResource || state.lockResource.type !== 'tree') {
    state.lockResource = findBestResource('tree');
    if (!state.lockResource) {
      if (MODES.monster) {
        doMonster(false);
      } else {
        if (Math.random() < 0.1) wander(150);
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

  if (realign) {
    log('⚠️', `Attacks on ${key} not registering. Blacklisting and releasing lock.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    return;
  } else if (d > 45) {
    moveToward(near.wx, near.wy, 70, 35);
  } else {
    state.movingUntil = 0;
    faceTarget(near.wx);
    sendAttack(near.wx, near.wy);
  }
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
    if (isResourceDepleted('gold', state.lockResource.x, state.lockResource.y, state.lockResource.wx, state.lockResource.wy)) {
      log('ℹ️', `Gold at [${state.lockResource.x}, ${state.lockResource.y}] is depleted. Blacklisting.`);
      state.failedResources.set(`gold:${state.lockResource.x},${state.lockResource.y}`, Date.now());
      state.lockResource = null;
    } else if (!isResourceSafe(state.lockResource.wx, state.lockResource.wy, 120)) {
      log('⚠️', 'Monster tiba-tiba muncul di dekat Gold! Membatalkan dan kabur...');
      state.lockResource = null;
    }
  }

  if (!state.lockResource || state.lockResource.type !== 'gold') {
    state.lockResource = findBestResource('gold');
    if (!state.lockResource) {
      if (state.modeList.includes('tree')) {
        if (Date.now() - (state._lastNoGoldLog || 0) > 10000) {
          log('🔍', 'Tidak ada Gold yang aman/tersedia. Mencari area lain sambil menebang pohon...');
          state._lastNoGoldLog = Date.now();
        }
        doTree();
      } else {
        if (Date.now() - (state._lastNoGoldLog || 0) > 10000) {
          log('🔍', 'Tidak ada Gold yang aman/tersedia. Berkeliling mencari Gold...');
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
    const nodePct = stateNode ? stateNode.pct : 0;

    state.currentTarget = { type: 'Gold Node', hpPct: 1 - nodePct, wx: near.wx, wy: near.wy, _near: near };

  // Stand to the RIGHT of the gold node, matching manual player behavior:
  // From log: player at (+69px right, +7px below) node center, facing:-1, bd:"left"
  const standX = near.wx + 69;
  const standY = near.wy + 7;
  const dToStand = Math.hypot(standX - state.player.x, standY - state.player.y);

  if (!state._walkStartTime) state._walkStartTime = Date.now();
  if (Date.now() - state._walkStartTime > 20000 && dToStand > 5) {
    log('⚠️', `Cannot reach ${key} after 20s (stuck on obstacle?). Blacklisting.`);
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
  } else if (dToStand > 5) {
    if (Date.now() - (state._lastTargetLog || 0) > 2000) {
       log('🎯', `WALKING TO: Gold [${near.x},${near.y}] | stand=(${standX},${standY}) | dist=${Math.round(dToStand)}px | pct=${nodePct}`);
       state._lastTargetLog = Date.now();
    }
    moveToward(standX, standY, 70, 0);
  } else {
    state._walkStartTime = 0;
    state.movingUntil = 0;

    // Match manual player exactly: stand RIGHT of node, face LEFT, bd:"left"
    // From log: player at (+69px right, +7px below) node center, facing:-1, bd:"left"
    state.player.facing = -1;
    state.player.bd = 'left';

    // Rate limit attacks to overcome regeneration, with JITTER to bypass anti-cheat
    if (!state._currentAttackDelay) state._currentAttackDelay = ATK_INTERVAL + Math.random() * 200 - 100; // +/- 100ms jitter
    if (Date.now() - (state._lastAttackTime || 0) < state._currentAttackDelay) return;
    state._lastAttackTime = Date.now();
    state._currentAttackDelay = ATK_INTERVAL + Math.random() * 200 - 100; // Pick new delay for next attack

    // Log pct every 5 attacks
    if (state.attacksOnCurrentTarget % 5 === 0) {
      log('⛏️', `Gold [${near.x},${near.y}] pct=${nodePct} | atk#${state.attacksOnCurrentTarget} | player=(${Math.round(state.player.x)},${Math.round(state.player.y)}) | stand=(${standX},${standY})`);
    }

    // Gold nodes: pct counts down from ~1000 to 0, then gold drops.
    // A node takes ~140 hits at 7 dmg/hit to deplete from 1000.
    // If still no drop after 250 hits, declare ghost.
    if (state.attacksOnCurrentTarget > 250) {
      log('⚠️', `Node [${near.x},${near.y}] took 250 hits with no drop. Blacklisting.`);
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
    if (isResourceDepleted('diamond', state.lockResource.x, state.lockResource.y, state.lockResource.wx, state.lockResource.wy)) {
      log('ℹ️', `Diamond at [${state.lockResource.x}, ${state.lockResource.y}] is depleted. Blacklisting.`);
      state.failedResources.set(`diamond:${state.lockResource.x},${state.lockResource.y}`, Date.now());
      state.lockResource = null;
    }
  }

  if (!state.lockResource || state.lockResource.type !== 'diamond') {
    state.lockResource = findBestResource('diamond');
    if (!state.lockResource) {
      doMonster(false);
      return;
    }
  }

  const near = state.lockResource;
  const d = distTo(near.wx, near.wy);
  const key = `diamond:${near.x},${near.y}`;
  const realign = checkRealign(key, near);

  const stateNode = state.world.diamonds.find(sd => sd.x === near.x && sd.y === near.y);
  const hpPct = stateNode ? 1 - stateNode.pct : 1;

  state.currentTarget = { type: '💎 Diamond', hpPct, wx: near.wx, wy: near.wy, _near: near };

  if (realign) {
    log('⚠️', `Attacks on ${key} not registering. Blacklisting and releasing lock.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    return;
  } else if (d > 45) {
    moveToward(near.wx, near.wy, 60, 35);
  } else {
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
    // HP is percentage 0-100, check if alive
    return m.hp > 0 && m.hp <= 100;
  });
  let pool  = bossOnly
    ? alive.filter(m => m.boss === true && m.hpPct >= (cfg.settings?.bossMinHpPct ?? 1.0))
    : alive.filter(m => !m.boss && m.hpPct > 0);

  // Filter out crowded mobs to avoid getting swarmed
  pool = pool.filter(m => {
    if (state.lockMobId === m.id) return true;
    return !isMobCrowded(m, alive, 120);
  });

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
          state.failedMobs.set(cur.id, Date.now());
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
        state.failedMobs.set(near.id, Date.now());
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
    if (state.modeList.includes('tree')) {
      state.mode = 'tree';
      state.lockMobId = null;
      doTree();
    } else {
      if (Math.random() < 0.1) wander(150);
    }
  }
}

// ─────────────────────────────────────────────
// MODE CYCLING
// ─────────────────────────────────────────────
const MODE_TIMEOUT_MS = 60_000; // Switch mode after 60s if no loot
let modeEnteredAt = Date.now();

function advanceMode() {
  state.modeIdx   = (state.modeIdx + 1) % state.modeList.length;
  state.mode      = state.modeList[state.modeIdx];
  state.gotLoot   = false;
  state.lockMobId = null;
  state.lockResource = null;
  state.currentTarget = null;
  modeEnteredAt   = Date.now();
  log('🔄', `Mode → ${state.mode.toUpperCase()}`);
}

// ─────────────────────────────────────────────
// ATTACK TICK
// ─────────────────────────────────────────────
function attackTick() {
  if (!state.authed) return;

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

  // Add random tiny pauses (100ms - 500ms) to look natural and break robot-like constant execution
  if (state.waitTick && Date.now() < state.waitTick) return;
  if (Math.random() < 0.05 && !state.waitTick) {
    state.waitTick = Date.now() + Math.floor(100 + Math.random() * 400);
    return;
  }
  state.waitTick = null;
  checkHeal();
  checkEquip();

  // Load nearby chunks if needed
  const curCx = Math.max(0, Math.min(9, Math.floor(state.player.x / 3200)));
  const curCur = Math.max(0, Math.min(9, Math.floor(state.player.y / 3200)));
  if (!chunks.loaded.has(`${curCx},${curCur}`)) {
    ensureNearbyChunks();
  }

  // Time-based mode rotation: if stuck in one mode too long, force advance
  if (state.modeList.length > 1 && Date.now() - modeEnteredAt > MODE_TIMEOUT_MS) {
    const onlyTreeAndMonster = state.modeList.every(m => m === 'tree' || m === 'monster' || m === 'boss');
    if (!onlyTreeAndMonster) {
      log('⏰', `Mode timeout (60s) — rotating from ${state.mode.toUpperCase()}`);
      advanceMode();
    }
  }

  // Dynamic prioritization: if we want to farm monsters/bosses, check if one is close
  if (MODES.monster || MODES.boss) {
    const hasActiveMobLock = state.lockMobId && state.world.mobs.some(m => m.id === state.lockMobId && m.state !== 'dead' && m.hp > 0);
    const nearbyMob = getNearbyEligibleMob(350);
    if (hasActiveMobLock || nearbyMob) {
      const targetMode = MODES.boss ? 'boss' : 'monster';
      if (state.mode !== targetMode) {
        state.mode = targetMode;
        state.lockResource = null;
        modeEnteredAt = Date.now();
        log('🔄', `Dynamic Mode → ${state.mode.toUpperCase()} (Nearby Mob Detected)`);
      }
    } else if (MODES.tree && (state.mode === 'monster' || state.mode === 'boss')) {
      // No mobs nearby, switch to tree
      state.mode = 'tree';
      state.lockMobId = null;
      modeEnteredAt = Date.now();
      log('🔄', `Dynamic Mode → TREE (No Mobs Nearby)`);
    }
  } else if (MODES.tree) {
    // If we only focus on tree, or need a fallback when mobs are not around
    if (state.mode !== 'tree') {
      state.mode = 'tree';
      state.lockMobId = null;
      modeEnteredAt = Date.now();
    }
  }

  // Don't farm if we just moved — wait for server to sync position
  if (Date.now() < state.movingUntil) return;
  switch (state.mode) {
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
function startIntervals() {
  state._stateTimer = setInterval(sendState,    ST_INTERVAL);
  state._atkTimer   = setInterval(attackTick,   ATK_INTERVAL);
  state._dashTimer  = setInterval(() => renderDashboard(state), 300);
  log('▶️', `Bot running! Focus: ${modeStr()}`);
}

function stopIntervals() {
  clearInterval(state._stateTimer);
  clearInterval(state._atkTimer);
  clearInterval(state._dashTimer);
  clearInterval(state._pingTimer);
  state._stateTimer = state._atkTimer = state._dashTimer = state._pingTimer = null;
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
